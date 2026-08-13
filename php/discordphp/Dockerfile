FROM php:8.4-cli-alpine

WORKDIR /app

# Install the PHP extensions DiscordPHP needs; pdo_sqlite powers the honeypot DB.
RUN apk add --no-cache oniguruma-dev sqlite-dev \
    && docker-php-ext-install bcmath mbstring pcntl pdo_sqlite posix

# Install composer.
COPY --from=composer:2 /usr/bin/composer /usr/bin/composer

COPY composer.json composer.lock ./
RUN composer install --no-dev --no-interaction --prefer-dist

COPY . .

RUN mkdir -p /data
ENV DB_PATH=/data/bot.db
VOLUME ["/data"]

CMD ["php", "bot.php"]
