"""
İlk kurulum kilidi (K1/K2) — saf fonksiyonlar; Flask dışı test edilebilir.
"""
from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any, Callable


def is_prod_env(env_map: dict) -> bool:
    v = (env_map.get("LOG_SYSTEM_ENV") or "").strip().lower()
    return v in ("prod", "production")


def setup_gate_enabled(os_environ: dict, env_map: dict) -> bool:
    """
    LOG_SYSTEM_SETUP_GATE=1|true → açık.
    LOG_SYSTEM_SETUP_GATE=0|false → kapalı.
    Aksi halde: üretim ortamında (LOG_SYSTEM_ENV=prod) varsayılan açık.
    """
    raw = (os_environ.get("LOG_SYSTEM_SETUP_GATE") or "").strip().lower()
    if raw in ("0", "false", "no", "off"):
        return False
    if raw in ("1", "true", "yes", "on"):
        return True
    return is_prod_env(env_map)


def load_gate_state(path: Path) -> dict:
    if not path.exists():
        return {"version": 1, "acks": {}}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        if not isinstance(data, dict):
            return {"version": 1, "acks": {}}
        data.setdefault("version", 1)
        data.setdefault("acks", {})
        if not isinstance(data["acks"], dict):
            data["acks"] = {}
        return data
    except Exception:
        return {"version": 1, "acks": {}}


