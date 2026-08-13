# DPP Honeypot Bot

A small Discord honeypot bot built with [DPP](https://dpp.dev/). Configure a channel with `/honeypot-set`; anyone who messages in it gets banned. Config is stored in SQLite.

## Requirements

- CMake 3.16+
- A C++20 compiler
- OpenSSL
- zlib
- SQLite3

`DPP` is fetched automatically via FetchContent.

## Build

```sh
mkdir build
cd build
cmake ..
cmake --build .
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
./build/honeypot
```

## Docker

```sh
docker build -t dpp-honeypot .
docker run -e DISCORD_TOKEN=your-bot-token -e DB_PATH=/data/bot.db -v dpp-data:/data dpp-honeypot
```

`DISCORD_TOKEN` is required. `DB_PATH` defaults to `/data/bot.db` in the image (shown above for clarity); the SQLite DB lives in the `/data` volume so it survives restarts.
