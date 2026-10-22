"""Persistent, allowlisted authentication diagnostics. Never serialize credentials."""

import contextlib
import contextvars
import json
import logging
import os
import re
import time
import uuid
from datetime import datetime, timezone
from logging.handlers import RotatingFileHandler
from pathlib import Path
from urllib.parse import urlsplit

from aiohttp import TraceConfig

_CHAIN = contextvars.ContextVar("xiaomusic_auth_chain", default=None)
_FIELDS = {
    "phase", "sid", "endpoint", "host", "http_status", "api_code", "security_status",
    "error_type", "codes", "elapsed_ms", "success", "attempt", "force_login",
    "before", "after", "cache_file_removed", "pass_token_changed", "service_changed",
    "device_identity_changed", "has_captcha", "has_notification", "has_redirect",
    "user_agent_changed", "source", "reason", "cookie_count", "service_available",
    "account_configured", "password_configured",
    "response_identity_present", "response_pass_token_changed",
}
_STATE = {
    "token_present", "pass_token_present", "service_present", "user_id_present",
    "device_id_present", "cache_file_present", "cache_mtime", "qr_file_present", "qr_mtime",
}
_ENDPOINTS = {
    "/pass/serviceLogin", "/pass/serviceLoginAuth2", "/sts",
    "/admin/v2/device_list", "/remote/ubus", "/music/search",
}


def safe_endpoint(url):
    path = urlsplit(str(url)).path
    return path if path in _ENDPOINTS else "other"


def error_fields(exc):
    # Extract numeric error codes only; exceptions can contain whole credential responses.
    codes = re.findall(r"['\"]code['\"]\s*:\s*(-?\d+)(?=[,}\s])", str(exc))
    result = {"error_type": type(exc).__name__, "codes": [int(code) for code in codes[:8]]}
    status = getattr(exc, "status", None)
    if isinstance(status, int):
        result["http_status"] = status
    return result


class SDKAuthLogFilter(logging.Filter):
    def filter(self, record):
        # The SDK logs raw request payloads, login responses and tracebacks.
        if record.levelno < logging.WARNING:
            return False
        record.msg = "[XIAOMI-SDK] Authentication failure; see protected auth diagnostics"
        record.args = ()
        record.exc_info = record.exc_text = record.stack_info = None
        return True


class _PrivateRotatingHandler(RotatingFileHandler):
    def _open(self):
        fd = os.open(self.baseFilename, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
        os.fchmod(fd, 0o600)
        return os.fdopen(fd, "a", encoding="utf-8")


class AuthDiagnostics:
    def __init__(self, conf_path, max_bytes=2 * 1024 * 1024, backups=4):
        self.root = Path(conf_path)
        self.run_id = uuid.uuid4().hex[:12]
        self.path = self.root / "diagnostics" / "auth-events.jsonl"
        self.handler = None
        try:
            self.path.parent.mkdir(parents=True, mode=0o700, exist_ok=True)
            os.chmod(self.path.parent, 0o700)
            self.handler = _PrivateRotatingHandler(self.path, maxBytes=max_bytes, backupCount=backups)
            self.handler.setFormatter(logging.Formatter("%(message)s"))
        except OSError:
            pass  # Logging must never disable authentication or playback.
        for name in ("miservice", "miservice.miaccount"):
            sdk_log = logging.getLogger(name)
            if not any(isinstance(item, SDKAuthLogFilter) for item in sdk_log.filters):
                sdk_log.addFilter(SDKAuthLogFilter())
        self.emit("diagnostics_started")

    @contextlib.contextmanager
    def operation(self):
        token = _CHAIN.set(_CHAIN.get() or uuid.uuid4().hex[:12])
        try:
            yield
        finally:
            _CHAIN.reset(token)

    def emit(self, event, **fields):
        if self.handler is None:
            return
        payload = {
            "schema": 1, "time_utc": datetime.now(timezone.utc).isoformat(),
            "run_id": self.run_id, "chain_id": _CHAIN.get(), "event": event,
        }
        for key, value in fields.items():
            if key not in _FIELDS:
                continue
            if key in ("before", "after") and isinstance(value, dict):
                payload[key] = {k: v for k, v in value.items() if k in _STATE}
            elif key == "codes" and isinstance(value, list):
                payload[key] = [code for code in value if isinstance(code, int)]
            elif isinstance(value, (str, int, float, bool)) or value is None:
                payload[key] = value
        try:
            self.handler.handle(logging.LogRecord(
                "auth-diagnostics", logging.INFO, "", 0,
                json.dumps(payload, ensure_ascii=False), (), None,
            ))
        except (OSError, ValueError):
            pass

    def snapshot(self, account=None):
        token = getattr(account, "token", None) or {}
        state = {
            "token_present": bool(token), "pass_token_present": bool(token.get("passToken")),
            "service_present": bool(token.get("micoapi")), "user_id_present": bool(token.get("userId")),
            "device_id_present": bool(token.get("deviceId")),
        }
        for label, name in (("cache", ".mi.token"), ("qr", "auth.json")):
            try:
                state[label + "_mtime"] = (self.root / name).stat().st_mtime
                state[label + "_file_present"] = True
            except OSError:
                state[label + "_file_present"] = False
        return state

    def trace_config(self):
        trace = TraceConfig()

        async def start(session, context, params):
            context.started_at = time.perf_counter()

        def endpoint(params):
            host = params.url.host or ""
            if host not in ("api2.mina.mi.com", "account.xiaomi.com", "userprofile.mina.mi.com", "api.io.mi.com"):
                return {"host": "other", "endpoint": "other"}
            return {"host": host, "endpoint": safe_endpoint(params.url)}

        async def end(session, context, params):
            # Login phases are infrequent; record all. Other services only on HTTP errors.
            if params.response.status >= 400 or params.url.path.startswith("/pass/"):
                self.emit("http_result", **endpoint(params), http_status=params.response.status,
                          elapsed_ms=round((time.perf_counter() - context.started_at) * 1000, 1))

        async def failed(session, context, params):
            self.emit("http_error", **endpoint(params), **error_fields(params.exception))

        trace.on_request_start.append(start)
        trace.on_request_end.append(end)
        trace.on_request_exception.append(failed)
        return trace

    def close(self):
        if self.handler:
            self.handler.close()
