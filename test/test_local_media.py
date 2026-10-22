"""Local-only policy regression tests; never contact Xiaomi or a speaker."""

import asyncio
import logging
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch
from urllib.parse import quote

from xiaomusic import local_media
from xiaomusic.config import Config


class LocalMediaTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name) / "music"
        self.root.mkdir()
        self.song = self.root / "中文 歌曲.mp3"
        self.song.write_bytes(b"local media")
        self.outside = Path(self.tmp.name) / "outside.mp3"
        self.outside.write_bytes(b"not allowed")
        self.patch = patch.object(local_media, "MEDIA_ROOT", self.root)
        self.patch.start()
        self.addCleanup(self.patch.stop)
        self.config = SimpleNamespace(
            hostname="http://192.168.100.99", public_port=8090
        )
        self.url = "http://192.168.100.99:8090/music/" + quote(self.song.name)

    def test_existing_local_file_and_url(self):
        self.assertEqual(local_media.require_media_file(self.song), self.song)
        self.assertEqual(
            local_media.require_media_url(self.url + "?key=test"),
            self.song,
        )

    def test_missing_outside_directory_and_non_media(self):
        metadata = self.root / "metadata.json"
        metadata.write_text("{}")
        for path in (self.root / "missing.mp3", self.outside, self.root, metadata):
            with self.subTest(path=path), self.assertRaises(PermissionError):
                local_media.require_media_file(path)

    def test_symlink_and_symlink_swap_are_rechecked(self):
        link = self.root / "link.mp3"
        link.symlink_to(self.song)
        self.assertEqual(local_media.require_media_file(link), self.song)
        link.unlink()
        link.symlink_to(self.outside)
        with self.assertRaises(PermissionError):
            local_media.require_media_file(link)

    def test_url_bypasses_are_rejected(self):
        for url in (
            "https://example.com/track.mp3",
            self.url.replace("8090", "8091"),
            self.url.replace("http:", "https:"),
            self.url.replace("192.168.100.99", "192.168.100.99.evil.test"),
            self.url.replace("http://", "http://user:pass@"),
            "http://192.168.100.99:8090/proxy?urlb64=abc",
            "http://192.168.100.99:8090/static/silence.mp3",
            "http://192.168.100.99:8090/music/%2e%2e/outside.mp3",
            "http://192.168.100.99:8090/music/%2Fetc/passwd",
            "file://" + str(self.song),
        ):
            with self.subTest(url=url), self.assertRaises(PermissionError):
                local_media.require_media_url(url)

    def test_alternate_http_media_paths_are_blocked(self):
        for path in (
            "/proxy",
            "/proxy/music",
            "/api/proxy/real-url",
            "/api/device/pushList",
            "/api/play/getMediaSource",
            "/downloadplaylist/",
            "/uploadmusic",
            "/debug_play_by_music_url",
            "/static/silence.mp3",
            "/updateversion",
        ):
            with self.subTest(path=path):
                self.assertTrue(local_media.blocked_media_request(path))
        for path in (
            "/",
            "/getsetting",
            "/musiclist",
            "/music/song.mp3",
            "/static/index.html",
        ):
            self.assertFalse(local_media.blocked_media_request(path))

    def test_settings_cannot_widen_root_or_enable_downloads(self):
        config = Config(music_path="/tmp", disable_download=False)
        config.update_config(
            {
                "music_path": "/etc",
                "hostname": "https://example.com",
                "public_port": 443,
                "disable_download": False,
                "music_list_json": '[{"url":"https://example.com"}]',
                "convert_to_mp3": True,
                "edge_tts_voice": "en-US-JennyNeural",
            }
        )
        self.assertEqual(config.music_path, "/vol2/1000/music")
        self.assertEqual(config.hostname, "http://192.168.100.99")
        self.assertEqual(config.public_port, 8090)
        self.assertTrue(config.disable_download)
        self.assertFalse(config.convert_to_mp3)
        self.assertEqual(config.edge_tts_voice, "disable")
        self.assertEqual(config.music_list_json, "")

    def test_scan_does_not_follow_directory_symlink_cycles(self):
        from xiaomusic.utils.file_utils import traverse_music_directory

        (self.root / "cycle").symlink_to(self.root, target_is_directory=True)
        (self.root / "outside").symlink_to(
            self.outside.parent, target_is_directory=True
        )
        found = traverse_music_directory(str(self.root), 10, set(), [".mp3"])
        self.assertEqual(
            [f for files in found.values() for f in files], [str(self.song)]
        )

    def test_catalog_filters_escape_and_ignores_network_playlists(self):
        from xiaomusic.music_library import MusicLibrary

        (self.root / "escape.mp3").symlink_to(self.outside)
        config = Config(hostname=self.config.hostname, public_port=self.config.public_port)
        config.music_path = str(self.root)
        config.music_list_json = '[{"name":"online","musics":[{"name":"remote","url":"https://example.com/song.mp3"}]}]'
        library = MusicLibrary(config, logging.getLogger("test"))
        with (
            patch("xiaomusic.music_library.MEDIA_ROOT", self.root),
            patch.object(library, "try_gen_all_music_tag"),
        ):
            library.gen_all_music_list()
            self.assertEqual(set(library.all_music), {self.song.stem})
            self.assertEqual(
                asyncio.run(library.get_music_url(self.song.stem))[0], self.url
            )
            library.all_music["remote"] = "https://example.com/song.mp3"
            self.assertEqual(asyncio.run(library.get_music_url("remote")), ("", None))

    def test_external_url_never_reaches_speaker(self):
        from xiaomusic.device_player import XiaoMusicDevice

        player = object.__new__(XiaoMusicDevice)
        player.config = self.config
        player.auth_manager = SimpleNamespace(mina_service=AsyncMock())
        with self.assertRaises(PermissionError):
            asyncio.run(
                player.play_one_url(
                    "test-device", "https://example.com/song.mp3", "song"
                )
            )
        player.auth_manager.mina_service.play_by_url.assert_not_awaited()
        player.auth_manager.mina_service.play_by_music_url.assert_not_awaited()

    def test_valid_url_reaches_speaker(self):
        from xiaomusic.device_player import XiaoMusicDevice

        player = object.__new__(XiaoMusicDevice)
        player.config = SimpleNamespace(
            **vars(self.config), continue_play=False, use_music_api=False
        )
        player.device = SimpleNamespace(hardware="test")
        player.log = logging.getLogger("test")
        player._get_audio_id = AsyncMock(return_value="test-id")
        player.auth_manager = SimpleNamespace(mina_service=AsyncMock())
        asyncio.run(player.play_one_url("test-device", self.url, "song"))
        player.auth_manager.mina_service.play_by_music_url.assert_awaited_once_with(
            "test-device", self.url
        )
        player.auth_manager.mina_service.play_by_url.assert_not_awaited()

    def test_file_route_rejects_escape_and_serves_local_source(self):

        from xiaomusic.api.dependencies import _state

        conf = Path(self.tmp.name) / "conf"
        conf.mkdir()
        with (
            patch.object(_state, "_config", Config(conf_path=str(conf))),
            patch.object(_state, "_log", logging.getLogger("test")),
        ):
            self._check_file_route()

    def _check_file_route(self):
        from fastapi import HTTPException

        from xiaomusic.api.routers.file import music_file

        with (
            patch("xiaomusic.api.routers.file.MEDIA_ROOT", self.root),
            patch(
                "xiaomusic.api.routers.file.access_key_verification", return_value=True
            ),
        ):
            response = asyncio.run(music_file(None, self.song.name))
            self.assertEqual(response.path, self.song)
            for path in ("../outside.mp3", "temp/secret.mp3"):
                with self.assertRaises(HTTPException) as caught:
                    asyncio.run(music_file(None, path))
                self.assertEqual(caught.exception.status_code, 404)


if __name__ == "__main__":
    unittest.main()
