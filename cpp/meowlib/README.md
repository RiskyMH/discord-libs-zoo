# MeowLib Honeypot Bot

A small Discord honeypot bot built with [MeowLib](https://git.girlsmell.xyz/luna/MeowLib). Configure a channel with `/honeypot-set`; anyone who messages in it gets banned. Config is stored in SQLite.

## Requirements

- CMake 3.25+
- A C++23 compiler
- nlohmann_json
- SQLite3
- OpenSSL

`meowHttp` and `MeowLib` are fetched automatically via FetchContent for local builds. The Docker build instead installs both libraries and configures with `-DMEOWLIB_USE_INSTALLED=ON`.

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
docker build -t meowlib-honeypot .
docker run -e DISCORD_TOKEN=your-bot-token -e DB_PATH=/data/bot.db -v meowlib-data:/data meowlib-honeypot
```

`DISCORD_TOKEN` is required. `DB_PATH` defaults to `/data/bot.db` in the image (shown above for clarity); the SQLite DB lives in the `/data` volume so it survives restarts.
