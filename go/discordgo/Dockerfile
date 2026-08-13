FROM golang:1.24-alpine AS build

WORKDIR /app

COPY go.mod go.sum ./
RUN go mod download

COPY . .

RUN CGO_ENABLED=0 go build -o /honeypot .

FROM alpine:latest

WORKDIR /app

COPY --from=build /honeypot /usr/local/bin/honeypot

RUN mkdir -p /data
ENV DB_PATH=/data/bot.db
VOLUME ["/data"]

CMD ["honeypot"]
