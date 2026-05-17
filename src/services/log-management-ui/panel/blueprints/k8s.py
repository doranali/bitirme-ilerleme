"""API routes — handlers in panel.application."""
from flask import Blueprint
from panel import application as core

bp = Blueprint('k8s', __name__)

bp.add_url_rule('/api/k8s/hpa', view_func=core.get_hpa_policies, methods=['GET'])
bp.add_url_rule('/api/k8s/hpa/<name>', view_func=core.update_hpa_policy, methods=['POST'])
bp.add_url_rule('/api/k8s/rollout/<deployment_name>/history', view_func=core.get_rollout_history, methods=['GET'])
bp.add_url_rule('/api/k8s/rollout/<deployment_name>/restart', view_func=core.rollout_restart, methods=['POST'])
bp.add_url_rule('/api/k8s/rollout/<deployment_name>/rollback', view_func=core.rollout_rollback, methods=['POST'])
