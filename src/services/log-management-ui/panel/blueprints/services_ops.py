"""API routes — handlers in panel.application."""
from flask import Blueprint
from panel import application as core

bp = Blueprint('services_ops', __name__)

bp.add_url_rule('/api/services', view_func=core.api_services)
bp.add_url_rule('/api/platform', view_func=core.api_platform)
bp.add_url_rule('/api/config/<path:config_type>', view_func=core.get_config, methods=['GET'])
bp.add_url_rule('/api/config/diff', view_func=core.config_diff, methods=['POST'])
bp.add_url_rule('/api/config/<path:config_type>', view_func=core.update_config, methods=['POST'])
bp.add_url_rule('/api/service/<service_name>/<action>', view_func=core.control_service, methods=['POST'])
bp.add_url_rule('/api/scale/<service_name>', view_func=core.scale_service, methods=['POST'])
bp.add_url_rule('/api/health', view_func=core.health)
bp.add_url_rule('/api/services/storage', view_func=core.api_services_storage, methods=['GET'])
