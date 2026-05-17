"""API routes — handlers in panel.application."""
from flask import Blueprint
from panel import application as core

bp = Blueprint('audit', __name__)

bp.add_url_rule('/api/audit/events', view_func=core.get_audit_events, methods=['GET'])
