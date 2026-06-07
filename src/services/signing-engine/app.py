import os
import subprocess
from datetime import datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

from apscheduler.schedulers.background import BackgroundScheduler
from apscheduler.triggers.cron import CronTrigger
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

APP_TZ = os.environ.get("SIGNING_ENGINE_TZ", "Europe/Istanbul")
SIGNER_TYPE = os.environ.get("SIGNER_TYPE", "OPEN_SOURCE")
SCHEDULE_ENABLED = os.environ.get("SIGNING_ENGINE_SCHEDULE_ENABLED", "false").lower() == "true"
WORM_STORAGE = Path(os.environ.get("WORM_STORAGE", "/fluent-bit/worm_storage"))

app = FastAPI(title="5651 Signing Engine", version="1.0.0")
scheduler = BackgroundScheduler(timezone=ZoneInfo(APP_TZ))


class SignRequest(BaseModel):
    target_date: str | None = None
    force: bool = False


def _imzali_arsiv_root() -> Path:
    return Path(os.environ.get("IMZALI_ARSIV", "/fluent-bit/arsiv_imzali"))


def _manifest_path(target_date: str) -> Path:
    return _imzali_arsiv_root() / target_date / f"data-{target_date}.manifest.json"


def _default_sign_date() -> str:
    tz = ZoneInfo(APP_TZ)
    return (datetime.now(tz=tz) - timedelta(days=1)).strftime("%Y-%m-%d")


def _resolve_sign_date(req: SignRequest) -> str:
    return (req.target_date or _default_sign_date()).strip()


def run_script(script_path: str, env_extra: dict | None = None) -> str:
    """Run repo shell scripts with bash (sign_logs.sh etc. use bashisms: pipefail, ${VAR^^}, date -d)."""
    env = os.environ.copy()
    if env_extra:
        env.update(env_extra)
    result = subprocess.run(
        ["bash", script_path],
        env=env,
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        error_text = result.stderr.strip() or result.stdout.strip() or "unknown error"
        raise RuntimeError(error_text)
    return result.stdout.strip()


def schedule_jobs() -> None:
    if not SCHEDULE_ENABLED:
        return
    scheduler.add_job(
        lambda: run_script("/scripts/compliance/sign_logs.sh"),
        CronTrigger(hour=0, minute=1),
        id="sign-logs",
        replace_existing=True,
    )
    scheduler.add_job(
        lambda: run_script("/scripts/compliance/send_daily_report.sh"),
        CronTrigger(hour=1, minute=0),
        id="daily-report",
        replace_existing=True,
    )
    scheduler.add_job(
        lambda: run_script("/scripts/ops/backup_configs.sh"),
        CronTrigger(day_of_week="sun", hour=2, minute=0),
        id="weekly-backup",
        replace_existing=True,
    )


@app.on_event("startup")
def on_startup() -> None:
    schedule_jobs()
    scheduler.start()


@app.on_event("shutdown")
def on_shutdown() -> None:
    scheduler.shutdown(wait=False)


def _worm_immutable_state(max_days: int = 14) -> dict:
    """Son imzalı günlerde WORM dosyalarında chattr +i oranı."""
    if not WORM_STORAGE.is_dir():
        return {"checked": 0, "immutable": 0, "ok": None, "message": "worm_storage missing"}
    checked = immutable = 0
    for day_dir in sorted(WORM_STORAGE.iterdir(), reverse=True)[:max_days]:
        if not day_dir.is_dir():
            continue
        for gz in day_dir.glob("data-*.log.gz"):
            checked += 1
            try:
                proc = subprocess.run(
                    ["lsattr", "-d", str(gz)],
                    capture_output=True,
                    text=True,
                    timeout=5,
                )
                if proc.returncode == 0 and "i" in (proc.stdout or "").split()[0]:
                    immutable += 1
            except Exception:
                pass
    ok = checked == 0 or immutable == checked
    return {
        "checked": checked,
        "immutable": immutable,
        "ok": ok,
        "message": None if ok else f"{checked - immutable} WORM file(s) lack chattr +i",
    }


@app.get("/health")
def health() -> dict:
    worm = _worm_immutable_state()
    return {
        "status": "ok",
        "time": datetime.now(tz=ZoneInfo(APP_TZ)).isoformat(),
        "signer_type": SIGNER_TYPE,
        "schedule_enabled": SCHEDULE_ENABLED,
        "worm_immutable_state": worm,
    }


@app.get("/providers")
def providers() -> dict:
    return {
        "available": ["TUBITAK", "TUBITAK_TEST", "PUBLIC_TSA_TEST", "OPEN_SOURCE"],
        "active": SIGNER_TYPE,
    }


@app.post("/sign")
def sign(req: SignRequest) -> dict:
    target = _resolve_sign_date(req)
    manifest = _manifest_path(target)
    if manifest.is_file() and not req.force:
        raise HTTPException(
            status_code=409,
            detail={
                "error": "already_signed",
                "message": f"{target} tarihi zaten imzalı; force=true veya RESIGN_ALLOWED=1 gerekir.",
                "manifest": str(manifest),
            },
        )
    env_extra = {"SIGN_TARGET_DATE": target}
    if req.force:
        env_extra["RESIGN_ALLOWED"] = "1"
    try:
        output = run_script("/scripts/compliance/sign_logs.sh", env_extra)
    except RuntimeError as exc:
        raise HTTPException(status_code=500, detail=str(exc))
    if "zaten imzalı" in output and "atlandı" in output:
        raise HTTPException(
            status_code=409,
            detail={
                "error": "already_signed",
                "message": output,
                "manifest": str(manifest),
            },
        )
    return {"status": "ok", "output": output, "target_date": target}


@app.post("/report")
def report() -> dict:
    try:
        output = run_script("/scripts/compliance/send_daily_report.sh")
    except RuntimeError as exc:
        raise HTTPException(status_code=500, detail=str(exc))
    return {"status": "ok", "output": output}


@app.post("/backup")
def backup() -> dict:
    try:
        output = run_script("/scripts/ops/backup_configs.sh")
    except RuntimeError as exc:
        raise HTTPException(status_code=500, detail=str(exc))
    return {"status": "ok", "output": output}
