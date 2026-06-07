FROM python:3.12-alpine

# apk add retry: Alpine DNS/systemd-resolved sorunlarında build takılmasını önler (Bölüm 8)
RUN ok=0; for i in 1 2 3; do apk add --no-cache bash openssl rclone mongodb-tools curl e2fsprogs && ok=1 && break; sleep 5; done; [ "$ok" = "1" ] || exit 1

WORKDIR /app

COPY src/services/signing-engine/requirements.txt /app/requirements.txt
RUN pip install --no-cache-dir --timeout 120 -r /app/requirements.txt

COPY src/services/signing-engine/app.py /app/app.py
COPY src/scripts /scripts

RUN chmod +x /scripts/compliance/*.sh /scripts/ops/*.sh

EXPOSE 9080

CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "9080"]
