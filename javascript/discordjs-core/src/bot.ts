import { DatabaseSync } from "node:sqlite";
import {
  ActivityType,
  ApplicationCommandOptionType,
  ApplicationCommandType,
  ApplicationIntegrationType,
  ChannelType,
  Client,
  GatewayDispatchEvents,
  GatewayIntentBits,
  InteractionContextType,
  InteractionType,
  MessageFlags,
  PermissionFlagsBits,
  PresenceUpdateStatus,
  type APIChatInputApplicationCommandInteractionData,
} from "@discordjs/core";
import { REST } from "@discordjs/rest";
import { WebSocketManager } from "@discordjs/ws";

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

const rest = new REST({ version: "10" }).setToken(token);
const gateway = new WebSocketManager({
  token,
  // Guilds + guild messages are the only intents the honeypot needs.
  intents: GatewayIntentBits.Guilds | GatewayIntentBits.GuildMessages,
  rest,
  initialPresence: {
    status: PresenceUpdateStatus.Online,
    since: null,
    afk: false,
    activities: [{
      name: "#honeypot",
      state: "Watching #honeypot for bots",
      type: ActivityType.Custom,
    }],
  },
});
const client = new Client({ rest, gateway });

// Guild honeypot config is stored in SQLite so it survives restarts.
sql.run`
  CREATE TABLE IF NOT EXISTS honeypots (
    guild_id TEXT PRIMARY KEY,
    channel_id TEXT NOT NULL,
    action TEXT NOT NULL DEFAULT 'ban',
    log_channel_id TEXT
  )
`;

client.once(GatewayDispatchEvents.Ready, async ({ data, api }) => {
  console.log(`Logged in as ${data.user.username}#${data.user.discriminator}`);

  // Register slash commands once on startup.
  await api.applicationCommands.bulkOverwriteGlobalCommands(data.user.id, [
    {
      name: "honeypot-set",
      description: "Set/update honeypot channel (note: this overrides previous config set)",
      default_member_permissions: String(PermissionFlagsBits.BanMembers | PermissionFlagsBits.ManageChannels),
      contexts: [InteractionContextType.Guild],
      integration_types: [ApplicationIntegrationType.GuildInstall],
      options: [
        {
          type: ApplicationCommandOptionType.Channel,
          name: "channel",
          description: "The channel to ban people that message in it",
          required: true,
          channel_types: [ChannelType.GuildText],
        },
        {
          type: ApplicationCommandOptionType.String,
          name: "action",
          description: "The action to take when someone messages in the honeypot channel",
          required: true,
          choices: [
            { name: "Ban", value: "ban" },
            { name: "Softban", value: "softban" },
            { name: "Disabled", value: "disabled" },
          ],
        },
        {
          type: ApplicationCommandOptionType.Channel,
          name: "log_channel",
          description: "The channel to log actions in (if ommited, then it won't log anywhere)",
          required: false,
          channel_types: [ChannelType.GuildText, ChannelType.PublicThread, ChannelType.PrivateThread],
        },
      ],
    },
  ]);
});

function getOptionValue<R extends boolean | undefined>
  (data: APIChatInputApplicationCommandInteractionData, name: string, required: R = false as R)
  : R extends true ? string : string | undefined {
  const option = data.options?.find((o) => o.name === name);
  if (!option) {
    if (required) throw new Error(`Missing required option: ${name}`);
    return undefined as any;
  }
  return "value" in option ? String(option.value) : undefined as any;
}

function hasPermission(memberPermissions: string | undefined, required: bigint): boolean {
  return (BigInt(memberPermissions ?? 0) & required) === required;
}

