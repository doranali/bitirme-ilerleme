"""setup_gate modülü birim testleri (stdlib unittest)."""
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1] / "src" / "services" / "log-management-ui"
sys.path.insert(0, str(ROOT))

from setup_gate import (  # noqa: E402
    evaluate_setup_gate,
    setup_gate_enabled,
    validate_company_id,
    validate_public_base_url,
)


class TestSetupGate(unittest.TestCase):
    def test_enabled_off(self):
        self.assertFalse(setup_gate_enabled({"LOG_SYSTEM_SETUP_GATE": "0"}, {"LOG_SYSTEM_ENV": "prod"}))

    def test_enabled_on(self):
        self.assertTrue(setup_gate_enabled({"LOG_SYSTEM_SETUP_GATE": "1"}, {"LOG_SYSTEM_ENV": "dev"}))

    def test_default_prod(self):
        self.assertTrue(setup_gate_enabled({}, {"LOG_SYSTEM_ENV": "prod"}))

    def test_default_dev(self):
        self.assertFalse(setup_gate_enabled({}, {"LOG_SYSTEM_ENV": "dev"}))

    def test_k1_complete(self):
        env = {
            "LOG_SYSTEM_ENV": "prod",
            "LOG_SYSTEM_COMPANY_ID": "acme",
            "LOG_PLATFORM_PUBLIC_BASE_URL": "https://logs.acme.test",
            "DEV_DEFAULT_CREDENTIALS": "false",
        }
        st = evaluate_setup_gate(
            env,
            {"acks": {}},
            panel_admin_password_is_default=False,
            trusted_syslog_lines=1,
            ingest_overall="ok",
            storage_same_as_root=False,
            storage_phase="bound",
        )
        self.assertTrue(st["k1Complete"])

    def test_syslog_ack(self):
        env = {
            "LOG_SYSTEM_ENV": "prod",
            "LOG_SYSTEM_COMPANY_ID": "acme",
            "LOG_PLATFORM_PUBLIC_BASE_URL": "https://logs.acme.test",
            "DEV_DEFAULT_CREDENTIALS": "false",
            "SIGNER_TYPE": "OPEN_SOURCE",
            "ARCHIVE_DESTINATION": "local",
        }
        st = evaluate_setup_gate(
            env,
            {"acks": {}},
            panel_admin_password_is_default=False,
            trusted_syslog_lines=0,
            ingest_overall="ok",
            storage_same_as_root=False,
            storage_phase="bound",
        )
        self.assertTrue(any(m.get("id") == "SYSLOG_ACK" for m in st["k2Missing"]))
        st2 = evaluate_setup_gate(
            env,
            {"acks": {"syslog_empty_ok": True}},
            panel_admin_password_is_default=False,
            trusted_syslog_lines=0,
            ingest_overall="ok",
            storage_same_as_root=False,
            storage_phase="bound",
        )
        self.assertTrue(st2["k2Complete"])

    def test_tubitak_requires_tsa_url(self):
        env = {
            "LOG_SYSTEM_ENV": "prod",
            "LOG_SYSTEM_COMPANY_ID": "acme",
            "LOG_PLATFORM_PUBLIC_BASE_URL": "https://logs.acme.test",
            "DEV_DEFAULT_CREDENTIALS": "false",
            "SIGNER_TYPE": "TUBITAK",
            "ARCHIVE_DESTINATION": "local",
        }
        st = evaluate_setup_gate(
            env,
            {"acks": {}},
            panel_admin_password_is_default=False,
            trusted_syslog_lines=1,
            ingest_overall="ok",
            storage_same_as_root=False,
            storage_phase="bound",
        )
        self.assertTrue(any(m.get("id") == "TUBITAK_TSA_URL" for m in st["k2Missing"]))
        env["TUBITAK_TSA_URL"] = "http://tzd.kamusm.gov.tr/tsa"
        st2 = evaluate_setup_gate(
            env,
            {"acks": {}},
            panel_admin_password_is_default=False,
            trusted_syslog_lines=1,
            ingest_overall="ok",
            storage_same_as_root=False,
            storage_phase="bound",
        )
        self.assertFalse(any(m.get("id") == "TUBITAK_TSA_URL" for m in st2["k2Missing"]))

    def test_validate_company(self):
        self.assertIsNotNone(validate_company_id("default"))
        self.assertIsNone(validate_company_id("ab"))

    def test_https_prod_url(self):
        env = {"LOG_SYSTEM_ENV": "prod"}
        self.assertIsNotNone(validate_public_base_url("http://x.com", env))
        self.assertIsNone(validate_public_base_url("https://x.com", env))


if __name__ == "__main__":
    unittest.main()
