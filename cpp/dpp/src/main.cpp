#include <dpp/dpp.h>
#include <sqlite3.h>

#include <cstdlib>
#include <iostream>
#include <optional>
#include <string>

struct Honeypot {
	bool found = false;
	std::string channel_id;
	std::string action;
	std::string log_channel_id;
};

static sqlite3* open_db(const std::string& path) {
	sqlite3* db = nullptr;
	if (sqlite3_open(path.c_str(), &db) != SQLITE_OK) {
		std::cerr << "Failed to open database: " << sqlite3_errmsg(db) << std::endl;
		sqlite3_close(db);
		std::exit(1);
	}
	return db;
}

static void db_exec(sqlite3* db, const std::string& sql) {
	char* errmsg = nullptr;
	if (sqlite3_exec(db, sql.c_str(), nullptr, nullptr, &errmsg) != SQLITE_OK) {
		std::cerr << "SQLite error: " << (errmsg ? errmsg : "unknown") << std::endl;
		sqlite3_free(errmsg);
	}
}

static void upsert_config(sqlite3* db, const std::string& guild_id, const std::string& channel_id,
                          const std::string& action, const std::optional<std::string>& log_channel_id) {
	sqlite3_stmt* stmt = nullptr;
	sqlite3_prepare_v2(
	    db,
	    "INSERT INTO honeypots (guild_id, channel_id, action, log_channel_id) VALUES (?, ?, ?, ?) "
	    "ON CONFLICT(guild_id) DO UPDATE SET "
	    "channel_id = excluded.channel_id, action = excluded.action, log_channel_id = excluded.log_channel_id",
	    -1, &stmt, nullptr);
	sqlite3_bind_text(stmt, 1, guild_id.c_str(), -1, SQLITE_TRANSIENT);
	sqlite3_bind_text(stmt, 2, channel_id.c_str(), -1, SQLITE_TRANSIENT);
	sqlite3_bind_text(stmt, 3, action.c_str(), -1, SQLITE_TRANSIENT);
	if (log_channel_id) {
		sqlite3_bind_text(stmt, 4, log_channel_id->c_str(), -1, SQLITE_TRANSIENT);
	} else {
		sqlite3_bind_null(stmt, 4);
	}
	sqlite3_step(stmt);
	sqlite3_finalize(stmt);
}

static void delete_config_by_channel(sqlite3* db, const std::string& channel_id) {
	sqlite3_stmt* stmt = nullptr;
	sqlite3_prepare_v2(db, "DELETE FROM honeypots WHERE channel_id = ?", -1, &stmt, nullptr);
	sqlite3_bind_text(stmt, 1, channel_id.c_str(), -1, SQLITE_TRANSIENT);
	sqlite3_step(stmt);
	sqlite3_finalize(stmt);
}

static void delete_config_by_guild(sqlite3* db, const std::string& guild_id) {
	sqlite3_stmt* stmt = nullptr;
	sqlite3_prepare_v2(db, "DELETE FROM honeypots WHERE guild_id = ?", -1, &stmt, nullptr);
	sqlite3_bind_text(stmt, 1, guild_id.c_str(), -1, SQLITE_TRANSIENT);
	sqlite3_step(stmt);
	sqlite3_finalize(stmt);
}

static Honeypot load_config(sqlite3* db, const std::string& guild_id) {
	sqlite3_stmt* stmt = nullptr;
	sqlite3_prepare_v2(db, "SELECT channel_id, action, log_channel_id FROM honeypots WHERE guild_id = ?",
	                   -1, &stmt, nullptr);
	sqlite3_bind_text(stmt, 1, guild_id.c_str(), -1, SQLITE_TRANSIENT);
	Honeypot hp;
	if (sqlite3_step(stmt) == SQLITE_ROW) {
		hp.found = true;
		hp.channel_id = reinterpret_cast<const char*>(sqlite3_column_text(stmt, 0));
		hp.action = reinterpret_cast<const char*>(sqlite3_column_text(stmt, 1));
		const unsigned char* log = sqlite3_column_text(stmt, 2);
		if (log) {
			hp.log_channel_id = reinterpret_cast<const char*>(log);
		}
	}
	sqlite3_finalize(stmt);
	return hp;
}

