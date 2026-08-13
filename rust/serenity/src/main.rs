use std::sync::{LazyLock, Mutex};

use rusqlite::{params, Connection};
use serenity::all::{
    async_trait, ActivityData, ChannelId, ChannelType, Client, CommandDataOptionValue,
    CommandOptionType, Context, CreateAllowedMentions, CreateCommand, CreateCommandOption,
    CreateInteractionResponse, CreateInteractionResponseMessage, CreateMessage, EventHandler,
    GatewayIntents, Guild, GuildChannel, GuildId, InstallationContext, Interaction,
    InteractionContext, Message, OnlineStatus, Permissions, Ready, UnavailableGuild,
};

struct Honeypot {
    channel_id: ChannelId,
    action: String,
    log_channel_id: Option<ChannelId>,
}

static DB: LazyLock<Mutex<Connection>> = LazyLock::new(|| {
    let conn = Connection::open(std::env::var("DB_PATH").unwrap_or_else(|_| "bot.db".to_string()))
        .expect("failed to open database");
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS honeypots (
            guild_id TEXT PRIMARY KEY,
            channel_id TEXT NOT NULL,
            action TEXT NOT NULL DEFAULT 'ban',
            log_channel_id TEXT
        )",
    )
    .expect("failed to create table");
    Mutex::new(conn)
});

fn upsert_honeypot(
    guild_id: GuildId,
    channel_id: ChannelId,
    action: &str,
    log_channel_id: Option<ChannelId>,
) {
    let conn = DB.lock().unwrap();
    conn.execute(
        "INSERT INTO honeypots (guild_id, channel_id, action, log_channel_id)
        VALUES (?1, ?2, ?3, ?4)
        ON CONFLICT(guild_id) DO UPDATE SET
            channel_id = excluded.channel_id,
            action = excluded.action,
            log_channel_id = excluded.log_channel_id",
        params![
            guild_id.to_string(),
            channel_id.to_string(),
            action,
            log_channel_id.map(|id| id.to_string()),
        ],
    )
    .unwrap();
}

