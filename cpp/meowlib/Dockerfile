FROM debian:13-slim AS updated_debian
RUN apt-get update -y

FROM updated_debian AS build_meowhttp
RUN apt-get install -y git cmake nlohmann-json3-dev libssl-dev build-essential
ADD https://git.girlsmell.xyz/luna/http-client.git /dependencies/http-client
WORKDIR /dependencies/http-client/build
RUN cmake ..
RUN make -j2 install

FROM build_meowhttp AS build_meowlib
ADD https://git.girlsmell.xyz/luna/MeowLib.git /dependencies/MeowLib
WORKDIR /dependencies/MeowLib/build
RUN cmake ..
RUN make -j2 install

FROM build_meowlib AS build
RUN apt-get install -y libsqlite3-dev
ADD ./ /bot
WORKDIR /bot/build
RUN cmake .. -DMEOWLIB_USE_INSTALLED=ON
RUN make -j2

FROM updated_debian AS run
# netbase provides /etc/services, which meowHttp's getaddrinfo(host, "https")
# relies on to resolve the https service name to port 443.
RUN apt-get install -y openssl sqlite3 ca-certificates netbase
COPY --from=build /bot/build/honeypot /bin

RUN useradd bot
RUN mkdir -p /data && chown bot:bot /data
ENV DB_PATH=/data/bot.db
VOLUME ["/data"]
WORKDIR /data
USER bot
CMD ["honeypot"]
