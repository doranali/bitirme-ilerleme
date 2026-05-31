"""Static checks for split severity pipeline rules."""
from __future__ import annotations

import unittest
from pathlib import Path

PIPELINE = Path(__file__).resolve().parents[1] / 'src' / 'services' / 'graylog' / 'create-ecs-pipeline.sh'

SEVERITY_RULES = [
    'Stage0 Map severity low from level',
    'Stage0 Map severity medium from level',
    'Stage0 Map severity high from level',
    'Stage0 Map severity critical from level',
    'Stage0 Map severity low from priority',
    'Stage0 Map severity medium from priority',
    'Stage0 Map severity high from priority',
    'Stage0 Map severity critical from priority',
]


class TestPipelineSeveritySplit(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.text = PIPELINE.read_text(encoding='utf-8')

    def test_old_if_ternary_rules_removed(self):
        self.assertNotIn('upsert_rule "Stage0 Map severity from level"', self.text)
        self.assertNotIn('upsert_rule "Stage0 Map severity from priority"', self.text)
        self.assertNotIn('if(lv <= 3', self.text)
        self.assertNotIn('if(pv <= 3', self.text)

    def test_all_split_rules_defined(self):
        for title in SEVERITY_RULES:
            self.assertIn(f'upsert_rule "{title}"', self.text, msg=f'missing upsert for {title}')

    def test_pipeline_stage_lists_split_rules(self):
        stage_block = self.text.split('pipeline "ECS Normalization Pipeline"')[1]
        for title in SEVERITY_RULES:
            self.assertIn(f'rule "{title}";', stage_block, msg=f'missing stage ref for {title}')

    def test_delete_old_rules_present(self):
        self.assertIn('delete_rule_if_exists "Stage0 Map severity from level"', self.text)
        self.assertIn('delete_rule_if_exists "Stage0 Map severity from priority"', self.text)

    def test_stage5_in_dedicated_match_all_stage(self):
        block = self.text.split('pipeline "ECS Normalization Pipeline"')[1]
        idx = block.find('stage 7 match')
        self.assertNotEqual(idx, -1, 'stage 7 missing')
        stage7 = block[idx:block.find('stage 8 match', idx)]
        self.assertIn('Stage5 Sanitize event.category invalid', stage7)
        self.assertIn('Stage5 Normalize event.outcome invalid', stage7)


if __name__ == '__main__':
    unittest.main()
