using System;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using Discord;
using Discord.WebSocket;
using Microsoft.Data.Sqlite;

string? token = Environment.GetEnvironmentVariable("DISCORD_TOKEN");
if (string.IsNullOrEmpty(token))
    throw new InvalidOperationException("DISCORD_TOKEN is required");

string connString = new SqliteConnectionStringBuilder
{
    DataSource = Environment.GetEnvironmentVariable("DB_PATH") ?? "bot.db",
}.ToString();

using (SqliteConnection conn = OpenDb())
{
    using SqliteCommand cmd = conn.CreateCommand();
    cmd.CommandText =
        "CREATE TABLE IF NOT EXISTS honeypots ( " +
        "guild_id TEXT PRIMARY KEY, " +
        "channel_id TEXT NOT NULL, " +
        "action TEXT NOT NULL DEFAULT 'ban', " +
        "log_channel_id TEXT )";
    cmd.ExecuteNonQuery();
}

DiscordSocketClient client = new(new DiscordSocketConfig
{
    GatewayIntents = GatewayIntents.Guilds | GatewayIntents.GuildMessages,
});

client.Log += LogAsync;
client.Ready += OnReadyAsync;
client.SlashCommandExecuted += OnSlashCommandExecutedAsync;
client.MessageReceived += OnMessageReceivedAsync;
client.ChannelDestroyed += OnChannelDestroyedAsync;
client.LeftGuild += OnLeftGuildAsync;

await client.LoginAsync(TokenType.Bot, token);
await client.StartAsync();

await Task.Delay(Timeout.Infinite);

SqliteConnection OpenDb()
{
    var conn = new SqliteConnection(connString);
    conn.Open();
    return conn;
}

void RunSql(string sql, Action<SqliteCommand>? addParams = null)
{
    using SqliteConnection conn = OpenDb();
    using SqliteCommand cmd = conn.CreateCommand();
    cmd.CommandText = sql;
    addParams?.Invoke(cmd);
    cmd.ExecuteNonQuery();
}

(string ChannelId, string Action, string? LogChannelId)? GetHoneypot(string guildId)
{
    using SqliteConnection conn = OpenDb();
    using SqliteCommand cmd = conn.CreateCommand();
    cmd.CommandText = "SELECT channel_id, action, log_channel_id FROM honeypots WHERE guild_id = $guild_id";
    cmd.Parameters.AddWithValue("$guild_id", guildId);
    using SqliteDataReader reader = cmd.ExecuteReader();
    if (!reader.Read())
        return null;
    return (reader.GetString(0), reader.GetString(1), reader.IsDBNull(2) ? null : reader.GetString(2));
}

Task LogAsync(LogMessage message)
{
    Console.WriteLine(message.ToString());
    return Task.CompletedTask;
}

async Task OnReadyAsync()
{
    Console.WriteLine($"Logged in as {client.CurrentUser}");

    await client.SetCustomStatusAsync("Watching #honeypot for bots");

    await client.BulkOverwriteGlobalApplicationCommandsAsync(new[]
    {
        new SlashCommandBuilder()
            .WithName("honeypot-set")
            .WithDescription("Set/update honeypot channel (note: this overrides previous config set)")
            .WithDefaultMemberPermissions(GuildPermission.BanMembers | GuildPermission.ManageChannels)
            .WithContextTypes(InteractionContextType.Guild)
            .WithIntegrationTypes(ApplicationIntegrationType.GuildInstall)
            .AddOption(new SlashCommandOptionBuilder()
                .WithName("channel")
                .WithDescription("The channel to ban people that message in it")
                // Discord.Net has no CreateChannelOption, so channel options
                // are built with the generic builder using .WithType(Channel).
                .WithType(ApplicationCommandOptionType.Channel)
                .WithRequired(true)
                .AddChannelType(ChannelType.Text))
            .AddOption(new SlashCommandOptionBuilder()
                .WithName("action")
                .WithDescription("The action to take when someone messages in the honeypot channel")
                .WithType(ApplicationCommandOptionType.String)
                .WithRequired(true)
                .AddChoice("Ban", "ban")
                .AddChoice("Softban", "softban")
                .AddChoice("Disabled", "disabled"))
            .AddOption(new SlashCommandOptionBuilder()
                .WithName("log_channel")
                .WithDescription("The channel to log actions in (if ommited, then it won't log anywhere)")
                .WithType(ApplicationCommandOptionType.Channel)
                .WithRequired(false)
                .AddChannelType(ChannelType.Text)
                .AddChannelType(ChannelType.PublicThread)
                .AddChannelType(ChannelType.PrivateThread))
        .Build()
    });
}

