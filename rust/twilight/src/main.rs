use std::{env, sync::Mutex};

use rusqlite::{params, Connection, OptionalExtension};
use twilight_gateway::{Event, EventTypeFlags, Intents, Shard, ShardId, StreamExt as _};
use twilight_http::{request::AuditLogReason, Client};
use twilight_model::{
    application::{
        command::{Command, CommandType},
        interaction::{
            application_command::{CommandDataOption, CommandOptionValue},
            Interaction, InteractionContextType, InteractionData, InteractionType,
        },
    },
    channel::{
        message::{AllowedMentions, MessageFlags},
        ChannelType,
    },
    gateway::payload::incoming::{
        ChannelDelete, GuildDelete, InteractionCreate, MessageCreate,
    },
    guild::Permissions,
    http::interaction::{InteractionResponse, InteractionResponseType},
    id::{
        Id,
        marker::{ChannelMarker, GuildMarker},
    },
    oauth::ApplicationIntegrationType,
};
use twilight_util::builder::{
    command::{ChannelBuilder, CommandBuilder, StringBuilder},
    InteractionResponseDataBuilder,
};

struct HoneypotConfig {
    channel_id: Id<ChannelMarker>,
    action: String,
    log_channel_id: Option<Id<ChannelMarker>>,
}

fn honeypot_command() -> Command {
    CommandBuilder::new(
        "honeypot-set",
        "Set/update honeypot channel (note: this overrides previous config set)",
        CommandType::ChatInput,
    )
    .default_member_permissions(Permissions::BAN_MEMBERS | Permissions::MANAGE_CHANNELS)
    .contexts([InteractionContextType::Guild])
    .integration_types([ApplicationIntegrationType::GuildInstall])
    .option(
        ChannelBuilder::new("channel", "The channel to ban people that message in it")
            .required(true)
            .channel_types([ChannelType::GuildText]),
    )
    .option(
        StringBuilder::new(
            "action",
            "The action to take when someone messages in the honeypot channel",
        )
        .required(true)
        .choices([
            ("Ban", "ban"),
            ("Softban", "softban"),
            ("Disabled", "disabled"),
        ]),
    )
    .option(
        ChannelBuilder::new(
            "log_channel",
            "The channel to log actions in (if ommited, then it won't log anywhere)",
        )
        .channel_types([
            ChannelType::GuildText,
            ChannelType::PublicThread,
            ChannelType::PrivateThread,
        ]),
    )
    .build()
}

fn get_honeypot(
    conn: &Connection,
    guild_id: Id<GuildMarker>,
) -> rusqlite::Result<Option<HoneypotConfig>> {
    conn.query_row(
        "SELECT channel_id, action, log_channel_id FROM honeypots WHERE guild_id = ?1",
        params![guild_id.to_string()],
        |row| {
            let channel_id: String = row.get(0)?;
            let action: String = row.get(1)?;
            let log_channel_id: Option<String> = row.get(2)?;

            Ok(HoneypotConfig {
                channel_id: channel_id.parse().expect("stored channel id is valid"),
                action,
                log_channel_id: log_channel_id
                    .map(|id| id.parse().expect("stored channel id is valid")),
            })
        },
    )
    .optional()
}

fn option_value<'a>(
    options: &'a [CommandDataOption],
    name: &str,
) -> Option<&'a CommandOptionValue> {
    options
        .iter()
        .find(|option| option.name == name)
        .map(|option| &option.value)
}

async fn respond(http: &Client, interaction: &Interaction, content: &str, ephemeral: bool) {
    let data = InteractionResponseDataBuilder::new().content(content);
    let data = if ephemeral {
        data.flags(MessageFlags::EPHEMERAL)
    } else {
        data
    };
    let response = InteractionResponse {
        kind: InteractionResponseType::ChannelMessageWithSource,
        data: Some(data.build()),
    };

    if let Err(error) = http
        .interaction(interaction.application_id)
        .create_response(interaction.id, &interaction.token, &response)
        .await
    {
        eprintln!("Failed to respond to interaction: {error}");
    }
}

