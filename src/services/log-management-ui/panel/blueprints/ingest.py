"""API routes — handlers in panel.application."""
from flask import Blueprint
from panel import application as core

bp = Blueprint('ingest', __name__)

bp.add_url_rule('/api/ingest/syslog-sources-summary', view_func=core.ingest_syslog_sources_summary, methods=['GET'])
bp.add_url_rule('/api/security/syslog-trusted-sources', view_func=core.get_syslog_trusted_sources, methods=['GET'])
bp.add_url_rule('/api/security/syslog-trusted-sources', view_func=core.set_syslog_trusted_sources, methods=['POST'])
bp.add_url_rule('/api/ingest/syslog-drilldown', view_func=core.ingest_syslog_drilldown, methods=['GET'])
