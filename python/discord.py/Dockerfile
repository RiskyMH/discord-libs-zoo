FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1

WORKDIR /app

RUN mkdir -p /data
ENV DB_PATH=/data/bot.db
VOLUME ["/data"]

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

CMD ["python", "bot.py"]
