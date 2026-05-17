"""Panel sabitleri ve yol yapılandırması."""
from pathlib import Path

UI_ROOT = Path(__file__).resolve().parent.parent
BASE_DIR = Path('/app/config')

CONFIG_PATHS = {
    'docker-compose': BASE_DIR / 'docker-compose.yml',
    'fluent-bit': BASE_DIR / 'fluent-bit',
    'grafana_config': BASE_DIR / 'grafana_config',
    'scripts': BASE_DIR / 'scripts',
    'certs': BASE_DIR / 'certs',
    'env': BASE_DIR / '.env',
}
CONFIG_PATHS_HEALTH_REQUIRED = frozenset({'docker-compose', 'env'})
ENV_PATH = CONFIG_PATHS['env']
PANEL_SETUP_STATE_PATH = BASE_DIR / 'panel-setup-state.json'
