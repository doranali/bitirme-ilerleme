"""Flask uygulama fabrikası ve route proxy."""
from __future__ import annotations

import os
from pathlib import Path

from flask import Flask
from flask_cors import CORS

from security_utils import configure_flask_security

UI_ROOT = Path(__file__).resolve().parent.parent
_flask_app: Flask | None = None


class _AppProxy:
    """panel.application içinde @app.route kullanımı için gecikmeli bağlama."""

    def route(self, rule: str, **options):
        return get_app().route(rule, **options)

    def before_request(self, f):
        return get_app().before_request(f)

    def __getattr__(self, name):
        return getattr(get_app(), name)


app = _AppProxy()


def get_app() -> Flask:
    if _flask_app is None:
        raise RuntimeError('Flask app not initialized; call create_app() first')
    return _flask_app


def create_app() -> Flask:
    global _flask_app
    if _flask_app is not None:
        return _flask_app

    application = Flask(
        __name__,
        template_folder=str(UI_ROOT / 'templates'),
        static_folder=str(UI_ROOT / 'static'),
    )
    application.secret_key = (
        os.environ.get('MANAGEMENT_UI_SECRET_KEY')
        or os.environ.get('SECRET_KEY')
        or os.urandom(48).hex()
    )
    CORS(application)
    configure_flask_security(application)
    _flask_app = application

    from panel.blueprints import register_blueprints
    register_blueprints(application)

    import panel.application  # noqa: F401 — kalan route kayıtları

    from panel.hooks import register_hooks
    register_hooks(application)

    panel.application.ensure_dev_admin()
    return application
