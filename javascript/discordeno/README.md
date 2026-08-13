# Discordeno Honeypot Bot

A small Discord honeypot bot built with [Discordeno](https://discordeno.js.org/). Configure a channel with `/honeypot-set`; anyone who messages in it gets banned. Config is stored in SQLite.

## Requirements

- Node.js 24+

## Install

```sh
npm install
```

## Configure

`DISCORD_TOKEN` is required; `DB_PATH` is optional (defaults to `bot.db`). The bot does not load a `.env` file, so pass env vars directly:

```sh
DISCORD_TOKEN=your-bot-token node --run start
```

## Run

```sh
node --run start
```

## Docker

```sh
docker build -t discordeno-honeypot .
docker run -e DISCORD_TOKEN=your-bot-token -e DB_PATH=/data/bot.db -v discordeno-data:/data discordeno-honeypot
```

`DISCORD_TOKEN` is required. `DB_PATH` defaults to `/data/bot.db` in the image (shown above for clarity); the SQLite DB lives in the `/data` volume so it survives restarts.