static bool is_text_based(const dpp::channel* ch) {
	if (!ch) {
		return false;
	}
	switch (ch->get_type()) {
		case dpp::CHANNEL_TEXT:
		case dpp::CHANNEL_ANNOUNCEMENT:
		case dpp::CHANNEL_PUBLIC_THREAD:
		case dpp::CHANNEL_PRIVATE_THREAD:
			return true;
		default:
			return false;
	}
}

static void send_log(dpp::cluster& bot, const Honeypot& hp, const dpp::message& msg, bool success) {
	dpp::snowflake log_channel_id = hp.log_channel_id.empty() ? dpp::snowflake{} : dpp::snowflake(hp.log_channel_id);
	// On failure, log to the honeypot channel itself so moderators still see it.
	dpp::snowflake target_id = success ? log_channel_id : (log_channel_id ? log_channel_id : msg.channel_id);
	if (target_id.empty()) {
		return;
	}

	dpp::channel* target_channel = dpp::find_channel(target_id);
	if (!is_text_based(target_channel)) {
		return;
	}

	std::string content = success
	    ? "User <@" + msg.author.id.str() + "> was " + hp.action + " for triggering the honeypot in <#" + msg.channel_id.str() + ">"
	    : "User <@" + msg.author.id.str() + "> triggered the honeypot but I **failed** to " + hp.action +
	          " them, please check my permissions to ensure I can " + hp.action + " them.";

	dpp::message m(target_id, content);
	m.set_allowed_mentions(false, false, false, false);
	bot.message_create(m, [](const dpp::confirmation_callback_t& cb) {
		if (cb.is_error()) {
			std::cerr << "Failed to send honeypot log message: " << cb.get_error().message << std::endl;
		}
	});
}

struct register_bot_commands;

