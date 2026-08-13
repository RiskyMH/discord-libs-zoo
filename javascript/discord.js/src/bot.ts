import { DatabaseSync } from "node:sqlite";
import {
  ActivityType,
  ApplicationIntegrationType,
  ChannelType,
  Client,
  Events,
  GatewayIntentBits,
  InteractionContextType,
  PermissionFlagsBits,
  PresenceUpdateStatus,
  SlashCommandBuilder,
} from "discord.js";

const token = process.env.DISCORD_TOKEN;
if (!token) throw new Error("DISCORD_TOKEN is required");

const db = new DatabaseSync(process.env.DB_PATH ?? "bot.db");
const sql = db.createTagStore();

process.on("uncaughtException", (err) => {
  console.error(`Unhandled Exception: ${err}`);
});

process.on("unhandledRejection", (reason, promise) => {
  console.error(`Unhandled Rejection at: ${promise}, reason: ${reason}`);
});

const client = new Client({
  // Guilds + guild messages are the only intents the honeypot needs.
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
  ],
  presence: {
    status: PresenceUpdateStatus.Online,
    activities: [{
      name: "#honeypot",
      state: "Watching #honeypot for bots",
      type: ActivityType.Custom,
    }],
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

client.once(Events.ClientReady, async client => {
  console.log(`Logged in as ${client.user.tag}`);

  // Register slash commands once on startup.
  await client.application.commands.set([
    new SlashCommandBuilder()
      .setName("honeypot-set")
      .setDescription("Set/update honeypot channel (note: this overrides previous config set)")
      .setDefaultMemberPermissions(PermissionFlagsBits.BanMembers | PermissionFlagsBits.ManageChannels)
      .setContexts([InteractionContextType.Guild])
      .setIntegrationTypes([ApplicationIntegrationType.GuildInstall])
      .addChannelOption(option => option
        .setName("channel")
        .setDescription("The channel to ban people that message in it")
        .setRequired(true)
        .addChannelTypes(ChannelType.GuildText)
      )
      .addStringOption(option => option
        .setName("action")
        .setDescription("The action to take when someone messages in the honeypot channel")
        .setRequired(true)
        .addChoices(
          { name: "Ban", value: "ban" },
          { name: "Softban", value: "softban" },
          { name: "Disabled", value: "disabled" },
        )
      )
      .addChannelOption(option => option
        .setName("log_channel")
        .setDescription("The channel to log actions in (if ommited, then it won't log anywhere)")
        .setRequired(false)
        .addChannelTypes(ChannelType.GuildText, ChannelType.PublicThread, ChannelType.PrivateThread)
      ),
  ]);
});

// Handle the /honeypot-set command.
client.on(Events.InteractionCreate, async interaction => {
  if (!interaction.isChatInputCommand() || !interaction.inGuild()) return;
  if (interaction.commandName === "honeypot-set") {
    if (!interaction.memberPermissions.has(PermissionFlagsBits.BanMembers | PermissionFlagsBits.ManageChannels)) {
      await interaction.reply({ content: "You don't have permission to use this command.", ephemeral: true });
      return;
    }

    const channel = interaction.options.getChannel("channel", true);
    const action = interaction.options.getString("action", true);
    const logChannel = interaction.options.getChannel("log_channel");

    if (action === "disabled") {
      // "disabled" removes the config instead of updating it.
      sql.run`DELETE FROM honeypots WHERE guild_id = ${interaction.guildId}`;

      await interaction.reply("Honeypot configuration updated: Disabled honeypot for this server.");
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

    await interaction.reply(
      `Honeypot configuration updated: Will **${action}** anyone who types in <#${channel.id}> ${logChannel ? `and log actions to <#${logChannel.id}>` : "and won't log actions"}.`
    );
  } else {
    await interaction.reply({ content: "Unknown command", ephemeral: true });
  }
});

// Ban anyone who messages in the configured honeypot channel.
client.on(Events.MessageCreate, async message => {
  if (!message.inGuild() || message.author.bot) return;

  const honeypot = sql.get`SELECT * FROM honeypots WHERE guild_id = ${message.guildId}` as {
    channel_id: string;
    action: "ban" | "softban";
    log_channel_id: string | null;
  } | undefined;

  if (!honeypot || honeypot.channel_id !== message.channelId) return;

  let success = true;
  try {
    if (honeypot.action === "ban") {
      await message.guild.members.ban(message.author.id, {
        deleteMessageSeconds: 3600, // 1hr
        reason: "User typed in #honeypot channel -> ban",
      });
    } else if (honeypot.action === "softban") {
      await message.guild.members.ban(message.author.id, {
        deleteMessageSeconds: 3600, // 1hr
        reason: "User typed in #honeypot channel -> softban (1/2)",
      });
      await message.guild.members.unban(
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
    : honeypot.log_channel_id ?? message.channelId;
  if (!targetChannelId) return;

  const targetChannel = await message.guild.channels.fetch(targetChannelId);
  if (!targetChannel?.isTextBased()) return;

  try {
    await targetChannel.send({
      content: success
        ? `User <@${message.author.id}> was ${honeypot.action} for triggering the honeypot in <#${message.channelId}>`
        : `User <@${message.author.id}> triggered the honeypot but I **failed** to ${honeypot.action} them, please check my permissions to ensure I can ${honeypot.action} them.`,
      allowedMentions: {}
    });
  } catch (error) {
    console.error(`Failed to send honeypot log message: ${error}`);
  }
});

// Clean up config when a channel or guild goes away.
client.on(Events.ChannelDelete, channel => {
  sql.run`DELETE FROM honeypots WHERE channel_id = ${channel.id}`;
});
client.on(Events.GuildDelete, guild => {
  sql.run`DELETE FROM honeypots WHERE guild_id = ${guild.id}`;
});

client.login(token);
