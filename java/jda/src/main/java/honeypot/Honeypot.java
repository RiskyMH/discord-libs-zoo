package honeypot;

import net.dv8tion.jda.api.JDA;
import net.dv8tion.jda.api.JDABuilder;
import net.dv8tion.jda.api.OnlineStatus;
import net.dv8tion.jda.api.Permission;
import net.dv8tion.jda.api.entities.Activity;
import net.dv8tion.jda.api.entities.Message;
import net.dv8tion.jda.api.entities.channel.ChannelType;
import net.dv8tion.jda.api.entities.channel.middleman.GuildChannel;
import net.dv8tion.jda.api.entities.channel.middleman.MessageChannel;
import net.dv8tion.jda.api.events.channel.ChannelDeleteEvent;
import net.dv8tion.jda.api.events.guild.GuildLeaveEvent;
import net.dv8tion.jda.api.events.interaction.command.SlashCommandInteractionEvent;
import net.dv8tion.jda.api.events.message.MessageReceivedEvent;
import net.dv8tion.jda.api.events.session.ReadyEvent;
import net.dv8tion.jda.api.hooks.ListenerAdapter;
import net.dv8tion.jda.api.interactions.IntegrationType;
import net.dv8tion.jda.api.interactions.InteractionContextType;
import net.dv8tion.jda.api.interactions.commands.DefaultMemberPermissions;
import net.dv8tion.jda.api.interactions.commands.OptionMapping;
import net.dv8tion.jda.api.interactions.commands.OptionType;
import net.dv8tion.jda.api.interactions.commands.build.Commands;
import net.dv8tion.jda.api.interactions.commands.build.OptionData;
import net.dv8tion.jda.api.requests.GatewayIntent;

import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Statement;
import java.util.EnumSet;
import java.util.concurrent.TimeUnit;

public class Honeypot extends ListenerAdapter {
    private static final String TOKEN = System.getenv("DISCORD_TOKEN");
    private static final Connection DB;

    static {
        if (TOKEN == null || TOKEN.isEmpty()) {
            throw new Error("DISCORD_TOKEN is required");
        }

        // Guild honeypot config is stored in SQLite so it survives restarts.
        try {
            String dbPath = System.getenv("DB_PATH");
            if (dbPath == null) dbPath = "bot.db";
            DB = DriverManager.getConnection("jdbc:sqlite:" + dbPath);
            try (Statement stmt = DB.createStatement()) {
                stmt.execute("""
                    CREATE TABLE IF NOT EXISTS honeypots (
                      guild_id TEXT PRIMARY KEY,
                      channel_id TEXT NOT NULL,
                      action TEXT NOT NULL DEFAULT 'ban',
                      log_channel_id TEXT
                    )
                    """);
            }
        } catch (SQLException e) {
            throw new Error("Failed to open database", e);
        }
    }

    private record HoneypotConfig(String channelId, String action, String logChannelId) {}

    public static void main(String[] args) {
        Thread.setDefaultUncaughtExceptionHandler((thread, error) ->
                System.err.println("Unhandled Exception: " + error));

        // Guild messages is the only intent the honeypot needs (GUILDS is always enabled).
        JDABuilder.createDefault(TOKEN)
                .enableIntents(GatewayIntent.GUILD_MESSAGES)
                .addEventListeners(new Honeypot())
                .build();
    }

    @Override
    public void onReady(ReadyEvent event) {
        // Register slash commands once on startup.
        event.getJDA().getPresence().setStatus(OnlineStatus.ONLINE);
        event.getJDA().getPresence().setActivity(Activity.customStatus("Watching #honeypot for bots"));
        System.out.println("Logged in as " + event.getJDA().getSelfUser().getName()
                + "#" + event.getJDA().getSelfUser().getDiscriminator());
        registerCommand(event.getJDA());
    }

    @Override
    public void onSlashCommandInteraction(SlashCommandInteractionEvent event) {
        handleCommand(event);
    }

    @Override
    public void onMessageReceived(MessageReceivedEvent event) {
        handleMessage(event);
    }

    @Override
    public void onChannelDelete(ChannelDeleteEvent event) {
        // Clean up config when a channel goes away.
        deleteByChannel(event.getChannel().getId());
    }

    @Override
    public void onGuildLeave(GuildLeaveEvent event) {
        // Clean up config when the bot leaves a guild.
        deleteByGuild(event.getGuild().getId());
    }

    private static void registerCommand(JDA jda) {
        jda.updateCommands().addCommands(
                Commands.slash("honeypot-set", "Set/update honeypot channel (note: this overrides previous config set)")
                        .setDefaultPermissions(DefaultMemberPermissions.enabledFor(Permission.BAN_MEMBERS, Permission.MANAGE_CHANNEL))
                        .setContexts(InteractionContextType.GUILD)
                        .setIntegrationTypes(IntegrationType.GUILD_INSTALL)
                        .addOptions(
                                new OptionData(OptionType.CHANNEL, "channel",
                                        "The channel to ban people that message in it", true)
                                        .setChannelTypes(ChannelType.TEXT),
                                new OptionData(OptionType.STRING, "action",
                                        "The action to take when someone messages in the honeypot channel", true)
                                        .addChoice("Ban", "ban")
                                        .addChoice("Softban", "softban")
                                        .addChoice("Disabled", "disabled"),
                                new OptionData(OptionType.CHANNEL, "log_channel",
                                        "The channel to log actions in (if ommited, then it won't log anywhere)", false)
                                        .setChannelTypes(ChannelType.TEXT,
                                                ChannelType.GUILD_PUBLIC_THREAD, ChannelType.GUILD_PRIVATE_THREAD)))
                .queue();
    }

