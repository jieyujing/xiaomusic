"""Expired speaker sessions must not hammer the conversation endpoint."""

import asyncio
import logging
import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock, patch

from xiaomusic.conversation import ConversationPoller


class ConversationRecoveryTests(unittest.TestCase):
    def setUp(self):
        self.auth = SimpleNamespace(mina_service=None, cookie_jar=None)
        devices = SimpleNamespace(
            device_id_did={"cloud-device": "local-device"},
            get_did=Mock(return_value="local-device"),
            get_hardward=Mock(return_value="LX06"),
        )
        config = SimpleNamespace(enable_pull_ask=True, pull_ask_sec=1, get_ask_by_mina=False)
        self.poller = ConversationPoller(config, logging.getLogger("test"), self.auth, devices)
        self.poller.polling_event.set()

    def test_missing_login_pauses_network_polling(self):
        self.poller.get_latest_ask_from_xiaoai = AsyncMock()
        with patch("xiaomusic.conversation.asyncio.sleep", new=AsyncMock(side_effect=asyncio.CancelledError)) as sleep:
            with self.assertRaises(asyncio.CancelledError):
                asyncio.run(self.poller.poll_latest_ask(Mock()))
        self.poller.get_latest_ask_from_xiaoai.assert_not_awaited()
        sleep.assert_awaited_once_with(5)

    def test_polling_resumes_after_qr_restores_service(self):
        self.poller.get_latest_ask_from_xiaoai = AsyncMock(side_effect=asyncio.CancelledError)

        async def restore_login(seconds):
            self.auth.mina_service = object()

        with patch("xiaomusic.conversation.asyncio.sleep", new=AsyncMock(side_effect=restore_login)):
            with self.assertRaises(asyncio.CancelledError):
                asyncio.run(self.poller.poll_latest_ask(Mock()))
        self.poller.get_latest_ask_from_xiaoai.assert_awaited_once()
        self.assertIsNotNone(self.auth.mina_service)

    def test_bad_cookie_response_requests_one_throttled_reinitialization(self):
        session = SimpleNamespace(get=AsyncMock(return_value=SimpleNamespace(status=400)))
        self.poller._try_reinit = AsyncMock()
        asyncio.run(self.poller.get_latest_ask_from_xiaoai(session, "cloud-device"))
        self.assertEqual(session.get.await_count, 3)
        self.poller._try_reinit.assert_awaited_once_with("400错误")


if __name__ == "__main__":
    unittest.main()