async Task OnSlashCommandExecutedAsync(SocketSlashCommand command)
{
    if (command.Data.Name != "honeypot-set")
    {
        await command.RespondAsync("Unknown command", ephemeral: true);
        return;
    }

    if (command.User is not SocketGuildUser guildUser || command.GuildId is not { } guildId)
        return;

    if (!guildUser.GuildPermissions.Has(GuildPermission.BanMembers | GuildPermission.ManageChannels))
    {
        await command.RespondAsync("You don't have permission to use this command.", ephemeral: true);
        return;
    }

    SocketChannel? channel = command.Data.Options.FirstOrDefault(o => o.Name == "channel")?.Value as SocketChannel;
    string? action = command.Data.Options.FirstOrDefault(o => o.Name == "action")?.Value as string;
    SocketChannel? logChannel = command.Data.Options.FirstOrDefault(o => o.Name == "log_channel")?.Value as SocketChannel;

    if (action == "disabled")
    {
        RunSql("DELETE FROM honeypots WHERE guild_id = $guild_id",
            cmd => cmd.Parameters.AddWithValue("$guild_id", guildId.ToString()));

        await command.RespondAsync("Honeypot configuration updated: Disabled honeypot for this server.");
        return;
    }

    RunSql(
        "INSERT INTO honeypots (guild_id, channel_id, action, log_channel_id) " +
        "VALUES ($guild_id, $channel_id, $action, $log_channel_id) " +
        "ON CONFLICT(guild_id) DO UPDATE SET " +
        "channel_id = excluded.channel_id, action = excluded.action, log_channel_id = excluded.log_channel_id",
        cmd =>
        {
            cmd.Parameters.AddWithValue("$guild_id", guildId.ToString());
            cmd.Parameters.AddWithValue("$channel_id", channel!.Id.ToString());
            cmd.Parameters.AddWithValue("$action", action);
            cmd.Parameters.AddWithValue("$log_channel_id", (object?)logChannel?.Id.ToString() ?? DBNull.Value);
        });

    await command.RespondAsync(
        logChannel != null
            ? $"Honeypot configuration updated: Will **{action}** anyone who types in <#{channel!.Id}> and log actions to <#{logChannel.Id}>"
            : $"Honeypot configuration updated: Will **{action}** anyone who types in <#{channel!.Id}> and won't log actions");
}

async Task OnMessageReceivedAsync(SocketMessage message)
{
    if (message.Author.IsBot) return;
    if (message.Channel is not SocketGuildChannel guildChannel) return;
    SocketGuild guild = guildChannel.Guild;

    var honeypot = GetHoneypot(guild.Id.ToString());
    if (honeypot == null || honeypot.Value.ChannelId != message.Channel.Id.ToString()) return;

    var (_, action, logChannelId) = honeypot.Value;

    bool success = true;
    try
    {
        if (action == "ban")
        {
            // AddBanAsync only accepts pruneDays (0-7); the seconds-based
            // BanUserAsync overload has no reason parameter, so pruneDays 0
            // is used to keep the audit-log reason.
            await guild.AddBanAsync(message.Author, pruneDays: 0, reason: "User typed in #honeypot channel -> ban");
        }
        else if (action == "softban")
        {
            await guild.AddBanAsync(message.Author, pruneDays: 0, reason: "User typed in #honeypot channel -> softban (1/2)");
            // RemoveBanAsync has no reason parameter.
            await guild.RemoveBanAsync(message.Author);
        }
        else
        {
            throw new InvalidOperationException($"Unknown honeypot action: {action}");
        }
    }
    catch (Exception ex)
    {
        success = false;
        Console.Error.WriteLine($"Failed honeypot action ({action}): {ex}");
    }

    string? targetChannelId = success ? logChannelId : (logChannelId ?? message.Channel.Id.ToString());
    if (targetChannelId == null) return;

    if (await client.GetChannelAsync(ulong.Parse(targetChannelId)) is not IMessageChannel target)
        return;

    try
    {
        await target.SendMessageAsync(
            text: success
                ? $"User <@{message.Author.Id}> was {action} for triggering the honeypot in <#{message.Channel.Id}>"
                : $"User <@{message.Author.Id}> triggered the honeypot but I **failed** to {action} them, please check my permissions to ensure I can {action} them.",
            allowedMentions: AllowedMentions.None);
    }
    catch (Exception ex)
    {
        Console.Error.WriteLine($"Failed to send honeypot log message: {ex}");
    }
}

Task OnChannelDestroyedAsync(SocketChannel channel)
{
    RunSql("DELETE FROM honeypots WHERE channel_id = $channel_id",
        cmd => cmd.Parameters.AddWithValue("$channel_id", channel.Id.ToString()));
    return Task.CompletedTask;
}

Task OnLeftGuildAsync(SocketGuild guild)
{
    RunSql("DELETE FROM honeypots WHERE guild_id = $guild_id",
        cmd => cmd.Parameters.AddWithValue("$guild_id", guild.Id.ToString()));
    return Task.CompletedTask;
}
