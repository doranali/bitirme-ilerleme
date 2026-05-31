"""Static checks for Stage5 regex-based sanitize/normalize rules."""
from __future__ import annotations

import re
import unittest
from pathlib import Path

PIPELINE = Path(__file__).resolve().parents[1] / 'src' / 'services' / 'graylog' / 'create-ecs-pipeline.sh'


class TestPipelineRegexMatch(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.text = PIPELINE.read_text(encoding='utf-8')

    def _rule_line(self, title: str) -> str:
        pattern = rf'upsert_rule "{re.escape(title)}" "([^"]+)"'
        match = re.search(pattern, self.text)
        self.assertIsNotNone(match, msg=f'rule not found: {title}')
        return match.group(1)

    def test_event_category_no_null_compare(self):
        self.assertIn('Stage5 Sanitize event.category invalid', self.text)
        self.assertNotIn('event.category)) == null', self.text)
        self.assertIn('.matches != true', self.text)

    def test_event_outcome_no_null_compare(self):
        self.assertIn('Stage5 Normalize event.outcome invalid', self.text)
        self.assertNotIn('event.outcome)) == null', self.text)
        idx = self.text.find('Stage5 Normalize event.outcome invalid')
        self.assertIn('.matches != true', self.text[idx:idx + 600])

    def test_outcome_yes_and_failure_rules_unchanged(self):
        self.assertIn('Stage5 Normalize event.outcome yes', self.text)
        self.assertIn('Stage5 Normalize event.outcome failure tokens', self.text)


if __name__ == '__main__':
    unittest.main()
