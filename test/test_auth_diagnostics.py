"""Diagnostic evidence must survive restarts without copying secrets."""

import asyncio
import json
import logging
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace

from yarl import URL

from xiaomusic.auth import AuthManager
from xiaomusic.auth_diagnostics import AuthDiagnostics, SDKAuthLogFilter


class AuthDiagnosticsTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.secret = "private-credential-sentinel-9b8d"
        self.diagnostics = AuthDiagnostics(self.root)
        self.addCleanup(self.diagnostics.close)

    def records(self):
        return [json.loads(line) for line in self.diagnostics.path.read_text().splitlines()]

    def test_unknown_payload_fields_are_not_serialized(self):
        self.diagnostics.emit("test_event", error_type="RuntimeError",
                              password=self.secret, token=self.secret, cookie=self.secret,
                              response={"passToken": self.secret}, url="https://example.com/" + self.secret)
        text = self.diagnostics.path.read_text()
        self.assertNotIn(self.secret, text)
        self.assertNotIn("response", self.records()[-1])

    def test_http_failure_keeps_endpoint_status_and_correlation_without_query(self):
        trace = self.diagnostics.trace_config()
        context = SimpleNamespace()
        url = URL("https://api2.mina.mi.com/admin/v2/device_list?serviceToken=" + self.secret)

        async def run():
            with self.diagnostics.operation():
                await trace.on_request_start[0](None, context, SimpleNamespace(url=url))
                await trace.on_request_end[0](None, context, SimpleNamespace(
                    url=url, response=SimpleNamespace(status=401)
                ))

        asyncio.run(run())
        event = self.records()[-1]
        self.assertEqual(event["endpoint"], "/admin/v2/device_list")
        self.assertEqual(event["http_status"], 401)
        self.assertTrue(event["chain_id"])
        self.assertNotIn(self.secret, self.diagnostics.path.read_text())

    def test_failed_sdk_login_records_server_code_and_cache_deletion(self):
        cache = self.root / ".mi.token"
        cache.write_text(json.dumps({"passToken": self.secret}))
        manager = object.__new__(AuthManager)
        manager.config = SimpleNamespace(conf_path=str(self.root))
        manager._auth_diagnostics = self.diagnostics
        account = SimpleNamespace(token={"passToken": self.secret, "deviceId": self.secret}, now_ua="old")

        async def service(uri, data=None):
            account.now_ua = "new"
            return {"code": 70016, "description": self.secret, "_sign": self.secret,
                    "captchaUrl": "https://example.com/" + self.secret, "securityStatus": 1}

        async def login(sid):
            await account._serviceLogin("serviceLogin?sid=" + sid + "&extra=" + self.secret)
            account.token = None
            cache.unlink()
            return False

        account.login = login
        account._serviceLogin = service
        manager._instrument_account(account)
        self.assertFalse(asyncio.run(account.login("micoapi")))
        records = self.records()
        result = next(item for item in records if item["event"] == "service_login_result")
        end = next(item for item in records if item["event"] == "login_finished")
        self.assertEqual(result["api_code"], 70016)
        self.assertTrue(result["has_captcha"])
        self.assertTrue(result["user_agent_changed"])
        self.assertTrue(end["cache_file_removed"])
        self.assertFalse(end["after"]["pass_token_present"])
        self.assertEqual(result["chain_id"], end["chain_id"])
        self.assertNotIn(self.secret, self.diagnostics.path.read_text())

    def test_journal_survives_new_diagnostic_instance_and_is_private(self):
        self.diagnostics.emit("before_restart")
        self.diagnostics.close()
        second = AuthDiagnostics(self.root)
        self.addCleanup(second.close)
        second.emit("after_restart")
        events = [item["event"] for item in self.records()]
        self.assertIn("before_restart", events)
        self.assertIn("after_restart", events)
        self.assertEqual(self.diagnostics.path.stat().st_mode & 0o777, 0o600)
        self.assertEqual(self.diagnostics.path.parent.stat().st_mode & 0o777, 0o700)

    def test_request_and_automatic_relogin_share_chain_and_show_identity_loss(self):
        cache = self.root / ".mi.token"
        cache.write_text(self.secret)
        manager = object.__new__(AuthManager)
        manager.config = SimpleNamespace(conf_path=str(self.root))
        manager.log = logging.getLogger("test")
        manager._auth_diagnostics = self.diagnostics
        account = SimpleNamespace(token={"passToken": self.secret, "micoapi": [self.secret, self.secret]})

        async def login(sid):
            cache.unlink()
            return False

        async def request(sid, url, data, headers, relogin=True):
            account.token = None
            await account.login(sid)
            raise RuntimeError("Login failed " + self.secret)

        account.login = login
        account.mi_request = request
        manager._patch_account(account)
        with self.assertRaises(RuntimeError):
            asyncio.run(account.mi_request("micoapi", "https://api2.mina.mi.com/admin/v2/device_list?token=" + self.secret,
                                           {"password": self.secret}, {}, False))
        events = self.records()
        start = next(item for item in events if item["event"] == "service_request_started")
        login_start = next(item for item in events if item["event"] == "login_started")
        finish = next(item for item in events if item["event"] == "login_finished")
        self.assertTrue(start["before"]["pass_token_present"])
        self.assertFalse(login_start["before"]["pass_token_present"])
        self.assertTrue(finish["cache_file_removed"])
        self.assertEqual(start["chain_id"], login_start["chain_id"])
        self.assertNotIn(self.secret, self.diagnostics.path.read_text())

    def test_rotation_keeps_bounded_private_files(self):
        other = AuthDiagnostics(self.root / "rotated", max_bytes=400, backups=2)
        self.addCleanup(other.close)
        for _ in range(20):
            other.emit("rotation_test", error_type="RuntimeError")
        files = list(other.path.parent.glob("auth-events.jsonl*"))
        self.assertLessEqual(len(files), 3)
        self.assertTrue(all(path.stat().st_mode & 0o777 == 0o600 for path in files))

    def test_sdk_filter_removes_raw_arguments_and_exception_text(self):
        record = logging.LogRecord("miservice.miaccount", logging.ERROR, "", 0,
                                   "Login failed %s", (self.secret,), None)
        record.exc_text = self.secret
        self.assertTrue(SDKAuthLogFilter().filter(record))
        self.assertNotIn(self.secret, record.getMessage())
        self.assertIsNone(record.exc_text)
        self.assertTrue(any(isinstance(item, SDKAuthLogFilter)
                            for item in logging.getLogger("miservice").filters))


if __name__ == "__main__":
    unittest.main()
