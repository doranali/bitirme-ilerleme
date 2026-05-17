"""API routes — handlers in panel.application."""
from flask import Blueprint
from panel import application as core

bp = Blueprint('archive', __name__)

bp.add_url_rule('/api/archive/status', view_func=core.archive_status, methods=['GET'])
bp.add_url_rule('/api/archive/retention', view_func=core.archive_retention_info, methods=['GET'])