    // Handle the /honeypot-set command.
    private static void handleCommand(SlashCommandInteractionEvent event) {
        if (event.getGuild() == null) return;

        if (!event.getName().equals("honeypot-set")) {
            event.reply("Unknown command").setEphemeral(true).queue();
            return;
        }

        if (!event.getMember().hasPermission(Permission.BAN_MEMBERS, Permission.MANAGE_CHANNEL)) {
            event.reply("You don't have permission to use this command.").setEphemeral(true).queue();
            return;
        }

        String channelId = event.getOption("channel").getAsChannel().getId();
        String action = event.getOption("action").getAsString();
        OptionMapping logChannel = event.getOption("log_channel");

        if (action.equals("disabled")) {
            // "disabled" removes the config instead of updating it.
            execute("DELETE FROM honeypots WHERE guild_id = ?", event.getGuild().getId());
            event.reply("Honeypot configuration updated: Disabled honeypot for this server.").queue();
            return;
        }

        String logChannelId = logChannel == null ? null : logChannel.getAsChannel().getId();
        execute("""
                INSERT INTO honeypots (guild_id, channel_id, action, log_channel_id)
                VALUES (?, ?, ?, ?)
                ON CONFLICT(guild_id) DO UPDATE SET
                  channel_id = excluded.channel_id,
                  action = excluded.action,
                  log_channel_id = excluded.log_channel_id
                """, event.getGuild().getId(), channelId, action, logChannelId);

        event.reply("Honeypot configuration updated: Will **" + action + "** anyone who types in <#" + channelId + "> "
                + (logChannel != null ? "and log actions to <#" + logChannelId + ">" : "and won't log actions") + ".")
                .queue();
    }

    // Ban anyone who messages in the configured honeypot channel.
    private static void handleMessage(MessageReceivedEvent event) {
        if (!event.isFromGuild() || event.getAuthor().isBot()) return;

        HoneypotConfig config = loadConfig(event.getGuild().getId());
        if (config == null || !config.channelId().equals(event.getChannel().getId())) return;

        String action = config.action();
        boolean success = true;
        try {
            if (action.equals("ban")) {
                // Purge the last hour (3600s) of the user's messages.
                event.getGuild().ban(event.getAuthor(), 1, TimeUnit.HOURS)
                        .reason("User typed in #honeypot channel -> ban")
                        .complete();
            } else if (action.equals("softban")) {
                // Purge the last hour (3600s) of the user's messages.
                event.getGuild().ban(event.getAuthor(), 1, TimeUnit.HOURS)
                        .reason("User typed in #honeypot channel -> softban (1/2)")
                        .complete();
                event.getGuild().unban(event.getAuthor())
                        .reason("User typed in #honeypot channel -> softban (2/2)")
                        .complete();
            } else {
                throw new IllegalStateException("Unknown honeypot action: " + action);
            }
        } catch (RuntimeException error) {
            success = false;
            System.err.println("Failed honeypot action (" + action + "): " + error);
        }

        // On failure, log to the honeypot channel itself so moderators still see it.
        String targetChannelId = success
                ? config.logChannelId()
                : config.logChannelId() != null ? config.logChannelId() : event.getChannel().getId();
        if (targetChannelId == null) return;

        GuildChannel targetChannel = event.getGuild().getGuildChannelById(targetChannelId);
        if (!(targetChannel instanceof MessageChannel textChannel)) return;

        try {
            textChannel.sendMessage(success
                    ? "User <@" + event.getAuthor().getId() + "> was " + action
                        + " for triggering the honeypot in <#" + event.getChannel().getId() + ">"
                    : "User <@" + event.getAuthor().getId() + "> triggered the honeypot but I **failed** to " + action
                        + " them, please check my permissions to ensure I can " + action + " them.")
                    .setAllowedMentions(EnumSet.noneOf(Message.MentionType.class))
                    .complete();
        } catch (RuntimeException error) {
            System.err.println("Failed to send honeypot log message: " + error);
        }
    }

    private static synchronized HoneypotConfig loadConfig(String guildId) {
        try (PreparedStatement stmt = DB.prepareStatement(
                "SELECT channel_id, action, log_channel_id FROM honeypots WHERE guild_id = ?")) {
            stmt.setString(1, guildId);
            try (ResultSet rs = stmt.executeQuery()) {
                if (rs.next()) {
                    return new HoneypotConfig(
                            rs.getString("channel_id"),
                            rs.getString("action"),
                            rs.getString("log_channel_id"));
                }
            }
        } catch (SQLException e) {
            System.err.println("Failed to load honeypot config: " + e);
        }
        return null;
    }

    private static synchronized void execute(String sql, String... params) {
        try (PreparedStatement stmt = DB.prepareStatement(sql)) {
            for (int i = 0; i < params.length; i++) {
                stmt.setString(i + 1, params[i]);
            }
            stmt.executeUpdate();
        } catch (SQLException e) {
            System.err.println("Failed to execute query: " + e);
        }
    }

    private static void deleteByChannel(String channelId) {
        execute("DELETE FROM honeypots WHERE channel_id = ?", channelId);
    }

    private static void deleteByGuild(String guildId) {
        execute("DELETE FROM honeypots WHERE guild_id = ?", guildId);
    }
}
