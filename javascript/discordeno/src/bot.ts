import { DatabaseSync } from "node:sqlite";
import {
  ActivityTypes,
  ApplicationCommandOptionTypes,
  ChannelTypes,
  commandOptionsParser,
  createBot,
  DiscordApplicationIntegrationType,
  DiscordInteractionContextType,
  GatewayIntents,
  InteractionTypes,
  type InteractionResolvedChannel,
} from "discordeno";

const token = process.env.DISCORD_TOKEN;
if (!token) throw new Error("DISCORD_TOKEN is required");

const db = new DatabaseSync(process.env.DB_PATH ?? "bot.db");
const sql = db.createTagStore();

process.on('uncaughtException', (err) => {
  console.error(`Unhandled Exception: ${err}`);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error(`Unhandled Rejection at: ${promise}, reason: ${reason}`);
});

const bot = createBot({
  token,
  // Guilds + guild messages are the only intents the honeypot needs.
  intents: GatewayIntents.Guilds | GatewayIntents.GuildMessages,
  desiredProperties: {
    interaction: {
      id: true,
      token: true,
      type: true,
      data: true,
      guildId: true,
      member: true,
    },
    member: {
      permissions: true,
    },
    message: {
      author: true,
      channelId: true,
      guildId: true,
    },
    user: {
      id: true,
      toggles: true,
      username: true,
      discriminator: true,
    },
    channel: {
      id: true,
    },
  },
});

// Guild honeypot config is stored in SQLite so it survives restarts.
sql.run`
  CREATE TABLE IF NOT EXISTS honeypots (
    guild_id TEXT PRIMARY KEY,
    channel_id TEXT NOT NULL,
    action TEXT NOT NULL DEFAULT 'ban',
    log_channel_id TEXT
  )
`;

bot.events.ready = async (payload) => {
  console.log(`Logged in as ${payload.user.username}#${payload.user.discriminator}`);

  // Register slash commands once on startup.
  await bot.helpers.upsertGlobalApplicationCommands([
    {
      name: "honeypot-set",
      description: "Set/update honeypot channel (note: this overrides previous config set)",
      defaultMemberPermissions: ["BAN_MEMBERS", "MANAGE_CHANNELS"],
      contexts: [DiscordInteractionContextType.Guild],
      integrationTypes: [DiscordApplicationIntegrationType.GuildInstall],
      options: [
        {
          name: "channel",
          description: "The channel to ban people that message in it",
          type: ApplicationCommandOptionTypes.Channel,
          required: true,
          channelTypes: [ChannelTypes.GuildText],
        },
        {
          name: "action",
          description: "The action to take when someone messages in the honeypot channel",
          type: ApplicationCommandOptionTypes.String,
          required: true,
          choices: [
            { name: "Ban", value: "ban" },
            { name: "Softban", value: "softban" },
            { name: "Disabled", value: "disabled" },
          ],
        },
        {
          name: "log_channel",
          description: "The channel to log actions in (if ommited, then it won't log anywhere)",
          type: ApplicationCommandOptionTypes.Channel,
          required: false,
          channelTypes: [ChannelTypes.GuildText, ChannelTypes.PublicThread, ChannelTypes.PrivateThread],
        },
      ],
    },
  ]);

  await bot.gateway.editShardStatus(payload.shardId, {
    status: "online",
    activities: [
      {
        name: "#honeypot",
        type: ActivityTypes.Custom,
        state: "Watching #honeypot for bots",
      },
    ],
  });
};

// Handle the /honeypot-set command.
bot.events.interactionCreate = async (interaction) => {
  if (interaction.type !== InteractionTypes.ApplicationCommand || !interaction.guildId) return;
  if (interaction.data?.name === "honeypot-set") {
    if (!interaction.member?.permissions?.hasAll(["BAN_MEMBERS", "MANAGE_CHANNELS"])) {
      await interaction.respond("You don't have permission to use this command.", { isPrivate: true });
      return;
    }

    const args = commandOptionsParser(interaction) as {
      channel: InteractionResolvedChannel;
      action: "ban" | "softban" | "disabled";
      log_channel?: InteractionResolvedChannel;
    };
    const { channel, action } = args;
    const logChannel = args.log_channel;

    if (action === "disabled") {
      // "disabled" removes the config instead of updating it.
      sql.run`DELETE FROM honeypots WHERE guild_id = ${interaction.guildId}`;

      await interaction.respond("Honeypot configuration updated: Disabled honeypot for this server.");
      return;
    }

    sql.run`
      INSERT INTO honeypots (guild_id, channel_id, action, log_channel_id)
      VALUES (${interaction.guildId}, ${channel.id}, ${action}, ${logChannel?.id ?? null})
      ON CONFLICT(guild_id) DO UPDATE SET
        channel_id = excluded.channel_id,
        action = excluded.action,
        log_channel_id = excluded.log_channel_id
    `;

    await interaction.respond(
      `Honeypot configuration updated: Will **${action}** anyone who types in <#${channel.id}> ${logChannel ? `and log actions to <#${logChannel.id}>` : "and won't log actions"}.`
    );
  } else {
    await interaction.respond({ content: "Unknown command" }, { isPrivate: true });
  }
};

// Ban anyone who messages in the configured honeypot channel.
bot.events.messageCreate = async (message) => {
  if (!message.guildId || message.author.bot) return;

  const honeypot = sql.get`SELECT * FROM honeypots WHERE guild_id = ${message.guildId}` as {
    channel_id: string;
    action: "ban" | "softban";
    log_channel_id: string | null;
  } | undefined;

  if (!honeypot || honeypot.channel_id !== String(message.channelId)) return;

  let success = true;
  try {
    if (honeypot.action === "ban") {
      await bot.helpers.banMember(message.guildId, message.author.id, {
        deleteMessageSeconds: 3600, // 1hr
      }, "User typed in #honeypot channel -> ban");
    } else if (honeypot.action === "softban") {
      await bot.helpers.banMember(message.guildId, message.author.id, {
        deleteMessageSeconds: 3600, // 1hr
      }, "User typed in #honeypot channel -> softban (1/2)");
      await bot.helpers.unbanMember(
        message.guildId,
        message.author.id,
        "User typed in #honeypot channel -> softban (2/2)"
      );
    } else {
      throw new Error(`Unknown honeypot action: ${honeypot.action}`);
    }
  } catch (error) {
    success = false;
    console.error(`Failed honeypot action (${honeypot.action}): ${error}`);
  }

  // On failure, log to the honeypot channel itself so moderators still see it.
  const targetChannelId = success
    ? honeypot.log_channel_id
    : honeypot.log_channel_id ?? String(message.channelId);
  if (!targetChannelId) return;

  // Send the log message directly — no need to fetch the target channel first.
  try {
    await bot.helpers.sendMessage(targetChannelId, {
      content: success
        ? `User <@${message.author.id}> was ${honeypot.action} for triggering the honeypot in <#${message.channelId}>`
        : `User <@${message.author.id}> triggered the honeypot but I **failed** to ${honeypot.action} them, please check my permissions to ensure I can ${honeypot.action} them.`,
      allowedMentions: {},
    });
  } catch (error) {
    console.error(`Failed to send honeypot log message: ${error}`);
  }
};

// Clean up config when a channel or guild goes away.
bot.events.channelDelete = (channel) => {
  sql.run`DELETE FROM honeypots WHERE channel_id = ${channel.id}`;
};

bot.events.guildDelete = (id) => {
  sql.run`DELETE FROM honeypots WHERE guild_id = ${id}`;
};

await bot.start();
