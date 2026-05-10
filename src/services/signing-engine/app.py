import os
import subprocess
from datetime import datetime
from zoneinfo import ZoneInfo

from apscheduler.schedulers.background import BackgroundScheduler
from apscheduler.triggers.cron import CronTrigger
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

APP_TZ = os.environ.get("SIGNING_ENGINE_TZ", "Europe/Istanbul")
SIGNER_TYPE = os.environ.get("SIGNER_TYPE", "OPEN_SOURCE")
SCHEDULE_ENABLED = os.environ.get("SIGNING_ENGINE_SCHEDULE_ENABLED", "true").lower() == "true"

app = FastAPI(title="5651 Signing Engine", version="1.0.0")
scheduler = BackgroundScheduler(timezone=ZoneInfo(APP_TZ))


class SignRequest(BaseModel):
    target_date: str | None = None


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


@app.get("/health")
def health() -> dict:
    return {
        "status": "ok",
        "time": datetime.now(tz=ZoneInfo(APP_TZ)).isoformat(),
        "signer_type": SIGNER_TYPE,
        "schedule_enabled": SCHEDULE_ENABLED,
    }


@app.get("/providers")
def providers() -> dict:
    return {
        "available": ["TUBITAK", "OPEN_SOURCE"],
        "active": SIGNER_TYPE,
    }


@app.post("/sign")
def sign(req: SignRequest) -> dict:
    env_extra = {}
    if req.target_date:
        env_extra["SIGN_TARGET_DATE"] = req.target_date
    try:
        output = run_script("/scripts/compliance/sign_logs.sh", env_extra)
    except RuntimeError as exc:
        raise HTTPException(status_code=500, detail=str(exc))
    return {"status": "ok", "output": output}


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