fn get_honeypot(guild_id: GuildId) -> Option<Honeypot> {
    let conn = DB.lock().unwrap();
    let (channel_id, action, log_channel_id): (String, String, Option<String>) = conn
        .query_row(
            "SELECT channel_id, action, log_channel_id FROM honeypots WHERE guild_id = ?1",
            [guild_id.to_string()],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .ok()?;
    Some(Honeypot {
        channel_id: ChannelId::new(channel_id.parse().ok()?),
        action,
        log_channel_id: log_channel_id.and_then(|id| id.parse().ok().map(ChannelId::new)),
    })
}

fn delete_honeypot_by_channel(channel_id: ChannelId) {
    let conn = DB.lock().unwrap();
    conn.execute(
        "DELETE FROM honeypots WHERE channel_id = ?1",
        [channel_id.to_string()],
    )
    .unwrap();
}

fn delete_honeypot_by_guild(guild_id: GuildId) {
    let conn = DB.lock().unwrap();
    conn.execute(
        "DELETE FROM honeypots WHERE guild_id = ?1",
        [guild_id.to_string()],
    )
    .unwrap();
}

struct Handler;

#[async_trait]
impl EventHandler for Handler {
    async fn ready(&self, ctx: Context, ready: Ready) {
        let command = CreateCommand::new("honeypot-set")
            .description("Set/update honeypot channel (note: this overrides previous config set)")
            .default_member_permissions(Permissions::BAN_MEMBERS | Permissions::MANAGE_CHANNELS)
            .contexts(vec![InteractionContext::Guild])
            .integration_types(vec![InstallationContext::Guild])
            .add_option(
                CreateCommandOption::new(
                    CommandOptionType::Channel,
                    "channel",
                    "The channel to ban people that message in it",
                )
                .required(true)
                .channel_types(vec![ChannelType::Text]),
            )
            .add_option(
                CreateCommandOption::new(
                    CommandOptionType::String,
                    "action",
                    "The action to take when someone messages in the honeypot channel",
                )
                .required(true)
                .add_string_choice("Ban", "ban")
                .add_string_choice("Softban", "softban")
                .add_string_choice("Disabled", "disabled"),
            )
            .add_option(
                CreateCommandOption::new(
                    CommandOptionType::Channel,
                    "log_channel",
                    "The channel to log actions in (if ommited, then it won't log anywhere)",
                )
                .channel_types(vec![
                    ChannelType::Text,
                    ChannelType::PublicThread,
                    ChannelType::PrivateThread,
                ]),
            );

        println!("Logged in as {}", ready.user.tag());

        if let Err(err) = ctx.http.create_global_commands(&[command]).await {
            println!("Failed to register global commands: {err}");
        }
    }

    async fn interaction_create(&self, ctx: Context, interaction: Interaction) {
        let Interaction::Command(command) = interaction else {
            return;
        };
        if command.guild_id.is_none() {
            return;
        }

        if command.data.name != "honeypot-set" {
            let _ = command
                .create_response(
                    &ctx,
                    CreateInteractionResponse::Message(
                        CreateInteractionResponseMessage::new()
                            .content("Unknown command")
                            .ephemeral(true),
                    ),
                )
                .await;
            return;
        }

        let required = Permissions::BAN_MEMBERS | Permissions::MANAGE_CHANNELS;
        let member_permissions = command
            .member
            .as_ref()
            .and_then(|member| member.permissions);
        if !member_permissions.is_some_and(|permissions| permissions.contains(required)) {
            let _ = command
                .create_response(
                    &ctx,
                    CreateInteractionResponse::Message(
                        CreateInteractionResponseMessage::new()
                            .content("You don't have permission to use this command.")
                            .ephemeral(true),
                    ),
                )
                .await;
            return;
        }

        let guild_id = command.guild_id.unwrap();

        let mut channel = None;
        let mut action = None;
        let mut log_channel = None;
        for option in &command.data.options {
            match (option.name.as_str(), &option.value) {
                ("channel", CommandDataOptionValue::Channel(id)) => channel = Some(*id),
                ("action", CommandDataOptionValue::String(value)) => action = Some(value.clone()),
                ("log_channel", CommandDataOptionValue::Channel(id)) => log_channel = Some(*id),
                _ => {}
            }
        }

        let (Some(channel), Some(action)) = (channel, action) else {
            return;
        };

        if action == "disabled" {
            delete_honeypot_by_guild(guild_id);

            let _ = command
                .create_response(
                    &ctx,
                    CreateInteractionResponse::Message(
                        CreateInteractionResponseMessage::new().content(
                            "Honeypot configuration updated: Disabled honeypot for this server.",
                        ),
                    ),
                )
                .await;
            return;
        }

        upsert_honeypot(guild_id, channel, &action, log_channel);

        let content = match log_channel {
            Some(id) => format!(
                "Honeypot configuration updated: Will **{action}** anyone who types in <#{channel}> and log actions to <#{id}>"
            ),
            None => format!(
                "Honeypot configuration updated: Will **{action}** anyone who types in <#{channel}> and won't log actions."
            ),
        };

        let _ = command
            .create_response(
                &ctx,
                CreateInteractionResponse::Message(
                    CreateInteractionResponseMessage::new().content(content),
                ),
            )
            .await;
    }

    async fn message(&self, ctx: Context, new_message: Message) {
        let Some(guild_id) = new_message.guild_id else {
            return;
        };
        if new_message.author.bot {
            return;
        }

        let Some(honeypot) = get_honeypot(guild_id) else {
            return;
        };
        if honeypot.channel_id != new_message.channel_id {
            return;
        }

        let mut success = true;
        if honeypot.action == "ban" {
            // (serenity's ban API only supports days (0-7), and unban has no reason param, sadly)
            if let Err(err) = guild_id
                .ban_with_reason(
                    &ctx,
                    new_message.author.id,
                    1,
                    "User typed in #honeypot channel -> ban",
                )
                .await
            {
                success = false;
                println!("Failed honeypot action ({}): {err}", honeypot.action);
            }
        } else if honeypot.action == "softban" {
            if let Err(err) = guild_id
                .ban_with_reason(
                    &ctx,
                    new_message.author.id,
                    1,
                    "User typed in #honeypot channel -> softban (1/2)",
                )
                .await
            {
                success = false;
                println!("Failed honeypot action ({}): {err}", honeypot.action);
            } else if let Err(err) = guild_id.unban(&ctx, new_message.author.id).await {
                success = false;
                println!("Failed honeypot action ({}): {err}", honeypot.action);
            }
        } else {
            success = false;
            println!(
                "Failed honeypot action ({}): Unknown honeypot action: {}",
                honeypot.action, honeypot.action
            );
        }

        let target_channel_id = if success {
            honeypot.log_channel_id
        } else {
            honeypot.log_channel_id.or(Some(new_message.channel_id))
        };
        let Some(target_channel_id) = target_channel_id else {
            return;
        };

        let content = if success {
            format!(
                "User <@{}> was {} for triggering the honeypot in <#{}>",
                new_message.author.id, honeypot.action, new_message.channel_id
            )
        } else {
            format!(
                "User <@{}> triggered the honeypot but I **failed** to {} them, please check my permissions to ensure I can {} them.",
                new_message.author.id, honeypot.action, honeypot.action
            )
        };

        if let Err(err) = target_channel_id
            .send_message(
                &ctx,
                CreateMessage::new()
                    .content(content)
                    .allowed_mentions(CreateAllowedMentions::new()),
            )
            .await
        {
            println!("Failed to send honeypot log message: {err}");
        }
    }

    async fn channel_delete(
        &self,
        _ctx: Context,
        channel: GuildChannel,
        _messages: Option<Vec<Message>>,
    ) {
        delete_honeypot_by_channel(channel.id);
    }

    async fn guild_delete(
        &self,
        _ctx: Context,
        incomplete: UnavailableGuild,
        _full: Option<Guild>,
    ) {
        delete_honeypot_by_guild(incomplete.id);
    }
}

#[tokio::main]
async fn main() {
    let token = match std::env::var("DISCORD_TOKEN") {
        Ok(token) => token,
        Err(_) => panic!("DISCORD_TOKEN is required"),
    };

    LazyLock::force(&DB);

    let intents = GatewayIntents::GUILDS | GatewayIntents::GUILD_MESSAGES;

    let mut client = Client::builder(token, intents)
        .activity(ActivityData::custom("Watching #honeypot for bots"))
        .status(OnlineStatus::Online)
        .event_handler(Handler)
        .await
        .expect("failed to create client");

    if let Err(err) = client.start().await {
        println!("Client error: {err}");
    }
}
