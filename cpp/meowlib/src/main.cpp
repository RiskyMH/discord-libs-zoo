#include <MeowLib/commandHandling.h>
#include <MeowLib/log.h>
#include <MeowLib/message.h>
#include <MeowLib/nyaBot.h>
#include <MeowLib/permissions.h>
#include <MeowLib/slashCommandInt.h>
#include <MeowLib/slashCommands.h>

#include <cstdlib>
#include <cctype>
#include <format>
#include <iostream>
#include <optional>
#include <sqlite3.h>
#include <stdexcept>
#include <string>
#include <tuple>

namespace {

struct Honeypot {
  std::string guildId;
  std::string channelId;
  std::string action;
  std::optional<std::string> logChannelId;
};

class Database {
public:
  ~Database() {
    if (db) sqlite3_close(db);
  }

  bool create(const std::string_view path) {
    if (sqlite3_open(path.data(), &db) != SQLITE_OK) {
      Log::error("failed to open database: " + std::string(sqlite3_errmsg(db)));
      return false;
    }
    static constexpr std::string_view schema =
      "CREATE TABLE IF NOT EXISTS honeypots ("
      "  guild_id TEXT PRIMARY KEY,"
      "  channel_id TEXT NOT NULL,"
      "  action TEXT NOT NULL DEFAULT 'ban',"
      "  log_channel_id TEXT"
      ")";
    if (sqlite3_exec(db, schema.data(), nullptr, nullptr, nullptr) != SQLITE_OK) {
      Log::error("failed to init db");
      return false;
    }
    return true;
  }

  std::optional<Honeypot> getHoneypot(const std::string_view guildId) {
    sqlite3_stmt *stmt = nullptr;
    if (sqlite3_prepare_v2(db, "SELECT guild_id, channel_id, action, log_channel_id FROM honeypots WHERE guild_id = ?1", -1, &stmt, nullptr) != SQLITE_OK) {
      Log::error("failed to prepare statement");
      return std::nullopt;
    }
    sqlite3_bind_text(stmt, 1, guildId.data(), static_cast<int>(guildId.size()), SQLITE_TRANSIENT);
    if (sqlite3_step(stmt) != SQLITE_ROW) {
      sqlite3_finalize(stmt);
      return std::nullopt;
    }
    Honeypot honeypot;
    honeypot.guildId = reinterpret_cast<const char *>(sqlite3_column_text(stmt, 0));
    honeypot.channelId = reinterpret_cast<const char *>(sqlite3_column_text(stmt, 1));
    honeypot.action = reinterpret_cast<const char *>(sqlite3_column_text(stmt, 2));
    if (sqlite3_column_type(stmt, 3) != SQLITE_NULL)
      honeypot.logChannelId = reinterpret_cast<const char *>(sqlite3_column_text(stmt, 3));
    sqlite3_finalize(stmt);
    return honeypot;
  }

  bool upsert(const std::string_view guildId, const std::string_view channelId, const std::string_view action, const std::optional<std::string>& logChannelId) {
    static constexpr std::string_view query =
      "INSERT INTO honeypots (guild_id, channel_id, action, log_channel_id) "
      "VALUES (?1, ?2, ?3, ?4) "
      "ON CONFLICT(guild_id) DO UPDATE SET "
      "channel_id = excluded.channel_id, "
      "action = excluded.action, "
      "log_channel_id = excluded.log_channel_id";
    sqlite3_stmt *stmt = nullptr;
    if (sqlite3_prepare_v2(db, query.data(), -1, &stmt, nullptr) != SQLITE_OK) {
      Log::error("failed to prepare statement");
      return false;
    }
    sqlite3_bind_text(stmt, 1, guildId.data(), static_cast<int>(guildId.size()), SQLITE_TRANSIENT);
    sqlite3_bind_text(stmt, 2, channelId.data(), static_cast<int>(channelId.size()), SQLITE_TRANSIENT);
    sqlite3_bind_text(stmt, 3, action.data(), static_cast<int>(action.size()), SQLITE_TRANSIENT);
    if (logChannelId)
      sqlite3_bind_text(stmt, 4, logChannelId->data(), static_cast<int>(logChannelId->size()), SQLITE_TRANSIENT);
    else
      sqlite3_bind_null(stmt, 4);
    bool ok = sqlite3_step(stmt) == SQLITE_DONE;
    sqlite3_finalize(stmt);
    return ok;
  }

