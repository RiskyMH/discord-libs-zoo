# JDA Honeypot Bot

A small Discord honeypot bot built with [JDA](https://jda.wiki/). Configure a channel with `/honeypot-set`; anyone who messages in it gets banned. Config is stored in SQLite.

## Requirements

- Java 17+
- Gradle

## Build

```sh
gradle build
```

This produces a runnable fat jar at `build/libs/honeypot.jar`.

## Configure

Pass the env vars directly (no `.env` file is auto-loaded):

```sh
export DISCORD_TOKEN=your-bot-token
export DB_PATH=bot.db # optional, defaults to bot.db
```

`DISCORD_TOKEN` is required. `DB_PATH` defaults to `bot.db`.

## Run

```sh
gradle run
```

Or run the built jar directly:

```sh
java -jar build/libs/honeypot.jar
```

## Docker

```sh
docker build -t jda-honeypot .
docker run -e DISCORD_TOKEN=your-bot-token -e DB_PATH=/data/bot.db -v jda-data:/data jda-honeypot
```

`DISCORD_TOKEN` is required. `DB_PATH` defaults to `/data/bot.db` in the image (shown above for clarity); the SQLite DB lives in the `/data` volume so it survives restarts.
