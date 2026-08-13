FROM gradle:8-jdk17 AS build

WORKDIR /app

COPY build.gradle.kts ./
COPY src ./src

RUN gradle build --no-daemon

FROM eclipse-temurin:17-jre

WORKDIR /app

COPY --from=build /app/build/libs/honeypot.jar ./app.jar

RUN mkdir -p /data
ENV DB_PATH=/data/bot.db
VOLUME ["/data"]

CMD ["java", "-jar", "app.jar"]