int main() {
	const char* token = std::getenv("DISCORD_TOKEN");
	if (!token || !*token) {
		std::cerr << "DISCORD_TOKEN is required" << std::endl;
		return 1;
	}
	const char* db_path_env = std::getenv("DB_PATH");
	std::string db_path = (db_path_env && *db_path_env) ? db_path_env : "bot.db";

	sqlite3* db = open_db(db_path);
	db_exec(db, "CREATE TABLE IF NOT EXISTS honeypots (guild_id TEXT PRIMARY KEY, channel_id TEXT NOT NULL, "
	            "action TEXT NOT NULL DEFAULT 'ban', log_channel_id TEXT)");

	dpp::cluster bot(token, dpp::i_default_intents);

	bot.on_ready([&bot](const dpp::ready_t&) {
		if (dpp::run_once<struct register_bot_commands>()) {
			std::cout << "Logged in as " << bot.me.format_username() << std::endl;

			bot.set_presence(dpp::presence(dpp::ps_online, dpp::activity(dpp::at_custom, "#honeypot", "Watching #honeypot for bots", "")));

			// Register slash commands once on startup.
			dpp::slashcommand command("honeypot-set",
			                          "Set/update honeypot channel (note: this overrides previous config set)",
			                          bot.me.id);
			command.set_default_permissions(dpp::p_ban_members | dpp::p_manage_channels);
			command.set_interaction_contexts({dpp::itc_guild});
			command.integration_types = {dpp::ait_guild_install};
			command.add_option(dpp::command_option(dpp::co_channel, "channel",
			                                       "The channel to ban people that message in it", true)
			                       .add_channel_type(dpp::CHANNEL_TEXT));
			command.add_option(dpp::command_option(dpp::co_string, "action",
			                                       "The action to take when someone messages in the honeypot channel", true)
			                       .add_choice(dpp::command_option_choice("Ban", std::string("ban")))
			                       .add_choice(dpp::command_option_choice("Softban", std::string("softban")))
			                       .add_choice(dpp::command_option_choice("Disabled", std::string("disabled"))));
			command.add_option(dpp::command_option(dpp::co_channel, "log_channel",
			                                       "The channel to log actions in (if ommited, then it won't log anywhere)",
			                                       false)
			                       .add_channel_type(dpp::CHANNEL_TEXT)
			                       .add_channel_type(dpp::CHANNEL_PUBLIC_THREAD)
			                       .add_channel_type(dpp::CHANNEL_PRIVATE_THREAD));
			bot.global_bulk_command_create({command});
		}
	});

	// Handle the /honeypot-set command.
	bot.on_slashcommand([db](const dpp::slashcommand_t& event) {
		if (event.command.get_command_name() != "honeypot-set") {
			event.reply(dpp::message("Unknown command").set_flags(dpp::m_ephemeral));
			return;
		}
		if (event.command.guild_id.empty()) {
			return;
		}

		auto it = event.command.resolved.member_permissions.find(event.command.usr.id);
		if (it == event.command.resolved.member_permissions.end() ||
		    !it->second.can(dpp::p_ban_members, dpp::p_manage_channels)) {
			event.reply(dpp::message("You don't have permission to use this command.").set_flags(dpp::m_ephemeral));
			return;
		}

		dpp::snowflake channel = std::get<dpp::snowflake>(event.get_parameter("channel"));
		std::string action = std::get<std::string>(event.get_parameter("action"));
		dpp::snowflake log_channel = 0;
		if (std::holds_alternative<dpp::snowflake>(event.get_parameter("log_channel"))) {
			log_channel = std::get<dpp::snowflake>(event.get_parameter("log_channel"));
		}

		if (action == "disabled") {
			// "disabled" removes the config instead of updating it.
			delete_config_by_guild(db, event.command.guild_id.str());
			event.reply("Honeypot configuration updated: Disabled honeypot for this server.");
			return;
		}

		upsert_config(db, event.command.guild_id.str(), channel.str(), action,
		              log_channel.empty() ? std::optional<std::string>{} : std::optional<std::string>{log_channel.str()});

		std::string reply = "Honeypot configuration updated: Will **" + action + "** anyone who types in <#" +
		                    channel.str() + "> " +
		                    (log_channel.empty() ? std::string("and won't log actions")
		                                         : "and log actions to <#" + log_channel.str() + ">") +
		                    ".";
		event.reply(reply);
	});

	// Ban anyone who messages in the configured honeypot channel.
	bot.on_message_create([&bot, db](const dpp::message_create_t& event) {
		const dpp::message& msg = event.msg;
		if (msg.guild_id.empty() || msg.author.is_bot()) {
			return;
		}

		Honeypot hp = load_config(db, msg.guild_id.str());
		if (!hp.found || hp.channel_id != msg.channel_id.str()) {
			return;
		}

		if (hp.action == "ban") {
			bot.set_audit_reason("User typed in #honeypot channel -> ban");
			bot.guild_ban_add(msg.guild_id, msg.author.id, 3600,
			                  [&bot, msg, hp](const dpp::confirmation_callback_t& cb) {
				                  if (cb.is_error()) {
					                  std::cerr << "Failed honeypot action (ban): " << cb.get_error().message << std::endl;
					                  send_log(bot, hp, msg, false);
				                  } else {
					                  send_log(bot, hp, msg, true);
				                  }
			                  });
		} else if (hp.action == "softban") {
			bot.set_audit_reason("User typed in #honeypot channel -> softban (1/2)");
			bot.guild_ban_add(msg.guild_id, msg.author.id, 3600,
			                  [&bot, msg, hp](const dpp::confirmation_callback_t& cb) {
				                  if (cb.is_error()) {
					                  std::cerr << "Failed honeypot action (softban): " << cb.get_error().message
					                            << std::endl;
					                  send_log(bot, hp, msg, false);
					                  return;
				                  }
				                  bot.set_audit_reason("User typed in #honeypot channel -> softban (2/2)");
				                  bot.guild_ban_delete(msg.guild_id, msg.author.id,
				                                       [&bot, msg, hp](const dpp::confirmation_callback_t& cb) {
					                                       if (cb.is_error()) {
						                                       std::cerr << "Failed honeypot action (softban): "
						                                                 << cb.get_error().message << std::endl;
						                                       send_log(bot, hp, msg, false);
					                                       } else {
						                                       send_log(bot, hp, msg, true);
					                                       }
				                                       });
			                  });
		} else {
			std::cerr << "Failed honeypot action (" << hp.action << "): Unknown honeypot action: " << hp.action << std::endl;
			send_log(bot, hp, msg, false);
		}
	});

	// Clean up config when a channel or guild goes away.
	bot.on_channel_delete([db](const dpp::channel_delete_t& event) {
		delete_config_by_channel(db, event.deleted.id.str());
	});
	bot.on_guild_delete([db](const dpp::guild_delete_t& event) {
		delete_config_by_guild(db, event.guild_id.str());
	});

	bot.start(dpp::st_wait);
	return 0;
}
