# Discord.py Honeypot Bot

A small Discord honeypot bot built with [discord.py](https://discordpy.readthedocs.io/). Configure a channel with `/honeypot-set`; anyone who messages in it gets banned. Config is stored in SQLite.

## Requirements

- Python 3.8+

## Install

```sh
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
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
python bot.py
```

## Docker

```sh
docker build -t discord.py-honeypot .
docker run -e DISCORD_TOKEN=your-bot-token -e DB_PATH=/data/bot.db -v discord.py-data:/data discord.py-honeypot
```

`DISCORD_TOKEN` is required. `DB_PATH` defaults to `/data/bot.db` in the image (shown above for clarity); the SQLite DB lives in the `/data` volume so it survives restarts.
