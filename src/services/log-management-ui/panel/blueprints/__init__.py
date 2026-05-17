"""Blueprint kayıt."""
from flask import Flask

from panel.blueprints.auth import bp as auth_bp
from panel.blueprints.pages import bp as pages_bp
from panel.blueprints.setup import bp as setup_bp

# API / işlev grupları — route gövdeleri panel.application içinde kalır
from panel.blueprints.settings import bp as settings_bp
from panel.blueprints.services_ops import bp as services_ops_bp
from panel.blueprints.storage import bp as storage_bp
from panel.blueprints.archive import bp as archive_bp
from panel.blueprints.agents import bp as agents_bp
from panel.blueprints.ingest import bp as ingest_bp
from panel.blueprints.normalization import bp as normalization_bp
from panel.blueprints.ops import bp as ops_bp
from panel.blueprints.users_bp import bp as users_bp
from panel.blueprints.audit import bp as audit_bp
from panel.blueprints.k8s import bp as k8s_bp
from panel.blueprints.performance import bp as performance_bp


def register_blueprints(app: Flask) -> None:
    for bp in (
        auth_bp,
        pages_bp,
        setup_bp,
        settings_bp,
        services_ops_bp,
        storage_bp,
        archive_bp,
        agents_bp,
        ingest_bp,
        normalization_bp,
        ops_bp,
        users_bp,
        audit_bp,
        k8s_bp,
        performance_bp,
    ):
        app.register_blueprint(bp)
