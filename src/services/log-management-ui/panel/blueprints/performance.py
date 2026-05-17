"""API routes — handlers in panel.application."""
from flask import Blueprint
from panel import application as core

bp = Blueprint('performance', __name__)

bp.add_url_rule('/api/performance/recommendations', view_func=core.performance_recommendations, methods=['GET'])
bp.add_url_rule('/api/performance/detect-ram', view_func=core.performance_detect_ram, methods=['GET'])
bp.add_url_rule('/api/performance/apply', view_func=core.performance_apply, methods=['POST'])
