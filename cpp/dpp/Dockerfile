FROM debian:13-slim AS updated_debian
RUN apt-get update -y

FROM updated_debian AS build
RUN apt-get install -y git cmake build-essential libssl-dev zlib1g-dev libsqlite3-dev libzstd-dev ca-certificates

ADD ./ /bot
WORKDIR /bot/build
RUN cmake .. -DCMAKE_BUILD_TYPE=Release
RUN set -eu; \
    cpus=$(nproc); \
    mem_mb=$(awk '/MemTotal/ {print int($2/1024)}' /proc/meminfo); \
    jobs=$(awk -v c="$cpus" -v m="$mem_mb" 'BEGIN { j=int(m/2000); if (j < 1) j = 1; if (j > c) j = c; print j }'); \
    echo "Building with make -j${jobs} (cpus=${cpus}, mem=${mem_mb}MB)"; \
    make -j"$jobs"

FROM updated_debian AS run
RUN apt-get install -y libssl3 libsqlite3-0 zlib1g ca-certificates
COPY --from=build /bot/build/honeypot /bin

RUN useradd bot
RUN mkdir -p /data && chown bot:bot /data
ENV DB_PATH=/data/bot.db
VOLUME ["/data"]
WORKDIR /data
USER bot
CMD ["honeypot"]
