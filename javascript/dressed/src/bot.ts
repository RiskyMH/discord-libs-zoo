import { DatabaseSync } from "node:sqlite";
import { createConnection } from "@dressed/ws";
import {
  ActivityType,
  ApplicationCommandType,
  ApplicationIntegrationType,
  InteractionContextType,
  InteractionType,
  PermissionFlagsBits,
  PresenceUpdateStatus,
  type APIInteractionDataResolvedChannel,
} from "discord-api-types/v10";
import {
  bulkOverwriteAppCommands,
  CommandOption,
  createBan,
  createMessage,
  deleteBan,
} from "dressed";
import { createInteraction } from "dressed/server";
import { botEnv } from "dressed/utils";

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

// Guilds + guild messages are the only intents the honeypot needs.
const connection = createConnection({
  intents: ["Guilds", "GuildMessages"],
  token,
  presence: {
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
botEnv.DISCORD_APP_ID = atob(token.split(".")[0]!);

// Guild honeypot config is stored in SQLite so it survives restarts.
sql.run`
  CREATE TABLE IF NOT EXISTS honeypots (
    guild_id TEXT PRIMARY KEY,
    channel_id TEXT NOT NULL,
    action TEXT NOT NULL DEFAULT 'ban',
    log_channel_id TEXT
  )
`;

connection.onReady(async data => {
  console.log(`Logged in as ${data.user.username}#${data.user.discriminator}`);

  // Register slash commands once on startup.
  await bulkOverwriteAppCommands([
    {
      name: "honeypot-set",
      description: "Set/update honeypot channel (note: this overrides previous config set)",
      default_member_permissions: (PermissionFlagsBits.BanMembers | PermissionFlagsBits.ManageChannels).toString(),
      contexts: [InteractionContextType.Guild],
      integration_types: [ApplicationIntegrationType.GuildInstall],
      options: [
        CommandOption({
          type: "Channel",
          name: "channel",
          description: "The channel to ban people that message in it",
          required: true,
          channel_types: ["GuildText"],
        }),
        CommandOption({
          type: "String",
          name: "action",
          description: "The action to take when someone messages in the honeypot channel",
          required: true,
          choices: [
            { name: "Ban", value: "ban" },
            { name: "Softban", value: "softban" },
            { name: "Disabled", value: "disabled" },
          ],
        }),
        CommandOption({
          type: "Channel",
          name: "log_channel",
          description: "The channel to log actions in (if ommited, then it won't log anywhere)",
          required: false,
          channel_types: ["GuildText", "PublicThread", "PrivateThread"],
        }),
      ],
    },
  ]);
}, { once: true });

function hasPermission(memberPermissions: string | undefined, required: bigint): boolean {
  return (BigInt(memberPermissions ?? 0) & required) === required;
}

// Handle the /honeypot-set command.
connection.onInteractionCreate(async interaction => {
  if (interaction.type !== InteractionType.ApplicationCommand) return;
  if (interaction.data.type !== ApplicationCommandType.ChatInput) return;
  if (!interaction.guild_id) return;

  const cmd = createInteraction(interaction);

  if (interaction.data.name === "honeypot-set") {
    if (!hasPermission(interaction.member?.permissions, PermissionFlagsBits.BanMembers | PermissionFlagsBits.ManageChannels)) {
      await cmd.reply({ content: "You don't have permission to use this command.", ephemeral: true });
      return;
    }

    const channel = cmd.options.channel as APIInteractionDataResolvedChannel;
    const action = cmd.options.action as string;
    const logChannel = cmd.options.log_channel as APIInteractionDataResolvedChannel | undefined;

    if (action === "disabled") {
      // "disabled" removes the config instead of updating it.
      sql.run`DELETE FROM honeypots WHERE guild_id = ${interaction.guild_id}`;

      await cmd.reply("Honeypot configuration updated: Disabled honeypot for this server.");
      return;
    }

    sql.run`
      INSERT INTO honeypots (guild_id, channel_id, action, log_channel_id)
      VALUES (${interaction.guild_id}, ${channel.id}, ${action}, ${logChannel?.id ?? null})
      ON CONFLICT(guild_id) DO UPDATE SET
        channel_id = excluded.channel_id,
        action = excluded.action,
        log_channel_id = excluded.log_channel_id
    `;

    await cmd.reply(
      `Honeypot configuration updated: Will **${action}** anyone who types in <#${channel.id}> ${logChannel ? `and log actions to <#${logChannel.id}>` : "and won't log actions"}.`
    );
  } else {
    await cmd.reply({ content: "Unknown command", ephemeral: true });
  }
});

// Ban anyone who messages in the configured honeypot channel.
connection.onMessageCreate(async message => {
  if (!message.guild_id || message.author.bot) return;

  const honeypot = sql.get`SELECT * FROM honeypots WHERE guild_id = ${message.guild_id}` as {
    channel_id: string;
    action: "ban" | "softban";
    log_channel_id: string | null;
  } | undefined;

  if (!honeypot || honeypot.channel_id !== message.channel_id) return;

  let success = true;
  try {
    // (dressed's createBan/deleteBan have no audit-log reason parameter, sadly)
    if (honeypot.action === "ban") {
      await createBan(message.guild_id, message.author.id, { delete_message_seconds: 3600 }); // 1hr
    } else if (honeypot.action === "softban") {
      await createBan(message.guild_id, message.author.id, { delete_message_seconds: 3600 }); // 1hr
      await deleteBan(message.guild_id, message.author.id);
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
    await createMessage(targetChannelId, {
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
connection.onChannelDelete(channel => {
  sql.run`DELETE FROM honeypots WHERE channel_id = ${channel.id}`;
});
connection.onGuildDelete(guild => {
  sql.run`DELETE FROM honeypots WHERE guild_id = ${guild.id}`;
});
