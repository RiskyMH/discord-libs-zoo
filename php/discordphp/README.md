# DiscordPHP Honeypot Bot

A small Discord honeypot bot built with [DiscordPHP](https://discord-php.github.io/DiscordPHP/). Configure a channel with `/honeypot-set`; anyone who messages in it gets banned. Config is stored in SQLite.

## Requirements

- PHP 8.4+
- [Composer](https://getcomposer.org/)

## Build

```sh
composer install
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
php bot.php
```

## Docker

```sh
docker build -t discordphp-honeypot .
docker run -e DISCORD_TOKEN=your-bot-token -e DB_PATH=/data/bot.db -v discordphp-data:/data discordphp-honeypot
```

`DISCORD_TOKEN` is required. `DB_PATH` defaults to `/data/bot.db` in the image (shown above for clarity); the SQLite DB lives in the `/data` volume so it survives restarts.