async fn handle_interaction(http: &Client, db: &Mutex<Connection>, interaction: InteractionCreate) {
    let interaction = interaction.0;

    if interaction.kind != InteractionType::ApplicationCommand {
        return;
    }
    let Some(guild_id) = interaction.guild_id else {
        return;
    };
    let Some(InteractionData::ApplicationCommand(data)) = &interaction.data else {
        return;
    };

    if data.name != "honeypot-set" {
        respond(http, &interaction, "Unknown command", true).await;
        return;
    }

    let Some(permissions) = interaction.member.as_ref().and_then(|member| member.permissions)
    else {
        return;
    };

    if !permissions.contains(Permissions::BAN_MEMBERS | Permissions::MANAGE_CHANNELS) {
        respond(
            http,
            &interaction,
            "You don't have permission to use this command.",
            true,
        )
        .await;
        return;
    }

    let channel = match option_value(&data.options, "channel") {
        Some(CommandOptionValue::Channel(id)) => *id,
        _ => return,
    };
    let action = match option_value(&data.options, "action") {
        Some(CommandOptionValue::String(value)) => value.clone(),
        _ => return,
    };
    let log_channel = match option_value(&data.options, "log_channel") {
        Some(CommandOptionValue::Channel(id)) => Some(*id),
        _ => None,
    };

    if action == "disabled" {
        {
            let conn = db.lock().unwrap();
            if let Err(error) = conn.execute(
                "DELETE FROM honeypots WHERE guild_id = ?1",
                params![guild_id.to_string()],
            ) {
                eprintln!("Failed to disable honeypot config: {error}");
            }
        }

        respond(
            http,
            &interaction,
            "Honeypot configuration updated: Disabled honeypot for this server.",
            false,
        )
        .await;
        return;
    }

    {
        let conn = db.lock().unwrap();
        if let Err(error) = conn.execute(
            "INSERT INTO honeypots (guild_id, channel_id, action, log_channel_id)
             VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(guild_id) DO UPDATE SET
               channel_id = excluded.channel_id,
               action = excluded.action,
               log_channel_id = excluded.log_channel_id",
            params![
                guild_id.to_string(),
                channel.to_string(),
                action,
                log_channel.map(|id| id.to_string()),
            ],
        ) {
            eprintln!("Failed to update honeypot config: {error}");
        }
    }

    let log_channel_part = match log_channel {
        Some(id) => format!("and log actions to <#{id}>"),
        None => "and won't log actions".to_owned(),
    };
    respond(
        http,
        &interaction,
        &format!(
            "Honeypot configuration updated: Will **{action}** anyone who types in <#{channel}> {log_channel_part}."
        ),
        false,
    )
    .await;
}

