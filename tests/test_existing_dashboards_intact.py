"""SOC dashboards unchanged query baseline."""
from __future__ import annotations

import json
import unittest
from pathlib import Path

DASHBOARDS = Path(__file__).resolve().parents[1] / 'src' / 'services' / 'grafana' / 'dashboards'


class TestExistingDashboardsIntact(unittest.TestCase):
    def test_overview_has_tenant_variable(self):
        path = DASHBOARDS / '00-soc-overview.json'
        self.assertTrue(path.exists())
        doc = json.loads(path.read_text(encoding='utf-8'))
        names = [v.get('name') for v in doc.get('templating', {}).get('list', [])]
        self.assertIn('tenant_id', names)

    def test_soc_dashboards_have_nav_tags(self):
        for path in sorted(DASHBOARDS.glob('*.json')):
            if path.name == 'normalization-slo.json':
                continue
            doc = json.loads(path.read_text(encoding='utf-8'))
            tags = doc.get('tags') or []
            self.assertIn('soc', tags, msg=path.name)


if __name__ == '__main__':
    unittest.main()
