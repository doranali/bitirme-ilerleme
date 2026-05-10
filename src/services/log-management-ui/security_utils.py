import os
import secrets
from functools import wraps
from pathlib import Path

from flask import jsonify, request, session


SAFE_METHODS = {'GET', 'HEAD', 'OPTIONS'}


def configure_flask_security(app):
    app.config['SESSION_COOKIE_HTTPONLY'] = True
    app.config['SESSION_COOKIE_SAMESITE'] = os.environ.get('SESSION_COOKIE_SAMESITE', 'Lax')
    app.config['SESSION_COOKIE_SECURE'] = os.environ.get('SESSION_COOKIE_SECURE', 'false').lower() == 'true'


def get_or_create_csrf_token():
    token = session.get('_csrf_token')
    if not token:
        token = secrets.token_urlsafe(32)
        session['_csrf_token'] = token
    return token


def validate_csrf_token(token):
    session_token = session.get('_csrf_token')
    if not session_token or not token:
        return False
    try:
        return secrets.compare_digest(str(session_token), str(token))
    except Exception:
        return False


def csrf_protect(view_func):
    @wraps(view_func)
    def wrapper(*args, **kwargs):
        if request.method in SAFE_METHODS:
            return view_func(*args, **kwargs)

        candidate = request.headers.get('X-CSRF-Token')
        if not candidate and request.is_json:
            payload = request.get_json(silent=True) or {}
            candidate = payload.get('csrf_token')
        if not candidate:
            candidate = request.form.get('csrf_token')

        if not validate_csrf_token(candidate):
            return jsonify({'error': 'CSRF token missing or invalid'}), 403
        return view_func(*args, **kwargs)

    return wrapper


def is_safe_config_path(config_type: str) -> bool:
    if not config_type or '\x00' in config_type:
        return False

    path_obj = Path(config_type)
    if path_obj.is_absolute():
        return False
    if '..' in path_obj.parts:
        return False
    return True