  bool removeByGuild(const std::string_view guildId) {
    sqlite3_stmt *stmt = nullptr;
    if (sqlite3_prepare_v2(db, "DELETE FROM honeypots WHERE guild_id = ?1", -1, &stmt, nullptr) != SQLITE_OK)
      return false;
    sqlite3_bind_text(stmt, 1, guildId.data(), static_cast<int>(guildId.size()), SQLITE_TRANSIENT);
    bool ok = sqlite3_step(stmt) == SQLITE_DONE;
    sqlite3_finalize(stmt);
    return ok;
  }

  bool removeByChannel(const std::string_view channelId) {
    sqlite3_stmt *stmt = nullptr;
    if (sqlite3_prepare_v2(db, "DELETE FROM honeypots WHERE channel_id = ?1", -1, &stmt, nullptr) != SQLITE_OK)
      return false;
    sqlite3_bind_text(stmt, 1, channelId.data(), static_cast<int>(channelId.size()), SQLITE_TRANSIENT);
    bool ok = sqlite3_step(stmt) == SQLITE_DONE;
    sqlite3_finalize(stmt);
    return ok;
  }

private:
  sqlite3 *db = nullptr;
};

class HoneypotSetHandler : public Command {
public:
  explicit HoneypotSetHandler(Database *db) : db(db) {}

  void onCommand(SlashCommandInteraction& i) override {
    if (!hasPermission(i.user, Permissions::BAN_MEMBERS) || !hasPermission(i.user, Permissions::MANAGE_CHANNELS)) {
      std::ignore = i.respond("You don't have permission to use this command.", MsgFlags::EPHEMERAL);
      return;
    }

    auto channelIt = i.parameters.find("channel");
    auto actionIt = i.parameters.find("action");
    if (channelIt == i.parameters.end() || actionIt == i.parameters.end()) {
      std::ignore = i.respond("idk what happened", MsgFlags::EPHEMERAL);
      return;
    }
    const std::string& channel = channelIt->second;
    // MeowLib sends a choice's value equal to its display name, so "Ban"/
    // "Softban"/"Disabled" arrive capitalized; lowercase to match the
    // stored action values ("ban"/"softban"/"disabled").
    std::string action = actionIt->second;
    for (char& c : action) {
      c = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
    }

    std::optional<std::string> logChannel;
    if (auto logIt = i.parameters.find("log_channel"); logIt != i.parameters.end())
      logChannel = logIt->second;

    if (action == "disabled") {
      db->removeByGuild(*i.guildId);
      std::ignore = i.respond("Honeypot configuration updated: Disabled honeypot for this server.");
      return;
    }

    db->upsert(*i.guildId, channel, action, logChannel);

    if (logChannel)
      std::ignore = i.respond(std::format("Honeypot configuration updated: Will **{}** anyone who types in <#{}> and log actions to <#{}>.", action, channel, *logChannel));
    else
      std::ignore = i.respond(std::format("Honeypot configuration updated: Will **{}** anyone who types in <#{}> and won't log actions.", action, channel));
  }

private:
  Database *db;
};

void sendLogMessage(NyaBot& bot, const std::string_view channelId, const std::string& content) {
  // MeowLib's message API can't set allowed_mentions, so the mention ping
  // can't be suppressed.
  auto res = bot.message.create(channelId, content);
  if (!res)
    Log::error("Failed to send honeypot log message");
}

}  // namespace

