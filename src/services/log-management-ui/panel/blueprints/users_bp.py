"""API routes — handlers in panel.application."""
from flask import Blueprint
from panel import application as core

bp = Blueprint('users_bp', __name__)

bp.add_url_rule('/api/users', view_func=core.list_users, methods=['GET'])
bp.add_url_rule('/api/users', view_func=core.upsert_user, methods=['POST'])