// Handle the /honeypot-set command.
client.on(GatewayDispatchEvents.InteractionCreate, async ({ data: interaction, api }) => {
  if (interaction.type !== InteractionType.ApplicationCommand || !interaction.guild_id) return;
  if (interaction.data.type !== ApplicationCommandType.ChatInput) return;

  if (interaction.data.name === "honeypot-set") {
    const required = PermissionFlagsBits.BanMembers | PermissionFlagsBits.ManageChannels;
    if (!hasPermission(interaction.member?.permissions, required)) {
      await api.interactions.reply(interaction.id, interaction.token, {
        content: "You don't have permission to use this command.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const channelId = getOptionValue(interaction.data, "channel", true);
    const action = getOptionValue(interaction.data, "action", true);
    const logChannelId = getOptionValue(interaction.data, "log_channel");

    if (action === "disabled") {
      // "disabled" removes the config instead of updating it.
      sql.run`DELETE FROM honeypots WHERE guild_id = ${interaction.guild_id}`;

      await api.interactions.reply(interaction.id, interaction.token, {
        content: "Honeypot configuration updated: Disabled honeypot for this server.",
      });
      return;
    }

    sql.run`
      INSERT INTO honeypots (guild_id, channel_id, action, log_channel_id)
      VALUES (${interaction.guild_id}, ${channelId}, ${action}, ${logChannelId ?? null})
      ON CONFLICT(guild_id) DO UPDATE SET
        channel_id = excluded.channel_id,
        action = excluded.action,
        log_channel_id = excluded.log_channel_id
    `;

    await api.interactions.reply(interaction.id, interaction.token, {
      content: `Honeypot configuration updated: Will **${action}** anyone who types in <#${channelId}> ${logChannelId ? `and log actions to <#${logChannelId}>` : "and won't log actions"}.`,
    });
  } else {
    await api.interactions.reply(interaction.id, interaction.token, {
      content: "Unknown command",
      flags: MessageFlags.Ephemeral,
    });
  }
});

interface Honeypot {
  channel_id: string;
  action: "ban" | "softban";
  log_channel_id: string | null;
}

// Ban anyone who messages in the configured honeypot channel.
client.on(GatewayDispatchEvents.MessageCreate, async ({ data: message, api }) => {
  if (!message.guild_id || message.author.bot) return;

  const honeypot = sql.get`SELECT * FROM honeypots WHERE guild_id = ${message.guild_id}` as Honeypot | undefined;

  if (!honeypot || honeypot.channel_id !== message.channel_id) return;

  let success = true;
  try {
    if (honeypot.action === "ban") {
      await api.guilds.banUser(message.guild_id, message.author.id, {
        delete_message_seconds: 3600, // 1hr
      }, {
        reason: "User typed in #honeypot channel -> ban",
      });
    } else if (honeypot.action === "softban") {
      await api.guilds.banUser(message.guild_id, message.author.id, {
        delete_message_seconds: 3600, // 1hr
      }, {
        reason: "User typed in #honeypot channel -> softban (1/2)",
      });
      await api.guilds.unbanUser(message.guild_id, message.author.id, {
        reason: "User typed in #honeypot channel -> softban (2/2)",
      });
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
    : honeypot.log_channel_id ?? message.channel_id;
  if (!targetChannelId) return;

  // Send the log message directly — no need to fetch the target channel first.
  try {
    await api.channels.createMessage(targetChannelId, {
      content: success
        ? `User <@${message.author.id}> was ${honeypot.action} for triggering the honeypot in <#${message.channel_id}>`
        : `User <@${message.author.id}> triggered the honeypot but I **failed** to ${honeypot.action} them, please check my permissions to ensure I can ${honeypot.action} them.`,
      allowed_mentions: {},
    });
  } catch (error) {
    console.error(`Failed to send honeypot log message: ${error}`);
  }
});

// Clean up config when a channel or guild goes away.
client.on(GatewayDispatchEvents.ChannelDelete, ({ data }) => {
  sql.run`DELETE FROM honeypots WHERE channel_id = ${data.id}`;
});
client.on(GatewayDispatchEvents.GuildDelete, ({ data }) => {
  sql.run`DELETE FROM honeypots WHERE guild_id = ${data.id}`;
});

gateway.connect();
