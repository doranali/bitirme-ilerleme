"""Ana panel sayfası."""
from flask import Blueprint

from panel import application as core

bp = Blueprint('pages', __name__)

bp.add_url_rule('/', view_func=core.index, methods=['GET'])