async fn handle_message(http: &Client, db: &Mutex<Connection>, message: MessageCreate) {
    let message = message.0;
    let Some(guild_id) = message.guild_id else {
        return;
    };
    if message.author.bot {
        return;
    }

    let config = {
        let conn = db.lock().unwrap();
        match get_honeypot(&conn, guild_id) {
            Ok(config) => config,
            Err(error) => {
                eprintln!("Failed to look up honeypot config: {error}");
                return;
            }
        }
    };
    let Some(config) = config else {
        return;
    };
    if config.channel_id != message.channel_id {
        return;
    }

    let action = config.action.clone();

    let mut success = true;
    match action.as_str() {
        "ban" => {
            if let Err(error) = http
                .create_ban(guild_id, message.author.id)
                .delete_message_seconds(3600)
                .reason("User typed in #honeypot channel -> ban")
                .await
            {
                success = false;
                eprintln!("Failed honeypot action ({action}): {error}");
            }
        }
        "softban" => {
            let result = http
                .create_ban(guild_id, message.author.id)
                .delete_message_seconds(3600)
                .reason("User typed in #honeypot channel -> softban (1/2)")
                .await;
            let result = match result {
                Ok(_) => http
                    .delete_ban(guild_id, message.author.id)
                    .reason("User typed in #honeypot channel -> softban (2/2)")
                    .await,
                Err(error) => Err(error),
            };
            if let Err(error) = result {
                success = false;
                eprintln!("Failed honeypot action ({action}): {error}");
            }
        }
        _other => {
            success = false;
            eprintln!("Failed honeypot action ({action}): Unknown honeypot action: {action}");
        }
    }

    let target_channel_id = if success {
        config.log_channel_id
    } else {
        config.log_channel_id.or(Some(message.channel_id))
    };
    let Some(target_channel_id) = target_channel_id else {
        return;
    };

    let content = if success {
        format!(
            "User <@{}> was {} for triggering the honeypot in <#{}>",
            message.author.id, action, message.channel_id
        )
    } else {
        format!(
            "User <@{}> triggered the honeypot but I **failed** to {} them, please check my permissions to ensure I can {} them.",
            message.author.id, action, action
        )
    };

    let allowed_mentions = AllowedMentions::default();
    if let Err(error) = http
        .create_message(target_channel_id)
        .content(&content)
        .allowed_mentions(Some(&allowed_mentions))
        .await
    {
        eprintln!("Failed to send honeypot log message: {error}");
    }
}

fn delete_channel_config(db: &Mutex<Connection>, channel: &ChannelDelete) {
    let conn = db.lock().unwrap();
    if let Err(error) = conn.execute(
        "DELETE FROM honeypots WHERE channel_id = ?1",
        params![channel.id.to_string()],
    ) {
        eprintln!("Failed to delete honeypot config for channel: {error}");
    }
}

fn delete_guild_config(db: &Mutex<Connection>, guild: &GuildDelete) {
    let conn = db.lock().unwrap();
    if let Err(error) = conn.execute(
        "DELETE FROM honeypots WHERE guild_id = ?1",
        params![guild.id.to_string()],
    ) {
        eprintln!("Failed to delete honeypot config for guild: {error}");
    }
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let token = match env::var("DISCORD_TOKEN") {
        Ok(token) => token,
        Err(_) => panic!("DISCORD_TOKEN is required"),
    };

    let connection = Connection::open(env::var("DB_PATH").unwrap_or_else(|_| "bot.db".to_owned()))?;
    connection.execute_batch(
        "CREATE TABLE IF NOT EXISTS honeypots (
            guild_id TEXT PRIMARY KEY,
            channel_id TEXT NOT NULL,
            action TEXT NOT NULL DEFAULT 'ban',
            log_channel_id TEXT
        )",
    )?;
    let db = Mutex::new(connection);

    let http = Client::new(token.clone());

    let intents = Intents::GUILDS | Intents::GUILD_MESSAGES;
    let mut shard = Shard::new(ShardId::ONE, token, intents);

    while let Some(item) = shard.next_event(EventTypeFlags::all()).await {
        let event = match item {
            Ok(event) => event,
            Err(error) => {
                eprintln!("Error receiving event: {error}");
                continue;
            }
        };

        match event {
            Event::Ready(ready) => {
                let command = honeypot_command();
                println!("Logged in as {}#{}", ready.user.name, ready.user.discriminator);
                if let Err(error) = http
                    .interaction(ready.application.id)
                    .set_global_commands(&[command])
                    .await
                {
                    eprintln!("Failed to register global commands: {error}");
                }
            }
            Event::InteractionCreate(interaction) => {
                handle_interaction(&http, &db, *interaction).await;
            }
            Event::MessageCreate(message) => {
                handle_message(&http, &db, *message).await;
            }
            Event::ChannelDelete(channel) => {
                delete_channel_config(&db, &channel);
            }
            Event::GuildDelete(guild) => {
                delete_guild_config(&db, &guild);
            }
            _ => {}
        }
    }

    Ok(())
}
