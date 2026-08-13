FROM node:24-alpine

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY ./src ./src

RUN mkdir -p /data
ENV DB_PATH=/data/bot.db
VOLUME ["/data"]

CMD ["node", "--run", "start"]
