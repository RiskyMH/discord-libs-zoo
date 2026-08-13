import dev.kord.common.entity.ChannelType
import dev.kord.common.entity.Permission
import dev.kord.common.entity.Permissions
import dev.kord.common.entity.PresenceStatus
import dev.kord.common.entity.Snowflake
import dev.kord.core.Kord
import dev.kord.core.behavior.ban
import dev.kord.core.behavior.channel.createMessage
import dev.kord.core.behavior.interaction.respondEphemeral
import dev.kord.core.behavior.interaction.respondPublic
import dev.kord.core.entity.channel.GuildMessageChannel
import dev.kord.core.entity.interaction.GuildChatInputCommandInteraction
import dev.kord.core.event.channel.ChannelDeleteEvent
import dev.kord.core.event.gateway.ReadyEvent
import dev.kord.core.event.guild.GuildDeleteEvent
import dev.kord.core.event.interaction.GuildChatInputCommandInteractionCreateEvent
import dev.kord.core.event.message.MessageCreateEvent
import dev.kord.core.on
import dev.kord.gateway.Intent
import dev.kord.rest.builder.interaction.channel
import dev.kord.rest.builder.interaction.string
import dev.kord.rest.builder.message.allowedMentions
import java.sql.Connection
import java.sql.DriverManager
import java.sql.SQLException
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.time.Duration.Companion.seconds

private val TOKEN = System.getenv("DISCORD_TOKEN")
    ?.takeIf { it.isNotEmpty() }
    ?: throw Error("DISCORD_TOKEN is required")

// Guild honeypot config is stored in SQLite so it survives restarts.
private val DB: Connection = run {
    val dbPath = System.getenv("DB_PATH") ?: "bot.db"
    try {
        val connection = DriverManager.getConnection("jdbc:sqlite:$dbPath")
        connection.createStatement().use { statement ->
            statement.execute(
                """
                CREATE TABLE IF NOT EXISTS honeypots (
                  guild_id TEXT PRIMARY KEY,
                  channel_id TEXT NOT NULL,
                  action TEXT NOT NULL DEFAULT 'ban',
                  log_channel_id TEXT
                )
                """.trimIndent(),
            )
        }
        connection
    } catch (error: SQLException) {
        throw Error("Failed to open database", error)
    }
}

private val COMMANDS_REGISTERED = AtomicBoolean(false)

private data class HoneypotConfig(
    val channelId: String,
    val action: String,
    val logChannelId: String?,
)

suspend fun main() {
    val kord = Kord(TOKEN)

    kord.on<ReadyEvent> {
        // Register slash commands once on startup.
        println("Logged in as ${self.tag}")
        if (COMMANDS_REGISTERED.compareAndSet(false, true)) {
            registerCommand(kord)
        }
    }

    kord.on<GuildChatInputCommandInteractionCreateEvent> {
        handleCommand(interaction)
    }

    kord.on<MessageCreateEvent> {
        handleMessage(this)
    }

    // Clean up config when a channel or guild goes away.
    kord.on<ChannelDeleteEvent> {
        deleteByChannel(channel.id.toString())
    }
    kord.on<GuildDeleteEvent> {
        deleteByGuild(guildId.toString())
    }

    kord.login {
        presence {
            status = PresenceStatus.Online
            state = "Watching #honeypot for bots"
        }
        // Guilds + guild messages are the only intents the honeypot needs.
        intents {
            +Intent.Guilds
            +Intent.GuildMessages
        }
    }
}

private suspend fun registerCommand(kord: Kord) {
    // kord-core 0.18.1's command builder has no contexts/integrationTypes
    // options (added in later versions), so the commands can only be
    // guild-only with default (guild-install) integration types.
    kord.createGlobalApplicationCommands {
        input(
            "honeypot-set",
            "Set/update honeypot channel (note: this overrides previous config set)",
        ) {
            defaultMemberPermissions = Permissions(Permission.BanMembers, Permission.ManageChannels)
            channel("channel", "The channel to ban people that message in it") {
                required = true
                channelTypes = listOf(ChannelType.GuildText)
            }
            string("action", "The action to take when someone messages in the honeypot channel") {
                required = true
                choice("Ban", "ban")
                choice("Softban", "softban")
                choice("Disabled", "disabled")
            }
            channel("log_channel", "The channel to log actions in (if ommited, then it won't log anywhere)") {
                required = false
                channelTypes = listOf(ChannelType.GuildText, ChannelType.PublicGuildThread, ChannelType.PrivateThread)
            }
        }
    }
}

