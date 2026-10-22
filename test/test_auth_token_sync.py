"""Regression tests for QR credentials overwriting newer SDK login tokens."""

import asyncio
import json
import logging
import os
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock, patch

from xiaomusic.auth import AuthManager
from xiaomusic.config import Config


class TokenSyncTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.auth_path = self.root / "auth.json"
        self.auth_path.write_text(
            json.dumps(
                {
                    "userId": "test-user",
                    "passToken": "old-qr-pass",
                    "deviceId": "test-device",
                    "serviceToken": "mijia-service",
                }
            )
        )
        self.cached = {
            "userId": "test-user",
            "passToken": "new-sdk-pass",
            "deviceId": "test-device",
            "micoapi": ["security", "speaker-service"],
        }
        self.token_path = self.root / ".mi.token"
        self.token_path.write_text(json.dumps(self.cached))
        os.utime(self.auth_path, (100, 100))
        os.utime(self.token_path, (200, 200))
        self.manager = object.__new__(AuthManager)
        self.manager.config = Config(conf_path=self.tmp.name)
        self.manager.log = logging.getLogger("test")
        self.manager.device_id = "test-device"
        self.manager.mi_token_home = str(self.token_path)

    def tearDown(self):
        diagnostics = getattr(self.manager, "_auth_diagnostics", None)
        if diagnostics:
            diagnostics.close()

    def test_newer_same_account_sdk_token_is_preserved(self):
        account = SimpleNamespace(token=self.cached.copy())
        self.manager.set_token(account)
        self.assertEqual(account.token["passToken"], "new-sdk-pass")
        self.assertIn("micoapi", account.token)

    def test_device_timeout_does_not_relogin_or_clear_cached_service(self):
        account = SimpleNamespace(
            token=self.cached.copy(),
            mi_request=AsyncMock(side_effect=RuntimeError("code 101: 远程控制超时 code 3012")),
            login=AsyncMock(return_value=False),
            session=SimpleNamespace(cookie_jar=Mock()),
        )
        sdk_login = account.login
        self.manager._patch_account(account)
        with self.assertRaisesRegex(RuntimeError, "3012"):
            asyncio.run(account.mi_request("micoapi", "/remote/ubus", {}, {}))
        sdk_login.assert_not_awaited()
        account.session.cookie_jar.clear.assert_not_called()
        self.assertEqual(account.token, self.cached)

    def test_new_qr_scan_can_replace_older_sdk_token(self):
        os.utime(self.auth_path, (300, 300))
        account = SimpleNamespace(token=self.cached.copy())
        self.manager.set_token(account)
        self.assertEqual(account.token["passToken"], "old-qr-pass")
        self.assertNotIn("micoapi", account.token)

    def test_other_account_cache_never_wins(self):
        account = SimpleNamespace(token={**self.cached, "userId": "other-user"})
        self.manager.set_token(account)
        self.assertEqual(account.token["userId"], "test-user")

    def test_successful_sdk_login_updates_persistent_qr_identity(self):
        manager = self.manager
        manager.mi_session = Mock()
        manager._patch_account = Mock()
        account = SimpleNamespace(token=None)

        async def sdk_login(sid):
            account.token = {**self.cached, "passToken": "rotated-sdk-pass"}
            return True

        account.login = AsyncMock(side_effect=sdk_login)
        with (
            patch("xiaomusic.auth.MiAccount", return_value=account),
            patch("xiaomusic.auth.MiNAService"),
            patch("xiaomusic.auth.MiIOService"),
        ):
            self.assertTrue(asyncio.run(manager.login_miboy()))
        stored = json.loads(self.auth_path.read_text())
        self.assertEqual(stored["passToken"], "rotated-sdk-pass")
        self.assertEqual(stored["serviceToken"], "mijia-service")

    def test_valid_cached_speaker_service_skips_password_relogin(self):
        manager = self.manager
        manager.mi_session = Mock()
        manager._patch_account = Mock()
        manager._consecutive_failures = 0
        manager._try_fresh_session_and_relogin = AsyncMock(return_value=False)
        account = SimpleNamespace(
            token=self.cached.copy(),
            mi_request=AsyncMock(),
            login=AsyncMock(return_value=False),
        )
        service = SimpleNamespace(
            device_list=AsyncMock(return_value=[{"hardware": "LX06"}])
        )
        sdk_login = account.login
        with (
            patch("xiaomusic.auth.MiAccount", return_value=account),
            patch("xiaomusic.auth.MiNAService", return_value=service),
            patch("xiaomusic.auth.MiIOService"),
        ):
            self.assertTrue(asyncio.run(manager.login_miboy()))
        sdk_login.assert_not_awaited()
        service.device_list.assert_awaited_once()

    def test_rejected_cached_service_falls_back_to_fresh_identity(self):
        manager = self.manager
        manager.mi_session = Mock()
        manager._patch_account = Mock()
        account = SimpleNamespace(token=self.cached.copy(), mi_request=AsyncMock())

        async def login(sid):
            account.token = {**self.cached, "passToken": "fresh-pass"}
            return True

        account.login = AsyncMock(side_effect=login)
        sdk_login = account.login
        service = SimpleNamespace(
            device_list=AsyncMock(side_effect=RuntimeError("expired service"))
        )
        with (
            patch("xiaomusic.auth.MiAccount", return_value=account),
            patch("xiaomusic.auth.MiNAService", return_value=service),
            patch("xiaomusic.auth.MiIOService"),
        ):
            self.assertTrue(asyncio.run(manager.login_miboy()))
        sdk_login.assert_awaited_once_with("micoapi")


if __name__ == "__main__":
    unittest.main()
