"""API routes — handlers in panel.application."""
from flask import Blueprint
from panel import application as core

bp = Blueprint('agents', __name__)

bp.add_url_rule('/api/agent/profiles', view_func=core.agent_profiles, methods=['GET'])
bp.add_url_rule('/api/agent/default-ingest', view_func=core.agent_default_ingest, methods=['GET'])
bp.add_url_rule('/api/agent/enrollment-tokens', view_func=core.agent_enrollment_tokens, methods=['GET'])
bp.add_url_rule('/api/agent/enrollment-token', view_func=core.agent_enrollment_token_create, methods=['POST'])
bp.add_url_rule('/api/agent/enrollment-token/revoke', view_func=core.agent_enrollment_token_revoke, methods=['POST'])
bp.add_url_rule('/api/agent/install/<raw_token>.sh', view_func=core.agent_install_script, methods=['GET'])
bp.add_url_rule('/api/agent/install/<raw_token>.ps1', view_func=core.agent_install_script_ps1, methods=['GET'])
bp.add_url_rule('/api/agent/uninstall/<raw_token>.ps1', view_func=core.agent_uninstall_script_ps1, methods=['GET'])
bp.add_url_rule('/api/agent/activate', view_func=core.agent_activate, methods=['POST'])
bp.add_url_rule('/api/agent/uninstall-notify', view_func=core.agent_uninstall_notify, methods=['POST'])
bp.add_url_rule('/api/agent/heartbeat', view_func=core.agent_heartbeat, methods=['POST'])
bp.add_url_rule('/api/agent/nodes', view_func=core.agent_nodes, methods=['GET'])
bp.add_url_rule('/api/agent/nodes/repair-from-tokens', view_func=core.agent_nodes_repair_from_tokens, methods=['POST'])
bp.add_url_rule('/api/agent/onboarding-history', view_func=core.agent_onboarding_history, methods=['GET'])
bp.add_url_rule('/api/agent/fleet-overview', view_func=core.agent_fleet_overview, methods=['GET'])
bp.add_url_rule('/api/agent/fleet-host-detail', view_func=core.agent_fleet_host_detail, methods=['GET'])
bp.add_url_rule('/api/agent/fleet-node/hide-from-list', view_func=core.agent_fleet_node_hide_from_list, methods=['POST'])
bp.add_url_rule('/api/agent/fleet-node/unhide-from-list', view_func=core.agent_fleet_node_unhide_from_list, methods=['POST'])
bp.add_url_rule('/api/agent/self-test/instructions', view_func=core.agent_self_test_instructions, methods=['GET'])
bp.add_url_rule('/api/agent/self-test/status', view_func=core.agent_self_test_status, methods=['GET'])
