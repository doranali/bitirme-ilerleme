#!/usr/bin/env python3
"""Grafana alerting webhook → merkezi bildirim dispatcher."""
from __future__ import annotations

import json
import os
import subprocess
import sys
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, HTTPServer

LISTEN_HOST = os.environ.get("WEBHOOK_HOST", "0.0.0.0")
LISTEN_PORT = int(os.environ.get("WEBHOOK_PORT", "9009"))
NOTIFY_SCRIPT = os.environ.get("NOTIFY_SCRIPT", "/app/notify_dispatch.sh")
NOTIFY_URL = os.environ.get(
    "NOTIFY_DISPATCH_URL",
    "http://log-management-ui:8080/api/internal/alerts/dispatch",
)
NOTIFY_SECRET = os.environ.get("NOTIFY_INTERNAL_SECRET", "")


def _grafana_severity(payload: dict) -> str:
    text = json.dumps(payload, ensure_ascii=False).lower()
    if "critical" in text:
        return "critical"
    if "warning" in text or "alerting" in text:
        return "warning"
    return "warning"


def _grafana_title_body(payload: dict) -> tuple[str, str]:
    alerts = payload.get("alerts") if isinstance(payload, dict) else None
    if isinstance(alerts, list) and alerts:
        first = alerts[0] if isinstance(alerts[0], dict) else {}
        title = str(first.get("labels", {}).get("alertname") or first.get("title") or "Grafana Alert")
        body = str(first.get("annotations", {}).get("summary") or first.get("message") or "")
        status = str(first.get("status") or "")
        if status:
            body = f"Durum: {status}\n{body}".strip()
        return title[:200], body[:2500]
    trimmed = json.dumps(payload, ensure_ascii=False)[:3000]
    return "Grafana Alert", trimmed


def dispatch_grafana(payload_bytes: bytes) -> int:
    try:
        payload = json.loads(payload_bytes.decode("utf-8", errors="replace") or "{}")
    except Exception:
        payload = {"raw": payload_bytes.decode("utf-8", errors="replace")[:3000]}
    severity = _grafana_severity(payload if isinstance(payload, dict) else {})
    title, body = _grafana_title_body(payload if isinstance(payload, dict) else {})

    if NOTIFY_URL and NOTIFY_SECRET:
        data = json.dumps(
            {
                "severity": severity,
                "category": "grafana",
                "title": title,
                "body": body,
                "tags": ["grafana", "alert"],
            },
            ensure_ascii=False,
        ).encode("utf-8")
        req = urllib.request.Request(
            NOTIFY_URL,
            data=data,
            method="POST",
            headers={
                "Content-Type": "application/json",
                "X-Notify-Secret": NOTIFY_SECRET,
            },
        )
        try:
            with urllib.request.urlopen(req, timeout=20) as resp:
                return 0 if 200 <= resp.status < 300 else 1
        except urllib.error.HTTPError as exc:
            return 0 if 200 <= exc.code < 300 else 1
        except Exception:
            # Fallback below if the local shell bridge exists.
            pass

    if not os.path.isfile(NOTIFY_SCRIPT):
        return 1
    proc = subprocess.run(
        [
            "/bin/sh",
            NOTIFY_SCRIPT,
            severity,
            "grafana",
            title,
            body,
            "grafana,alert",
        ],
        capture_output=True,
        text=True,
        check=False,
    )
    return 0 if proc.returncode == 0 else 1


class Handler(BaseHTTPRequestHandler):
    def _send(self, code: int, body: bytes):
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == "/health":
            self._send(200, b'{"status":"ok"}')
            return
        self._send(404, b'{"status":"not_found"}')

    def do_POST(self):
        if self.path != "/grafana":
            self._send(404, b'{"status":"not_found"}')
            return

        length = int(self.headers.get("Content-Length", "0"))
        payload = self.rfile.read(length)

        if dispatch_grafana(payload) == 0:
            self._send(200, b'{"status":"forwarded"}')
            return
        self._send(500, b'{"status":"dispatch_error"}')


if __name__ == "__main__":
    server = HTTPServer((LISTEN_HOST, LISTEN_PORT), Handler)
    server.serve_forever()
