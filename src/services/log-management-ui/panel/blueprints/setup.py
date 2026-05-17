"""İlk kurulum kilidi (K1/K2) route'ları."""
from flask import Blueprint

from panel import application as core

bp = Blueprint('setup', __name__)

bp.add_url_rule('/api/setup-readiness', view_func=core.setup_readiness, methods=['GET'])
bp.add_url_rule('/api/setup/gate', view_func=core.setup_gate_api, methods=['GET'])
bp.add_url_rule('/api/setup/ack', view_func=core.setup_ack_api, methods=['POST'])
bp.add_url_rule('/first-run', view_func=core.first_run_page, methods=['GET'])