int main() {
  const char *token = std::getenv("DISCORD_TOKEN");
  if (token == nullptr || token[0] == '\0') {
    Log::error("DISCORD_TOKEN is required");
    return 1;
  }

  const char *dbPath = std::getenv("DB_PATH");
  if (dbPath == nullptr || dbPath[0] == '\0')
    dbPath = "bot.db";

  Database db;
  if (!db.create(dbPath)) return 1;

  NyaBot bot(Intents::GUILDS | Intents::GUILD_MESSAGES);

  bot.addSlash(
    SlashCommand("honeypot-set", "Set/update honeypot channel (note: this overrides previous config set)", IntegrationTypes::GUILD_INSTALL)
      .setDefaultMemberPermissions(static_cast<uint64_t>(Permissions::BAN_MEMBERS) | static_cast<uint64_t>(Permissions::MANAGE_CHANNELS))
      // MeowLib's SlashCommandParameter has no channel_types field, so the
      // channel options can't be restricted to text channels.
      .addParam(SlashCommandParameter("channel", "The channel to ban people that message in it", Types::CHANNEL, true))
      .addParam(SlashCommandParameter("action", "The action to take when someone messages in the honeypot channel", Types::STRING, true)
                  .addChoice("Ban")
                  .addChoice("Softban")
                  .addChoice("Disabled"))
      .addParam(SlashCommandParameter("log_channel", "The channel to log actions in (if ommited, then it won't log anywhere)", Types::CHANNEL, false))
      .withCommandHandler<HoneypotSetHandler>(&db)
  );

  bot.onReady([&bot](Ready& ready) {
    std::cout << "Logged in as " << ready.user.username << "#" << ready.user.discriminator << std::endl;
    runOnce(&NyaBot::syncApplicationCommands, &bot);
  });

  bot.onMessageCreate([&bot, &db](Message& msg) {
    if (!msg.guildId || msg.author.bot) return;

    auto honeypot = db.getHoneypot(*msg.guildId);
    if (!honeypot || honeypot->channelId != msg.channelId) return;

    bool success = true;
    try {
      auto ban = [&](const std::string_view reason) {
        auto res = bot.guild.createBan(*msg.guildId, msg.author.id, std::optional<int>(3600), std::optional<std::string>(std::string(reason)));
        if (!res) throw std::runtime_error(res.error().message);
      };
      auto unban = [&](const std::string_view reason) {
        auto res = bot.guild.removeBan(*msg.guildId, msg.author.id, std::optional<std::string>(std::string(reason)));
        if (!res) throw std::runtime_error(res.error().message);
      };
      if (honeypot->action == "ban") {
        ban("User typed in #honeypot channel -> ban");
      } else if (honeypot->action == "softban") {
        ban("User typed in #honeypot channel -> softban (1/2)");
        unban("User typed in #honeypot channel -> softban (2/2)");
      } else {
        throw std::runtime_error("Unknown honeypot action: " + honeypot->action);
      }
    } catch (const std::exception& e) {
      success = false;
      Log::error("Failed honeypot action (" + honeypot->action + "): " + e.what());
    }

    std::optional<std::string> targetChannelId;
    if (success)
      targetChannelId = honeypot->logChannelId;
    else
      targetChannelId = honeypot->logChannelId ? honeypot->logChannelId : std::optional<std::string>(msg.channelId);
    if (!targetChannelId) return;

    const std::string content = success
      ? std::format("User <@{}> was {} for triggering the honeypot in <#{}>", msg.author.id, honeypot->action, msg.channelId)
      : std::format("User <@{}> triggered the honeypot but I **failed** to {} them, please check my permissions to ensure I can {} them.", msg.author.id, honeypot->action, honeypot->action);

    sendLogMessage(bot, *targetChannelId, content);
  });

  bot.onChannelDelete([&db](Channel& ch) {
    db.removeByChannel(ch.id);
  });

  bot.onGuildDelete([&db](UnavailableGuild& g) {
    db.removeByGuild(g.id);
  });

  bot.run(token);
  return 0;
}
