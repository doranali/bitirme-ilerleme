"""API routes — handlers in panel.application."""
from flask import Blueprint
from panel import application as core

bp = Blueprint('settings', __name__)

bp.add_url_rule('/api/settings/catalog', view_func=core.get_settings_catalog, methods=['GET'])
bp.add_url_rule('/api/settings/update', view_func=core.update_setting, methods=['POST'])
bp.add_url_rule('/api/settings/post-check', view_func=core.settings_post_check, methods=['POST'])
bp.add_url_rule('/api/settings/impact/<key>', view_func=core.setting_impact, methods=['GET'])
