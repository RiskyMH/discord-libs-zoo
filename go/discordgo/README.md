# DiscordGo Honeypot Bot

A small Discord honeypot bot built with [DiscordGo](https://github.com/bwmarrin/discordgo). Configure a channel with `/honeypot-set`; anyone who messages in it gets banned. Config is stored in SQLite.

## Requirements

- Go 1.24+

## Build

```sh
go build -o bin/honeypot .
```

## Configure

Pass the env vars directly (no `.env` file is auto-loaded):

```sh
export DISCORD_TOKEN=your-bot-token
export DB_PATH=bot.db # optional, defaults to bot.db
```

`DISCORD_TOKEN` is required. `DB_PATH` defaults to `bot.db`.

## Run

```sh
go run .
```

Or run the built binary:

```sh
./bin/honeypot
```

## Docker

```sh
docker build -t discordgo-honeypot .
docker run -e DISCORD_TOKEN=your-bot-token -e DB_PATH=/data/bot.db -v discordgo-data:/data discordgo-honeypot
```

`DISCORD_TOKEN` is required. `DB_PATH` defaults to `/data/bot.db` in the image (shown above for clarity); the SQLite DB lives in the `/data` volume so it survives restarts.
