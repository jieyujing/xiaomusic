"""Exercise QR route/auth-manager boundaries without Xiaomi network access."""

import asyncio
import importlib
import logging
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock, patch

from xiaomusic.api.dependencies import _state
from xiaomusic.config import Config


class QRAuthTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.config = Config(conf_path=self.tmp.name)
        self.auth = SimpleNamespace(init_all_data=AsyncMock(), mina_service=None)
        self.instance = SimpleNamespace(
            config=self.config, log=logging.getLogger("test"), auth_manager=self.auth
        )
        self.state_config = patch.object(_state, "_config", self.config)
        self.state_log = patch.object(_state, "_log", self.instance.log)
        self.state_instance = patch.object(_state, "_xiaomusic", self.instance)
        for p in (self.state_config, self.state_log, self.state_instance):
            p.start()
            self.addCleanup(p.stop)
        self.system = importlib.import_module("xiaomusic.api.routers.system")

    def test_mijia_success_does_not_hide_failed_speaker_login(self):
        client = Mock()
        client.get_qrcode.side_effect = [
            False,
            {"qr": "https://account.xiaomi.com/qr-test", "lp": "test-status"},
        ]

        async def no_poll(*args):
            return None

        with (
            patch.object(self.system, "mi_jia_api", client, create=True),
            patch.object(self.system, "MiJiaAPI", return_value=client),
            patch.object(self.system, "get_logint_status", no_poll),
        ):
            response = asyncio.run(self.system.get_qrcode())
        self.assertTrue(response["success"])
        self.assertFalse(response.get("already_logged_in", False))
        self.assertTrue(response["qrcode_url"])
        self.auth.init_all_data.assert_awaited()

    def test_verified_speaker_login_reports_device_count(self):
        client = Mock()
        client.get_qrcode.return_value = False
        self.auth.mina_service = SimpleNamespace(
            device_list=AsyncMock(return_value=[{"hardware": "LX06"}])
        )
        with (
            patch.object(self.system, "mi_jia_api", client, create=True),
            patch.object(self.system, "MiJiaAPI", return_value=client),
        ):
            response = asyncio.run(self.system.get_qrcode())
        self.assertTrue(response["already_logged_in"])
        self.assertEqual(response.get("device_count"), 1)
        self.auth.init_all_data.assert_awaited()

    def test_client_uses_current_persistent_config_path(self):
        client = Mock()
        client.get_qrcode.return_value = {"qr": "test-qr", "lp": "test-status"}
        self.auth.mina_service = None
        with (
            patch.object(self.system, "mi_jia_api", client, create=True),
            patch.object(self.system, "MiJiaAPI", return_value=client) as factory,
        ):
            asyncio.run(self.system.get_qrcode())
        self.assertTrue(
            factory.called,
            "QR route must bind to current configuration, not a stale import-time path",
        )
        path = factory.call_args.kwargs["auth_data_path"]
        self.assertEqual(Path(path), Path(self.tmp.name) / "auth.json")

    def test_poll_completion_reinitializes_speaker_auth(self):
        client = Mock()
        with patch.object(self.system, "mi_jia_api", client, create=True):
            asyncio.run(self.system.get_logint_status("test-status", client))
        client.get_logint_status.assert_called_once_with("test-status")
        self.auth.init_all_data.assert_awaited_once_with(force_login=True)


if __name__ == "__main__":
    unittest.main()
