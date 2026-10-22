"""Local candidate selection; no cloud or speaker calls."""

import json
import logging
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from xiaomusic import local_media
from xiaomusic.config import Config
from xiaomusic.local_matching import LocalMusicMatcher
from xiaomusic.music_library import MusicLibrary


class LocalMatchingTests(unittest.TestCase):
    def setUp(self):
        self.music = {
            "01-03 晴天": "/vol2/1000/music/Library/Albums/周杰伦/叶惠美/01-03 晴天.mp3",
            "周杰伦-晴天": "/vol2/1000/music/QQ音乐/周杰伦-晴天.ogg",
            "晴天 [AI翻唱]": "/vol2/1000/music/AI/晴天 [AI翻唱].mp3",
            "晴天娃娃": "/vol2/1000/music/Other/晴天娃娃.mp3",
            "勇气大爆发 [AI翻唱]": "/vol2/1000/music/AI/勇气大爆发 [AI翻唱].mp3",
            "周杰伦-晴天 (Live)": "/vol2/1000/music/QQ音乐/周杰伦-晴天 (Live).ogg",
            "2NE1-I Am The Best (我最红)": "/vol2/1000/music/QQ音乐/2NE1-I Am The Best (我最红).ogg",
            "Hello": "/vol2/1000/music/Other/Hello.mp3",
            "hello": "/vol2/1000/music/Other/hello.ogg",
        }
        self.matcher = LocalMusicMatcher(self.music)

    def test_raw_filename_wins_over_other_versions(self):
        self.assertEqual(self.matcher.find("周杰伦-晴天"), ["周杰伦-晴天"])

    def test_spoken_filename_can_include_extension(self):
        self.assertEqual(self.matcher.find("周杰伦-晴天.ogg"), ["周杰伦-晴天"])

    def test_exact_clean_title_excludes_merely_containing_title(self):
        matches = self.matcher.find("晴天")
        self.assertIn("01-03 晴天", matches)
        self.assertIn("周杰伦-晴天", matches)
        self.assertNotIn("晴天娃娃", matches)
        self.assertNotIn("勇气大爆发 [AI翻唱]", matches)

    def test_traditional_title_matches_without_weak_candidates(self):
        self.assertEqual(self.matcher.find("勇氣大爆發"), ["勇气大爆发 [AI翻唱]"])

    def test_single_typo_in_long_title(self):
        self.assertEqual(self.matcher.find("勇气大暴发"), ["勇气大爆发 [AI翻唱]"])

    def test_short_title_is_not_guessed_from_one_wrong_character(self):
        self.assertEqual(self.matcher.find("晴田"), [])

    def test_artist_and_title_request(self):
        matches = self.matcher.find("周杰伦的晴天")
        self.assertTrue(matches)
        self.assertTrue(all("周杰伦" in self.music[name] for name in matches))
        self.assertNotIn("晴天 [AI翻唱]", matches)

    def test_explicit_version_is_not_stripped_from_request(self):
        self.assertEqual(self.matcher.find("晴天 Live"), ["周杰伦-晴天 (Live)"])

    def test_translated_title_in_parentheses_is_searchable(self):
        self.assertEqual(self.matcher.find("我最红"), ["2NE1-I Am The Best (我最红)"])

    def test_normalization_collision_preserves_both_files(self):
        self.assertEqual(set(self.matcher.find("ＨＥＬＬＯ")), {"Hello", "hello"})

    def test_manual_alias_only_resolves_catalog_names(self):
        matcher = LocalMusicMatcher(self.music, {"小朋友的歌": "勇气大爆发 [AI翻唱]"})
        self.assertEqual(matcher.find("小朋友的歌"), ["勇气大爆发 [AI翻唱]"])
        matcher = LocalMusicMatcher(self.music, {"外部歌曲": "https://example.com/a.mp3"})
        self.assertEqual(matcher.find("外部歌曲"), [])

    def test_unknown_story_remains_a_miss(self):
        self.assertEqual(self.matcher.find("植物大战僵尸故事"), [])

    def test_empty_query_and_empty_catalog(self):
        self.assertEqual(self.matcher.find(""), [])
        self.assertEqual(LocalMusicMatcher({}).find("晴天"), [])

    def test_album_context_remains_searchable(self):
        self.assertEqual(self.matcher.find("叶惠美"), ["01-03 晴天"])

    def test_numbers_in_title_are_still_searchable(self):
        matcher = LocalMusicMatcher({"7 Up": "/vol2/1000/music/7 Up.mp3"})
        self.assertEqual(matcher.find("７ＵＰ"), ["7 Up"])

    def test_alias_changes_are_loaded_on_library_refresh(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / "music"
            root.mkdir()
            for name in ("first", "second"):
                (root / (name + ".ogg")).write_bytes(b"fixture")
            config = Config(conf_path=directory)
            config.music_path = str(root)
            library = MusicLibrary(config, logging.getLogger("test"))
            alias_file = Path(directory) / "music_aliases.json"
            with (
                patch.object(local_media, "MEDIA_ROOT", root),
                patch("xiaomusic.music_library.MEDIA_ROOT", root),
                patch.object(library, "try_gen_all_music_tag"),
            ):
                for target in ("first", "second"):
                    alias_file.write_text(json.dumps({"我的别名": target}))
                    library.gen_all_music_list()
                    self.assertEqual(library.find_real_music_name("我的别名", 100), [target])
                alias_file.write_text("not valid JSON")
                library.gen_all_music_list()
                self.assertEqual(library.find_real_music_name("我的别名", 100), [])


if __name__ == "__main__":
    unittest.main()