// Handle the /honeypot-set command.
private suspend fun handleCommand(interaction: GuildChatInputCommandInteraction) {
    if (interaction.command.rootName != "honeypot-set") {
        interaction.respondEphemeral { content = "Unknown command" }
        return
    }

    val required = Permissions(Permission.BanMembers, Permission.ManageChannels)
    if (required !in interaction.permissions) {
        interaction.respondEphemeral { content = "You don't have permission to use this command." }
        return
    }

    val channelId = interaction.command.channels["channel"]?.id ?: return
    val action = interaction.command.strings["action"] ?: return
    val logChannel = interaction.command.channels["log_channel"]?.id

    if (action == "disabled") {
        // "disabled" removes the config instead of updating it.
        execute("DELETE FROM honeypots WHERE guild_id = ?", interaction.guildId.toString())
        interaction.respondPublic { content = "Honeypot configuration updated: Disabled honeypot for this server." }
        return
    }

    val logChannelId = logChannel?.toString()
    execute(
        """
        INSERT INTO honeypots (guild_id, channel_id, action, log_channel_id)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(guild_id) DO UPDATE SET
          channel_id = excluded.channel_id,
          action = excluded.action,
          log_channel_id = excluded.log_channel_id
        """.trimIndent(),
        interaction.guildId.toString(),
        channelId.toString(),
        action,
        logChannelId,
    )

    interaction.respondPublic {
        content = "Honeypot configuration updated: Will **$action** anyone who types in <#$channelId> " +
            (if (logChannel != null) "and log actions to <#$logChannelId>" else "and won't log actions") + "."
    }
}

// Ban anyone who messages in the configured honeypot channel.
private suspend fun handleMessage(event: MessageCreateEvent) {
    val author = event.message.author ?: return
    val guildId = event.guildId ?: return
    if (author.isBot) return

    val config = loadConfig(guildId.toString()) ?: return
    if (config.channelId != event.message.channelId.toString()) return

    val guild = event.getGuildOrNull() ?: return

    var success = true
    try {
        if (config.action == "ban") {
            guild.ban(author.id) {
                deleteMessageDuration = 3600.seconds // 1hr
                reason = "User typed in #honeypot channel -> ban"
            }
        } else if (config.action == "softban") {
            guild.ban(author.id) {
                deleteMessageDuration = 3600.seconds // 1hr
                reason = "User typed in #honeypot channel -> softban (1/2)"
            }
            guild.unban(author.id, "User typed in #honeypot channel -> softban (2/2)")
        } else {
            throw IllegalStateException("Unknown honeypot action: ${config.action}")
        }
    } catch (error: Throwable) {
        success = false
        System.err.println("Failed honeypot action (${config.action}): $error")
    }

    // On failure, log to the honeypot channel itself so moderators still see it.
    val targetChannelId = if (success) config.logChannelId else config.logChannelId ?: event.message.channelId.toString()
    if (targetChannelId == null) return

    val targetChannel = guild.getChannelOrNull(Snowflake(targetChannelId))
    if (targetChannel !is GuildMessageChannel) return

    try {
        targetChannel.createMessage {
            content = if (success) {
                "User <@${author.id}> was ${config.action} for triggering the honeypot in <#${event.message.channelId}>"
            } else {
                "User <@${author.id}> triggered the honeypot but I **failed** to ${config.action} them, " +
                    "please check my permissions to ensure I can ${config.action} them."
            }
            allowedMentions { }
        }
    } catch (error: Throwable) {
        System.err.println("Failed to send honeypot log message: $error")
    }
}

@Synchronized
private fun loadConfig(guildId: String): HoneypotConfig? {
    try {
        DB.prepareStatement("SELECT channel_id, action, log_channel_id FROM honeypots WHERE guild_id = ?").use { statement ->
            statement.setString(1, guildId)
            statement.executeQuery().use { result ->
                if (result.next()) {
                    return HoneypotConfig(
                        channelId = result.getString("channel_id"),
                        action = result.getString("action"),
                        logChannelId = result.getString("log_channel_id"),
                    )
                }
            }
        }
    } catch (error: SQLException) {
        System.err.println("Failed to load honeypot config: $error")
    }
    return null
}

@Synchronized
private fun execute(sql: String, vararg params: String?) {
    try {
        DB.prepareStatement(sql).use { statement ->
            params.forEachIndexed { index, param -> statement.setString(index + 1, param) }
            statement.executeUpdate()
        }
    } catch (error: SQLException) {
        System.err.println("Failed to execute query: $error")
    }
}

private fun deleteByChannel(channelId: String) {
    execute("DELETE FROM honeypots WHERE channel_id = ?", channelId)
}

private fun deleteByGuild(guildId: String) {
    execute("DELETE FROM honeypots WHERE guild_id = ?", guildId)
}
