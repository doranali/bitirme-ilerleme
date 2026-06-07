FROM python:3.12-alpine

WORKDIR /app

COPY src/scripts/monitoring/alert_webhook_server.py /app/alert_webhook_server.py
COPY src/scripts/monitoring/notify_dispatch.sh /app/notify_dispatch.sh

RUN chmod +x /app/notify_dispatch.sh

EXPOSE 9009

CMD ["python", "/app/alert_webhook_server.py"]

