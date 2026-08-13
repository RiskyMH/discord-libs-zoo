# Discord Libs Zoo

Equivalent Discord honeypot bots, one per library, for easy side-by-side comparison.

## The Example Bot

Every implementation is the same small honeypot bot:

- `/honeypot-set` configures the honeypot channel
- messages in that channel trigger a ban (or softban)
- config is stored in SQLite
- optional log channel
- runs with Docker

The goal is to see how different libraries solve the same problem, not to build a full moderation bot.

## Implementations

| Language | Library | Example |
| --- | --- | --- |
| JavaScript / TypeScript | [discord.js](https://discord.js.org/) | [javascript/discord.js](./javascript/discord.js) |
| JavaScript / TypeScript | [@discordjs/core](https://discord.js.org/) | [javascript/discordjs-core](./javascript/discordjs-core) |
| JavaScript / TypeScript | [Dressed](https://dressed.js.org/) | [javascript/dressed](./javascript/dressed) |
| JavaScript / TypeScript | [Discordeno](https://discordeno.js.org/) | [javascript/discordeno](./javascript/discordeno) |
| Python | [discord.py](https://discordpy.readthedocs.io/) | [python/discord.py](./python/discord.py) |
| Go | [DiscordGo](https://github.com/bwmarrin/discordgo) | [go/discordgo](./go/discordgo) |
| Rust | [Twilight](https://twilight.rs/) | [rust/twilight](./rust/twilight) |
| Rust | [Serenity](https://serenity-rs.github.io/serenity/) | [rust/serenity](./rust/serenity) |
| Java | [JDA](https://jda.wiki/) | [java/jda](./java/jda) |
| C++ | [DPP](https://dpp.dev/) | [cpp/dpp](./cpp/dpp) |
| C++ | [MeowLib](https://git.girlsmell.xyz/luna/MeowLib/) | [cpp/meowlib](./cpp/meowlib) |
| C# | [Discord.Net](https://discordnet.dev/) | [csharp/discord.net](./csharp/discord.net) |
| Kotlin | [Kord](https://kordlib.github.io/kord/) | [kotlin/kord](./kotlin/kord) |
| PHP | [DiscordPHP](https://discord-php.github.io/DiscordPHP/) | [php/discordphp](./php/discordphp) |

## Reference Implementation

[discord.js](./javascript/discord.js) is the reference. New implementations should match it as closely as their library allows:

- same commands
- same database schema
- same behaviour
- same environment variables
- same Docker workflow

[discordjs-core](./javascript/discordjs-core) is the low-level alternative: raw REST payloads, no SlashCommandBuilder, and a small `hasPermission` helper. When another library lacks high-level builders, treat it as the fallback and copy how it does things raw.

Small differences are expected where conventions differ, but the goal is comparison, not redesign. Anything a library can't express is documented as a comment in the code.

## Environment Variables

- `DISCORD_TOKEN` — required
- `DB_PATH` — optional, defaults to `bot.db`

No implementation auto-loads a `.env` file.

## Docker

Every image defaults `DB_PATH` to `/data/bot.db` and stores the database in a `/data` volume so it survives restarts:

```sh
docker build -t <name>-honeypot .
docker run -e DISCORD_TOKEN=your-bot-token -e DB_PATH=/data/bot.db -v <name>-data:/data <name>-honeypot
```

## Related Projects

- [Honeypot](https://github.com/RiskyMH/honeypot) — production Discord honeypot bot
- [Honeypot Lite](https://github.com/RiskyMH/honeypot-lite) — smaller Rust implementation focused on performance

```
Discord Libs Zoo
    Small equivalent examples
              |
              v
Honeypot Lite
    Minimal serious implementation
              |
              v
Honeypot
    Production bot with additional complexity
```

## Contributing

New implementations are welcome. A good one:

- uses a maintained Discord library
- implements the same feature set
- follows the reference implementation where practical
- uses the normal tooling for its ecosystem (npm, Cargo, go.mod, etc.)
- includes setup instructions and Docker support

Avoid:

- adding unrelated bot features
- making an implementation significantly more complex
- introducing frameworks that hide the Discord library

The best examples are the ones where opening two folders makes the difference between the libraries obvious.
