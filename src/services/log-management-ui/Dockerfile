FROM python:3.12-alpine

# curl + disk hazırlama araçları + openssl (5651 TSR sunucu doğrulaması: openssl ts -verify)
# ca-certificates: PUBLIC_TSA_TEST imzasını /etc/ssl/certs/ca-certificates.crt ile doğrulamak için.
RUN ok=0; for i in 1 2 3; do apk add --no-cache curl ca-certificates openssl parted e2fsprogs util-linux lvm2 gptfdisk && ok=1 && break; sleep 5; done; [ "$ok" = "1" ] || exit 1

WORKDIR /app

COPY src/services/log-management-ui/requirements.txt /app/requirements.txt
RUN pip install --no-cache-dir --timeout 120 -r /app/requirements.txt

# Runtime state must not ship in image (.dockerignore + explicit cleanup).
COPY src/services/log-management-ui/ /app/
RUN rm -f /app/config/users.yaml /app/config/audit/events.jsonl /app/config/data/tenants.json \
    && rm -rf /app/config/agent-fleet/* 2>/dev/null || true

EXPOSE 8080

# Disk hazırlama (apk+mkfs) 10–20 dk sürebilir; 300s worker keser, panel «takılı» kalır.
CMD ["gunicorn", "--bind", "0.0.0.0:8080", "--workers", "2", "--threads", "4", "--timeout", "1200", "app:app"]
