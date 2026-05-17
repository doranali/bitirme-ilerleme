"""Kimlik doğrulama route'ları."""
from flask import Blueprint

from panel import application as core

bp = Blueprint('auth', __name__)

bp.add_url_rule('/login', view_func=core.login, methods=['GET', 'POST'])
bp.add_url_rule('/logout', view_func=core.logout, methods=['GET', 'POST'])
bp.add_url_rule('/api/auth/me', view_func=core.auth_me, methods=['GET'])
