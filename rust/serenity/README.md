# Serenity Honeypot Bot

A small Discord honeypot bot built with [serenity](https://serenity-rs.github.io/serenity/). Configure a channel with `/honeypot-set`; anyone who messages in it gets banned. Config is stored in SQLite.

## Requirements

- Rust (edition 2021, Rust 1.75+)

## Build

```sh
cargo build
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
cargo run
```

This builds and runs `src/main.rs`.

## Docker

```sh
docker build -t serenity-honeypot .
docker run -e DISCORD_TOKEN=your-bot-token -e DB_PATH=/data/bot.db -v serenity-data:/data serenity-honeypot
```

`DISCORD_TOKEN` is required. `DB_PATH` defaults to `/data/bot.db` in the image (shown above for clarity); the SQLite DB lives in the `/data` volume so it survives restarts.
