#!/usr/bin/env python3
import os
import subprocess
from http.server import BaseHTTPRequestHandler, HTTPServer

WATCHDOG_SCRIPT = os.environ.get("WATCHDOG_SCRIPT", "/app/telegram_watchdog.sh")
LISTEN_HOST = os.environ.get("WEBHOOK_HOST", "0.0.0.0")
LISTEN_PORT = int(os.environ.get("WEBHOOK_PORT", "9009"))


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

        try:
            result = subprocess.run(
                ["/bin/sh", WATCHDOG_SCRIPT, "--webhook"],
                input=payload,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                check=False,
            )
        except Exception:
            self._send(500, b'{"status":"bridge_error"}')
            return

        if result.returncode == 0:
            self._send(200, b'{"status":"forwarded"}')
            return

        self._send(500, b'{"status":"watchdog_error"}')


if __name__ == "__main__":
    server = HTTPServer((LISTEN_HOST, LISTEN_PORT), Handler)
    server.serve_forever()
