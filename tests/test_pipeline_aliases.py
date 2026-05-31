"""Pipeline alias rules presence in create-ecs-pipeline.sh."""
from __future__ import annotations

import unittest
from pathlib import Path

PIPELINE = Path(__file__).resolve().parents[1] / "src" / "services" / "graylog" / "create-ecs-pipeline.sh"

REQUIRED_RULES = [
    "Stage0 Set tenant_id",
    "Stage0 Set host_name flat",
    "Stage0 Set agent_ip",
    "Stage0 Set host.os.type linux",
    "Stage6 Vendor discovery fallback",
    "Stage6 Ensure host.os.type default",
    "Stage1 Windows 4625 auth failure",
    "Stage0 Map severity from level",
]


class TestPipelineAliases(unittest.TestCase):
    def test_required_rules_exist(self):
        text = PIPELINE.read_text(encoding="utf-8")
        for rule in REQUIRED_RULES:
            self.assertIn(rule, text, rule)

    def test_pipeline_stages_include_tenant_rules(self):
        text = PIPELINE.read_text(encoding="utf-8")
        self.assertIn('rule "Stage0 Set tenant_id default";', text)
        self.assertIn('rule "Stage6 Vendor discovery fallback";', text)


if __name__ == "__main__":
    unittest.main()
