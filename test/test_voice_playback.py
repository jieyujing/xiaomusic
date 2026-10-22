"""Replay recognized speech through the real router/player; all device I/O is mocked."""

import asyncio
import logging
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock, patch

from xiaomusic import local_media
from xiaomusic.config import Config
from xiaomusic.device_player import XiaoMusicDevice
from xiaomusic.music_library import MusicLibrary
from xiaomusic.utils import text_utils
from xiaomusic.voice_playback import is_now_playing_request, local_play_request
from xiaomusic.xiaomusic import XiaoMusic


class VoicePlaybackTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name) / "music"
        self.root.mkdir()
        self.song = self.root / "local-song.mp3"
        self.song.write_bytes(b"local")
        self.outside = Path(self.tmp.name) / "outside.mp3"
        self.outside.write_bytes(b"outside")
        p = patch.object(local_media, "MEDIA_ROOT", self.root)
        p.start()
        self.addCleanup(p.stop)
        self.app = object.__new__(XiaoMusic)
        self.app.log = logging.getLogger("test")
        self.app.command_handler = SimpleNamespace(
            last_cmd="", do_check_cmd=AsyncMock()
        )
        self.app.music_library = SimpleNamespace(
            all_music={"local-song": str(self.song)},
            find_real_music_name=Mock(return_value=[]),
            is_music_exist=Mock(return_value=False),
        )
        self.player = object.__new__(XiaoMusicDevice)
        self.player.xiaomusic = self.app
        self.player.log = self.app.log
        self.player.config = Config()
        self.player._pending_selection = None
        self.player._play_list = ["local-song"]
        self.player.device = SimpleNamespace(cur_playlist="全部", did="test-device")
        self.player.is_playing = True
        self.player.update_playlist = Mock()
        self.player.group_force_stop_xiaoai = AsyncMock()
        self.player.cancel_group_next_timer = AsyncMock()
        self.player._playmusic = AsyncMock()
        self.player.do_tts = AsyncMock()
        self.app.device_manager = SimpleNamespace(devices={"test-device": self.player})

    def test_media_request_parsing(self):
        for text, name in (
            ("播放歌曲晴天", "晴天"),
            ("播放故事西游记", "西游记"),
            ("继续播放植物大战僵尸故事", "植物大战僵尸故事"),
            ("继续播放", ""),
            ("播放不存在的故事", "不存在的故事"),
            ("请给我播放音乐晴天", "晴天"),
            ("讲个故事", ""),
            ("讲个恐龙的故事", "恐龙的故事"),
            ("讲一个小猪佩奇的故事", "小猪佩奇的故事"),
            ("小爱同学，请播放歌曲晴天", "晴天"),
            ("我想播放晴天", "晴天"),
            ("讲故事西游记", "西游记"),
            ("我想听晴天", "晴天"),
            ("播放", ""),
            ("播放音乐", ""),
        ):
            with self.subTest(text=text):
                self.assertEqual(local_play_request(text), name)

    def test_controls_and_playlists_keep_existing_routing(self):
        for text in (
            "暂停播放",
            "停止播放",
            "下一首",
            "播放下一首",
            "播放列表全部",
            "天气怎么样",
        ):
            self.assertIsNone(local_play_request(text))

    def test_now_playing_question_recognition(self):
        for text in (
            "这是什么歌", "这首歌叫什么名字", "正在播放的歌曲叫什么名字",
            "当前播放歌曲名", "现在放的是什么歌", "播放的是什么歌",
            "告诉我这首歌的名字", "小爱同学，请问现在播放什么歌曲？", "报一下歌名",
            "你现在播放的是什么歌呢", "告诉我当前播放的歌曲名字",
        ):
            with self.subTest(text=text):
                self.assertTrue(is_now_playing_request(text))
        for text in ("播放什么歌都行", "播放歌曲晴天", "播放名字叫晴天的歌", "下一首"):
            self.assertFalse(is_now_playing_request(text))

    def test_now_playing_question_does_not_start_random_music(self):
        self.player.announce_current_music = AsyncMock()
        asyncio.run(self.app.do_check_cmd("test-device", "播放的是什么歌", False))
        self.player.announce_current_music.assert_awaited_once()
        self.player._playmusic.assert_not_awaited()
        self.app.command_handler.do_check_cmd.assert_not_awaited()

    def test_title_announcement_uses_local_state_even_when_general_tts_disabled(self):
        self.player.device.cur_music = "local-song"
        self.player.device_id = "test-service-device"
        self.app.music_library.all_music = {"local-song": str(self.song)}
        service = SimpleNamespace(text_to_speech=AsyncMock(return_value={"code": 0}))
        self.player.auth_manager = SimpleNamespace(mina_service=service)
        self.player.announce_current_music = XiaoMusicDevice.announce_current_music.__get__(self.player)
        self.player.text_to_speech = AsyncMock()
        self.assertEqual(self.player.config.edge_tts_voice, "disable")
        asyncio.run(self.player.announce_current_music())
        service.text_to_speech.assert_awaited_once_with(
            "test-service-device", "当前本地播放的是，local-song。"
        )
        self.player.text_to_speech.assert_not_awaited()
        self.player._playmusic.assert_not_awaited()
        self.player.group_force_stop_xiaoai.assert_not_awaited()

    def test_stopped_or_missing_track_is_not_announced_as_playing(self):
        self.player.device.cur_music = "local-song"
        self.player.device_id = "test-service-device"
        service = SimpleNamespace(text_to_speech=AsyncMock(return_value={"code": 0}))
        self.player.auth_manager = SimpleNamespace(mina_service=service)
        for playing, path in ((False, str(self.song)), (True, str(self.outside))):
            self.player.is_playing = playing
            self.app.music_library.all_music = {"local-song": path}
            asyncio.run(self.player.announce_current_music())
        self.assertEqual(service.text_to_speech.await_count, 2)
        service.text_to_speech.assert_awaited_with(
            "test-service-device", "当前没有在播放本地音乐。"
        )

    def test_announcement_failure_does_not_kill_voice_loop_or_restart_music(self):
        self.player.device.cur_music = "local-song"
        self.player.device_id = "test-service-device"
        self.player.auth_manager = SimpleNamespace(mina_service=SimpleNamespace(
            text_to_speech=AsyncMock(side_effect=RuntimeError("device timeout"))
        ))
        self.assertFalse(asyncio.run(self.player.announce_current_music()))
        self.player._playmusic.assert_not_awaited()

    def test_story_miss_takes_over_and_plays_local_random_track(self):
        events = []

        async def stop():
            events.append("stop-native")

        async def play(name):
            events.append(("play-local", name))

        self.player.group_force_stop_xiaoai.side_effect = stop
        self.player._playmusic.side_effect = play
        asyncio.run(self.app.do_check_cmd("test-device", "播放不存在的故事", False))
        self.assertEqual(events, [("play-local", "local-song")])
        self.app.command_handler.do_check_cmd.assert_not_awaited()
        self.player.do_tts.assert_not_awaited()

    def test_music_miss_uses_same_local_fallback(self):
        asyncio.run(self.app.do_check_cmd("test-device", "播放音乐不存在", False))
        self.player._playmusic.assert_awaited_once_with("local-song")

    def test_resume_story_miss_takes_over_locally(self):
        asyncio.run(self.app.do_check_cmd("test-device", "继续播放植物大战僵尸故事", False))
        self.player.group_force_stop_xiaoai.assert_not_awaited()
        self.player._playmusic.assert_awaited_once_with("local-song")
        self.app.command_handler.do_check_cmd.assert_not_awaited()

    def test_found_local_track_is_played_without_fallback(self):
        self.app.music_library.find_real_music_name.return_value = ["local-song"]
        self.player.play_random_local = AsyncMock()
        asyncio.run(self.app.do_check_cmd("test-device", "播放歌曲local-song", False))
        self.player._playmusic.assert_awaited_once_with("local-song")
        self.player.play_random_local.assert_not_awaited()

    def test_bare_play_and_story_request_pick_random_local(self):
        for text in ("播放", "讲个故事"):
            asyncio.run(self.app.do_check_cmd("test-device", text, False))
        self.assertEqual(self.player._playmusic.await_count, 2)

    def test_random_choice_excludes_outside_remote_missing_and_escaping_symlink(self):
        link = self.root / "escape.mp3"
        link.symlink_to(self.outside)
        self.app.music_library.all_music.update(
            {
                "outside": str(self.outside),
                "remote": "https://example.com/song.mp3",
                "missing": str(self.root / "missing.mp3"),
                "escape": str(link),
            }
        )
        with patch(
            "xiaomusic.device_player.random.choice",
            side_effect=lambda choices: choices[0],
        ) as choose:
            asyncio.run(self.player.play_random_local())
        self.assertEqual(choose.call_args.args[0], ["local-song"])
        self.player._playmusic.assert_awaited_once_with("local-song")

    def test_empty_library_stops_native_and_does_not_play_anything(self):
        self.app.music_library.all_music = {}
        asyncio.run(self.app.do_check_cmd("test-device", "播放故事不存在", False))
        self.assertFalse(self.player.is_playing)
        self.player.group_force_stop_xiaoai.assert_awaited()
        self.player._playmusic.assert_not_awaited()

    def test_panel_calls_remain_panel_commands(self):
        asyncio.run(self.app.do_check_cmd("test-device", "播放音乐", True))
        self.app.command_handler.do_check_cmd.assert_awaited_once()
        self.player._playmusic.assert_not_awaited()

    def test_forced_stop_is_sent_even_when_pause_fails(self):
        service = SimpleNamespace(
            player_pause=AsyncMock(side_effect=RuntimeError("pause unavailable")),
            player_stop=AsyncMock(),
        )
        self.player.auth_manager = SimpleNamespace(mina_service=service)
        self.player.get_if_xiaoai_is_playing = AsyncMock(
            side_effect=RuntimeError("status unavailable")
        )
        asyncio.run(self.player.force_stop_xiaoai("test-device"))
        service.player_stop.assert_awaited_once_with("test-device")
        self.player.get_if_xiaoai_is_playing.assert_not_awaited()

    def test_local_sink_replaces_queue_without_online_metadata(self):
        self.player.device.hardware = "LX06"
        service = SimpleNamespace(
            play_by_music_url=AsyncMock(return_value={"code": 0}),
            play_by_url=AsyncMock(),
        )
        self.player.auth_manager = SimpleNamespace(mina_service=service)
        self.player._get_audio_id = AsyncMock()
        url = local_media.MEDIA_ORIGIN + "/music/local-song.mp3"
        for enabled in (False, True):
            self.player.config.continue_play = enabled
            self.player.config.use_music_api = enabled
            result = asyncio.run(self.player.play_one_url("test-device", url, "local-song"))
            self.assertEqual(result, {"code": 0})
        self.assertEqual(service.play_by_music_url.await_count, 2)
        service.play_by_music_url.assert_awaited_with("test-device", url)
        service.play_by_url.assert_not_awaited()
        self.player._get_audio_id.assert_not_awaited()

    def test_settings_enforce_immediate_local_choice_and_native_stop(self):
        config = Config()
        config.update_config(
            {
                "enable_force_stop": False,
                "enable_multi_result_selection": True,
                "multi_result_action": "first",
            }
        )
        self.assertTrue(config.enable_force_stop)
        self.assertFalse(config.enable_multi_result_selection)
        self.assertEqual(config.multi_result_action, "random")

    def _use_real_playback(self):
        self.app.music_library.get_music_url = AsyncMock(
            return_value=(local_media.MEDIA_ORIGIN + "/music/local-song.mp3", None)
        )
        self.app.music_library.get_music_duration = AsyncMock(return_value=10)
        self.app.music_library.is_web_radio_music = Mock(return_value=False)
        self.app.analytics = SimpleNamespace(send_play_event=AsyncMock())
        self.player.device.playlist2music = {}
        self.player.device.hardware = "LX06"
        self.player.event_bus = None
        self.player.group_player_play = AsyncMock(return_value=[{"code": 0}])
        self.player.set_next_music_timeout = AsyncMock()
        self.player._play_failed_cnt = 0
        self.player._last_cmd = "playlocal"
        self.player._playmusic = XiaoMusicDevice._playmusic.__get__(self.player)

    def test_voice_reaches_replacement_without_serial_pause_stop_roundtrips(self):
        self._use_real_playback()
        asyncio.run(self.app.do_check_cmd("test-device", "播放不存在的故事", False))
        self.player.group_player_play.assert_awaited_once()
        self.player.group_force_stop_xiaoai.assert_not_awaited()

    def test_failed_replacement_stops_native_before_giving_up(self):
        self._use_real_playback()
        events = []

        async def failed_play(*args):
            events.append("replace")
            return [None]

        async def stop():
            events.append("stop")

        self.player.group_player_play.side_effect = failed_play
        self.player.group_force_stop_xiaoai.side_effect = stop
        self.player._play_failed_cnt = 4
        with patch("xiaomusic.device_player.asyncio.sleep", new=AsyncMock()):
            asyncio.run(self.player._playmusic("local-song"))
        self.assertEqual(events, ["replace", "stop"])

    def test_repeated_text_normalization_reuses_conversion(self):
        with patch.object(text_utils.cc, "convert", return_value="后台-cache-probe") as convert:
            for _ in range(2):
                self.assertEqual(
                    text_utils.traditional_to_simple("後臺-cache-probe-7ef"),
                    "后台-cache-probe",
                )
            convert.assert_called_once()

    def test_exact_filename_does_not_scan_fuzzy_candidates(self):
        library = object.__new__(MusicLibrary)
        library.config = self.player.config
        library.log = self.app.log
        library.all_music = {"local-song": str(self.song)}
        library._extra_index_search = {}
        with patch("xiaomusic.music_library.find_best_match") as search:
            self.assertEqual(library.find_real_music_name("local-song", 100), ["local-song"])
            search.assert_not_called()


if __name__ == "__main__":
    unittest.main()
