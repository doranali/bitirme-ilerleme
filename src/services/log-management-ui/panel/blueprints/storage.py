"""API routes — handlers in panel.application."""
from flask import Blueprint
from panel import application as core

bp = Blueprint('storage', __name__)

bp.add_url_rule('/api/storage/candidates', view_func=core.storage_candidates, methods=['GET'])
bp.add_url_rule('/api/storage/mount-status', view_func=core.storage_mount_status, methods=['GET'])
bp.add_url_rule('/api/storage/recommended-setup-plan', view_func=core.storage_recommended_setup_plan, methods=['GET'])
bp.add_url_rule('/api/storage/complete-recommended-setup', view_func=core.storage_complete_recommended_setup, methods=['POST'])
bp.add_url_rule('/api/storage/data-disk-grow-status', view_func=core.storage_data_disk_grow_status, methods=['GET'])
bp.add_url_rule('/api/storage/data-disk-grow', view_func=core.storage_data_disk_grow, methods=['POST'])
bp.add_url_rule('/api/storage/os-disk-grow-status', view_func=core.storage_os_disk_grow_status, methods=['GET'])
bp.add_url_rule('/api/storage/os-disk-grow', view_func=core.storage_os_disk_grow, methods=['POST'])
bp.add_url_rule('/api/storage/apply-profile', view_func=core.storage_apply_profile, methods=['POST'])
bp.add_url_rule('/api/storage/eligible-disks', view_func=core.storage_eligible_disks, methods=['GET'])
bp.add_url_rule('/api/storage/rescan-host-buses', view_func=core.storage_rescan_host_buses, methods=['POST'])
bp.add_url_rule('/api/storage/prepare-disk', view_func=core.storage_prepare_disk, methods=['POST'])
