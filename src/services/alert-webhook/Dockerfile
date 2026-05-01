FROM python:3.12-alpine

WORKDIR /app

COPY src/scripts/monitoring/alert_webhook_server.py /app/alert_webhook_server.py
COPY src/scripts/monitoring/telegram_watchdog.sh /app/telegram_watchdog.sh

RUN chmod +x /app/telegram_watchdog.sh

EXPOSE 9009

CMD ["python", "/app/alert_webhook_server.py"]