def save_gate_state(path: Path, data: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def _company_ok(env_map: dict) -> bool:
    c = (env_map.get("LOG_SYSTEM_COMPANY_ID") or env_map.get("COMPANY_ID") or "").strip()
    return bool(c) and c.lower() != "default"


def _public_endpoint_ok(env_map: dict) -> tuple[bool, str | None]:
    base = (env_map.get("LOG_PLATFORM_PUBLIC_BASE_URL") or "").strip()
    host = (env_map.get("LOG_PLATFORM_PUBLIC_HOST") or "").strip()
    if base:
        if is_prod_env(env_map) and not base.lower().startswith("https://"):
            return False, "Üretimde LOG_PLATFORM_PUBLIC_BASE_URL https:// ile başlamalıdır."
        try:
            from urllib.parse import urlparse

            u = urlparse(base)
            if not u.scheme or not u.netloc:
                return False, "LOG_PLATFORM_PUBLIC_BASE_URL geçerli bir URL olmalıdır."
        except Exception:
            return False, "LOG_PLATFORM_PUBLIC_BASE_URL çözümlenemedi."
        return True, None
    if host:
        if is_prod_env(env_map):
            sch = (env_map.get("LOG_PLATFORM_PUBLIC_SCHEME") or "https").strip().lower()
            if sch != "https":
                return False, "Üretimde kamuya açık adres için LOG_PLATFORM_PUBLIC_SCHEME=https kullanın."
        return True, None
    return False, "LOG_PLATFORM_PUBLIC_BASE_URL veya LOG_PLATFORM_PUBLIC_HOST tanımlanmalıdır."


def _dev_creds_ok(env_map: dict) -> tuple[bool, str | None]:
    if not is_prod_env(env_map):
        return True, None
    raw = str(env_map.get("DEV_DEFAULT_CREDENTIALS", "")).strip().lower()
    if raw in ("1", "true", "yes", "on"):
        return False, "Üretimde DEV_DEFAULT_CREDENTIALS kapatılmalıdır."
    return True, None


_COMPANY_PATTERN = re.compile(r"^[a-z0-9][a-z0-9_-]{0,60}[a-z0-9]$")


def validate_company_id(value: str) -> str | None:
    s = (value or "").strip().lower()
    if not s or s == "default":
        return "Kurum kodu default olamaz."
    if len(s) < 2:
        return "Kurum kodu en az 2 karakter olmalıdır."
    if not _COMPANY_PATTERN.match(s):
        return "Kurum kodu: küçük harf, rakam, tire veya alt çizgi; 2–64 karakter."
    return None


def validate_public_base_url(value: str, env_map: dict) -> str | None:
    v = (value or "").strip()
    if not v:
        return "Boş olamaz."
    if is_prod_env(env_map) and not v.lower().startswith("https://"):
        return "Üretimde https:// ile başlamalıdır."
    try:
        from urllib.parse import urlparse

        u = urlparse(v)
        if u.scheme not in ("http", "https") or not u.netloc:
            return "Geçerli http(s) URL girin."
    except Exception:
        return "URL biçimi geçersiz."
    return None


def evaluate_setup_gate(
    env_map: dict,
    state: dict,
    *,
    panel_admin_password_is_default: bool,
    trusted_syslog_lines: int,
    ingest_overall: str | None,
    storage_same_as_root: bool | None,
    storage_phase: str | None,
) -> dict[str, Any]:
    """
    Dönüş: k1Complete, k2Complete, k1Missing, k2Missing (id+message), optionalHints.
    """
    k1_missing: list[dict[str, str]] = []
    k2_missing: list[dict[str, str]] = []
    hints: list[str] = []

    if not _company_ok(env_map):
        k1_missing.append({"id": "LOG_SYSTEM_COMPANY_ID", "message": "LOG_SYSTEM_COMPANY_ID zorunlu ve 'default' olamaz."})

    ok_pub, pub_err = _public_endpoint_ok(env_map)
    if not ok_pub:
        k1_missing.append({"id": "LOG_PLATFORM_PUBLIC", "message": pub_err or "Kamuya açık adres eksik."})

    ok_dev, dev_err = _dev_creds_ok(env_map)
    if not ok_dev:
        k1_missing.append({"id": "DEV_DEFAULT_CREDENTIALS", "message": dev_err or "DEV_DEFAULT_CREDENTIALS kapatılmalı."})

    if panel_admin_password_is_default:
        k1_missing.append(
            {
                "id": "PANEL_ADMIN_PASSWORD",
                "message": "Panel admin hesabı varsayılan parolada; Kullanıcılar bölümünden veya aşağıdaki formdan değiştirin.",
            }
        )

    k1_complete = len(k1_missing) == 0

    # --- K2 ---
    ov = (ingest_overall or "unknown").lower()
    if ov == "down":
        k2_missing.append(
            {
                "id": "PIPELINE_HEALTH",
                "message": "Fluent Bit / Graylog sağlığı 'down'. Stack ayakta olana kadar bekleyin veya compose loglarına bakın.",
            }
        )
    elif ov == "unknown":
        k2_missing.append({"id": "PIPELINE_HEALTH", "message": "Ingest sağlığı okunamadı; Docker erişimini kontrol edin."})

    acks = (state.get("acks") or {}) if isinstance(state, dict) else {}
    same_root = storage_same_as_root is True
    phase = (storage_phase or "").lower()
    if same_root and phase != "bound":
        if not acks.get("data_on_root_ok"):
            k2_missing.append(
                {
                    "id": "STORAGE_ACK",
                    "message": "Veri dizini kök dosya sistemiyle aynı görünüyor. Üretim riski — onaylayın veya ayrı disk bağlayın.",
                }
            )

    if trusted_syslog_lines <= 0:
        if not acks.get("syslog_empty_ok"):
            k2_missing.append(
                {
                    "id": "SYSLOG_ACK",
                    "message": "Güvenilir syslog kaynağı yok; trafik düşebilir. Bilinçli olarak boş bırakıyorsanız onaylayın.",
                }
            )

    st = str(env_map.get("SIGNER_TYPE", "")).strip().upper()
    if st not in ("TUBITAK", "OPEN_SOURCE"):
        k2_missing.append({"id": "SIGNER_TYPE", "message": "SIGNER_TYPE OPEN_SOURCE veya TUBITAK olarak seçilmelidir."})
    elif st == "TUBITAK":
        tsa_url = str(env_map.get("TUBITAK_TSA_URL", "")).strip()
        if not tsa_url:
            k2_missing.append(
                {
                    "id": "TUBITAK_TSA_URL",
                    "message": "TÜBİTAK seçildi; Kamu SM TSA tam URL adresi (.env TUBITAK_TSA_URL) gerekli.",
                }
            )

    ad = str(env_map.get("ARCHIVE_DESTINATION", "local")).strip().lower()
    if not ad.startswith(("local", "minio:", "s3:", "sftp:")):
        k2_missing.append({"id": "ARCHIVE_DESTINATION", "message": "ARCHIVE_DESTINATION geçerli bir hedef olmalıdır (local, minio:, s3:, sftp:)."})

    k2_complete = len(k2_missing) == 0

    if k1_complete and not k2_complete:
        hints.append("K1 tamam; K2 için sağlık, depolama/syslog onayı ve imzalama hedefi gerekir.")
    elif not k1_complete:
        hints.append("Önce K1 (kimlik, dış adres, güvenlik) tamamlanmalıdır.")

    return {
        "k1Complete": k1_complete,
        "k2Complete": k2_complete,
        "gateSatisfied": k1_complete and k2_complete,
        "k1Missing": k1_missing,
        "k2Missing": k2_missing,
        "optionalHints": hints,
    }
