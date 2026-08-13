FROM rust:1.97-slim-bookworm AS build

WORKDIR /build

COPY Cargo.toml Cargo.lock ./
COPY src ./src

RUN cargo build --release

FROM debian:bookworm-slim

RUN apt-get update && apt-get install -y ca-certificates && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY --from=build /build/target/release/serenity-honeypot ./

RUN mkdir -p /data
ENV DB_PATH=/data/bot.db
VOLUME ["/data"]

CMD ["./serenity-honeypot"]
