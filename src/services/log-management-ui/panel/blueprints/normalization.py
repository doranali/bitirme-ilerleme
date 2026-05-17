"""API routes — handlers in panel.application."""
from flask import Blueprint
from panel import application as core

bp = Blueprint('normalization', __name__)

bp.add_url_rule('/api/normalization/qc-samples', view_func=core.normalization_qc_samples, methods=['GET'])
bp.add_url_rule('/api/normalization/qc-field-candidates', view_func=core.normalization_qc_field_candidates, methods=['GET'])
bp.add_url_rule('/api/normalization/lookup-rows', view_func=core.normalization_lookup_rows, methods=['GET'])
bp.add_url_rule('/api/normalization/dry-run', view_func=core.normalization_dry_run, methods=['POST'])
bp.add_url_rule('/api/normalization/add-mapping', view_func=core.normalization_add_mapping, methods=['POST'])
bp.add_url_rule('/api/normalization/vendor-packs', view_func=core.get_vendor_packs, methods=['GET'])
bp.add_url_rule('/api/normalization/grok-test', view_func=core.normalization_grok_test, methods=['POST'])
bp.add_url_rule('/api/normalization/vendor-pack', view_func=core.add_vendor_pack, methods=['POST'])
bp.add_url_rule('/api/normalization/vendor-pack/<path:pack_id>', view_func=core.delete_vendor_pack, methods=['DELETE'])
