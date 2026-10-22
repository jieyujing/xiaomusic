"""Exercise the default page's real routes without a Xiaomi session or speaker."""

import json
import logging
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock, patch

from fastapi import FastAPI
from fastapi.testclient import TestClient

from xiaomusic.api.dependencies import _state
from xiaomusic.api.routers import register_routers
from xiaomusic.config import Config


class DefaultUIContractTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        config = Config(conf_path=self.tmp.name, disable_httpauth=True)
        config.mi_did = "speaker"
        self.config = config
        self.library = SimpleNamespace(
            get_music_list=Mock(return_value={"全部": ["本地歌曲"], "收藏": []}),
            searchmusic=Mock(return_value=["本地歌曲"]),
            get_music_url=AsyncMock(return_value=("/music/local.mp3", None)),
            get_music_tags=AsyncMock(
                return_value={"title": "本地歌曲", "artist": "作者"}
            ),
            play_list_add_music=Mock(return_value=True),
            play_list_del_music=Mock(return_value=True),
        )

        async def save_config(data):
            config.update_config(data)

        self.instance = SimpleNamespace(
            music_library=self.library,
            getconfig=lambda: config,
            did_exist=lambda did: did == "speaker",
            do_play_music_list=AsyncMock(),
            do_play=AsyncMock(),
            do_check_cmd=AsyncMock(),
            cancel_all_tasks=AsyncMock(),
            append_running_task=Mock(),
            is_task_finish=AsyncMock(return_value=True),
            get_cur_play_list=Mock(return_value="全部"),
            isplaying=Mock(return_value=True),
            playingmusic=Mock(return_value="本地歌曲"),
            get_offset_duration=Mock(return_value=(12, 200)),
            set_volume=AsyncMock(),
            get_volume=AsyncMock(return_value=35),
            stop=AsyncMock(),
            save_cur_config=Mock(),
            saveconfig=AsyncMock(side_effect=save_config),
        )
        for name, value in (
            ("_xiaomusic", self.instance),
            ("_config", config),
            ("_log", logging.getLogger("ui-contract")),
        ):
            p = patch.object(_state, name, value)
            p.start()
            self.addCleanup(p.stop)
        app = FastAPI()
        register_routers(app)
        self.client = TestClient(app)

    def test_route_inventory_has_no_unclassified_routes(self):
        from scripts.audit_ui_routes import inventory

        rows = inventory()
        saved = json.loads((Path(__file__).resolve().parents[1] /
                            "xiaomusic/static/library/route-coverage.json").read_text())
        self.assertEqual(rows, saved)

    def test_management_playlist_contracts(self):
        self.library.play_list_add = Mock(return_value=True)
        self.library.play_list_del = Mock(return_value=True)
        self.library.play_list_update_name = Mock(return_value=True)
        self.library.play_list_update_music = Mock(return_value=True)
        self.library.get_play_list_names = Mock(return_value=["晚间"])
        self.library.play_list_musics = Mock(return_value=(True, ["歌曲甲", "歌曲乙"]))
        self.assertEqual(self.client.get("/playlistnames").json()["names"], ["晚间"])
        self.assertEqual(self.client.get("/playlistmusics?name=晚间").json()["musics"], ["歌曲甲", "歌曲乙"])
        for route, payload in [
            ("/playlistadd", {"name": "晚间"}),
            ("/playlistupdatename", {"oldname": "晚间", "newname": "夜晚"}),
            ("/playlistupdatemusic", {"name": "夜晚", "music_list": ["歌曲乙", "歌曲甲"]}),
            ("/playlistdel", {"name": "夜晚"}),
        ]:
            self.assertEqual(self.client.post(route, json=payload).json(), {"ret": "OK"})
        self.library.play_list_update_music.assert_called_once_with("夜晚", ["歌曲乙", "歌曲甲"])
        self.library.play_list_update_name.assert_called_once_with("晚间", "夜晚")
        self.library.play_list_add.return_value = False
        self.assertNotEqual(self.client.post("/playlistadd", json={"name": "晚间"}).json()["ret"], "OK")

    def test_management_media_and_device_contracts(self):
        self.library.set_music_tag = Mock(return_value="OK")
        self.instance.del_music = AsyncMock()
        self.instance.get_player_status = AsyncMock(return_value={"status": 1, "volume": 35})
        self.instance.do_tts = AsyncMock()
        payload = {"musicname": "本地歌曲", "title": "新标题", "artist": "作者", "picture": ""}
        self.assertEqual(self.client.post("/setmusictag", json=payload).json(), {"ret": "OK"})
        self.assertEqual(self.library.set_music_tag.call_args.args[1].title, "新标题")
        self.assertEqual(self.client.post("/delmusic", json={"name": "本地歌曲"}).json(), "success")
        self.instance.del_music.assert_awaited_once_with("本地歌曲")
        self.assertEqual(self.client.get("/getplayerstatus?did=speaker").json()["volume"], 35)
        self.assertEqual(self.client.get("/playtts", params={"did": "speaker", "text": "晚安"}).json()["ret"], "OK")
        self.instance.do_tts.assert_awaited_once_with(did="speaker", value="晚安")

    def test_management_plugin_contracts(self):
        manager = SimpleNamespace(
            _get_config_data=Mock(return_value={"password": "fixture-admin"}),
            refresh_plugin_list=Mock(return_value=[{"name": "FixturePlugin", "enabled": True}]),
            disable_plugin=Mock(return_value=True),
            uninstall_plugin=Mock(return_value=True),
        )
        self.instance.js_plugin_manager = manager
        self.assertTrue(self.client.get("/api/password/check").json()["data"]["required"])
        self.assertFalse(self.client.post("/api/password/verify", json={"password": "wrong"}).json()["success"])
        self.assertTrue(self.client.post("/api/password/verify", json={"password": "fixture-admin"}).json()["success"])
        self.assertEqual(self.client.get("/api/js-plugins").json()["data"][0]["name"], "FixturePlugin")
        self.assertTrue(self.client.put("/api/js-plugins/FixturePlugin/disable").json()["success"])
        self.assertTrue(self.client.delete("/api/js-plugins/FixturePlugin/uninstall").json()["success"])
        manager.disable_plugin.assert_called_once_with("FixturePlugin")
        manager.uninstall_plugin.assert_called_once_with("FixturePlugin")

    def test_every_legacy_setting_is_in_the_new_schema(self):
        from scripts.generate_settings_schema import Document

        root = Path(__file__).resolve().parents[1]
        source = root / "xiaomusic/static/default/setting.html"
        legacy = {
            node.attrs["id"]
            for node in Document(source.read_text()).root.walk()
            if node.tag in {"input", "select", "textarea"} and node.attrs.get("id")
        }
        schema = json.loads(
            (root / "xiaomusic/static/library/settings-schema.json").read_text()
        )
        self.assertEqual(legacy, {field["key"] for field in schema["fields"]})
        self.assertEqual(len(schema["groups"]), 13)

    def test_partial_save_preserves_unedited_fields_and_masked_credentials(self):
        self.config.account = "existing-account"
        self.config.password = "fixture-password"
        self.config.httpauth_password = "fixture-http-password"
        original_path = self.config.music_path
        with patch("xiaomusic.api.dependencies.reset_http_server") as reset:
            response = self.client.post(
                "/savesetting",
                json={
                    "exclude_dirs": "tmp,private",
                    "enable_file_watch": True,
                    "password": "******",
                    "httpauth_password": "",
                },
            )
        self.assertEqual(response.json(), "save success")
        self.assertEqual(self.config.account, "existing-account")
        self.assertEqual(self.config.password, "fixture-password")
        self.assertEqual(self.config.httpauth_password, "fixture-http-password")
        self.assertEqual(self.config.exclude_dirs, "tmp,private")
        self.assertTrue(self.config.enable_file_watch)
        self.assertEqual(self.config.music_path, original_path)
        self.instance.saveconfig.assert_awaited_once()
        reset.assert_called_once()

    def test_default_library_search_and_tags(self):
        self.assertEqual(self.client.get("/musiclist").json()["全部"], ["本地歌曲"])
        self.assertEqual(self.client.get("/searchmusic?name=本地").json(), ["本地歌曲"])
        info = self.client.get("/musicinfo?name=本地歌曲&musictag=true").json()
        self.assertEqual(info["tags"]["artist"], "作者")
        self.assertEqual(self.client.get("/curplaylist?did=speaker").json(), "全部")

    def test_play_payloads_match_default_page(self):
        response = self.client.post(
            "/playmusiclist",
            json={"did": "speaker", "listname": "全部", "musicname": "本地歌曲"},
        )
        self.assertEqual(response.json(), {"ret": "OK"})
        self.instance.do_play_music_list.assert_awaited_once_with(
            "speaker", "全部", "本地歌曲"
        )
        response = self.client.post(
            "/playmusic",
            json={"did": "speaker", "musicname": "本地歌曲", "searchkey": ""},
        )
        self.assertEqual(response.json(), {"ret": "OK"})
        self.instance.do_play.assert_awaited_once_with("speaker", "本地歌曲", "")
        self.assertEqual(self.client.get("/playqueue?did=speaker").status_code, 404)

    def test_favorites_use_default_payloads(self):
        data = {"name": "收藏", "music_list": ["本地歌曲"]}
        self.assertEqual(
            self.client.post("/playlistaddmusic", json=data).json(), {"ret": "OK"}
        )
        self.library.play_list_add_music.assert_called_once_with("收藏", ["本地歌曲"])
        self.assertEqual(
            self.client.post("/playlistdelmusic", json=data).json(), {"ret": "OK"}
        )
        self.library.play_list_del_music.assert_called_once_with("收藏", ["本地歌曲"])

    def test_voice_toggle_preserves_other_settings(self):
        original_path = self.config.music_path
        response = self.client.post(
            "/api/system/modifiysetting", json={"enable_pull_ask": True}
        )
        self.assertTrue(response.json()["success"])
        self.assertTrue(self.config.enable_pull_ask)
        self.assertEqual(self.config.music_path, original_path)
        self.instance.save_cur_config.assert_called_once()

    def test_status_websocket_matches_default_payload(self):
        token = self.client.get("/generate_ws_token?did=speaker").json()["token"]
        with self.client.websocket_connect(
            f"/ws/playingmusic?token={token}"
        ) as websocket:
            status = websocket.receive_json()
        self.assertEqual(
            status,
            {
                "ret": "OK",
                "is_playing": True,
                "cur_music": "本地歌曲",
                "cur_playlist": "全部",
                "offset": 12,
                "duration": 200,
            },
        )
        self.assertEqual(self.client.get("/playingmusic?did=speaker").json(), status)

    def test_existing_volume_and_stop_routes(self):
        self.assertEqual(self.client.get("/getvolume?did=speaker").json()["volume"], 35)
        self.assertEqual(
            self.client.post(
                "/setvolume", json={"did": "speaker", "volume": 40}
            ).json()["ret"],
            "OK",
        )
        self.instance.set_volume.assert_awaited_once_with(did="speaker", arg1=40)
        self.assertEqual(
            self.client.post("/device/stop", json={"did": "speaker"}).json()["ret"],
            "OK",
        )
        self.instance.stop.assert_awaited_once_with("speaker", "notts")


if __name__ == "__main__":
    unittest.main()
