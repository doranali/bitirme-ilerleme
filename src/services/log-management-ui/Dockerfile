FROM python:3.12-alpine

# curl + disk hazırlama araçları (runtime’da ephemeral konteynerde apk gerekmez; yavaş ağda takılmayı önler)
RUN ok=0; for i in 1 2 3; do apk add --no-cache curl parted e2fsprogs util-linux lvm2 gptfdisk && ok=1 && break; sleep 5; done; [ "$ok" = "1" ] || exit 1

WORKDIR /app

COPY src/services/log-management-ui/requirements.txt /app/requirements.txt
RUN pip install --no-cache-dir --timeout 120 -r /app/requirements.txt

COPY src/services/log-management-ui/ /app/

EXPOSE 8080

# Disk hazırlama (apk+mkfs) 10–20 dk sürebilir; 300s worker keser, panel «takılı» kalır.
CMD ["gunicorn", "--bind", "0.0.0.0:8080", "--workers", "2", "--threads", "4", "--timeout", "1200", "app:app"]
