"""Flask before_request kancaları."""
from panel.application import _enforce_panel_setup_gate


def register_hooks(application):
    application.before_request(_enforce_panel_setup_gate)
