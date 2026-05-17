"""API routes — handlers in panel.application."""
from flask import Blueprint
from panel import application as core

bp = Blueprint('ops', __name__)

bp.add_url_rule('/api/backup', view_func=core.backup, methods=['POST'])
bp.add_url_rule('/api/ops/summary', view_func=core.ops_summary, methods=['GET'])
bp.add_url_rule('/api/observability/metrics', view_func=core.observability_metrics, methods=['GET'])
bp.add_url_rule('/api/release/status', view_func=core.release_status, methods=['GET'])
bp.add_url_rule('/api/ops/sanity', view_func=core.ops_sanity, methods=['POST'])
bp.add_url_rule('/api/ops/flow-test', view_func=core.ops_flow_test, methods=['POST'])
bp.add_url_rule('/api/ops/stream-repair', view_func=core.ops_stream_repair, methods=['POST'])
bp.add_url_rule('/api/ops/apply-opensearch-ism', view_func=core.ops_apply_opensearch_ism, methods=['POST'])
bp.add_url_rule('/api/dependencies/<path:config_type>', view_func=core.get_dependencies)
bp.add_url_rule('/api/validate', view_func=core.validate, methods=['POST'])
bp.add_url_rule('/api/pipeline/status', view_func=core.pipeline_status, methods=['GET'])
bp.add_url_rule('/api/simulation/status', view_func=core.simulation_status_deprecated, methods=['GET'])
bp.add_url_rule('/api/simulation/control', view_func=core.simulation_control, methods=['POST'])
bp.add_url_rule('/api/container-logs', view_func=core.get_container_logs, methods=['GET'])
