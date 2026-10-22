"""Recognize media requests before native/online command routing."""

import re

_NOW_PLAYING_PATTERNS = tuple(re.compile(pattern) for pattern in (
    r"(?:现在|当前|正在)?在?(?:播放|放|听)的?是?(?:什么|哪首)(?:歌|歌曲|音乐)",
    r"(?:(?:现在|当前|正在)在?(?:播放|放|听)的?)?(?:这首歌|这首歌曲|这段音乐|歌曲|歌|音乐)的?(?:叫(?:什么|啥)(?:名字|歌名|名称)?|名字(?:是什么)?|歌名(?:是什么)?|名称(?:是什么)?|是什么)",
    r"这(?:首|个)?(?:歌|歌曲|音乐)?是(?:什么|哪首)(?:歌|歌曲|音乐)",
    r"(?:现在|当前)是?(?:什么|哪首)(?:歌|歌曲|音乐)",
    r"(?:现在|当前|正在)?(?:播放|放|听)的?(?:歌名|歌曲名(?:字|称)?)",
    r"(?:报|说)(?:一下)?(?:当前|现在)?歌名",
))


def is_now_playing_request(query):
    """Recognize questions before a leading '播放' can start a new track."""
    query = re.sub(r"[\s，。！？,.!?：:、]", "", query)
    query = re.sub(r"^(?:小爱同学|小爱)", "", query)
    query = re.sub(r"^(?:(?:请问|请|告诉我|帮我查一下|帮我查查|帮我|给我|查询|查一下|问一下|我想知道))+", "", query)
    query = re.sub(r"^你(?=现在|当前|正在)", "", query)
    query = re.sub(r"^(?:现在|当前)(?=正在)", "", query)
    query = re.sub(r"^(?:现在|当前)(?=这)", "", query)
    query = re.sub(r"[呢呀]$", "", query)
    return query in ("歌名", "当前歌名") or any(pattern.fullmatch(query) for pattern in _NOW_PLAYING_PATTERNS)


def local_play_request(query):
    """Return a local search term, empty for random playback, or None for controls."""
    query = re.sub(r"^(?:小爱同学|小爱)[，,\s]*", "", query.strip())
    query = re.sub(r"^(?:(?:请|麻烦|帮我|给我)\s*)+", "", query)
    query = re.sub(r"^(?:我想|我要)(?=播放|放|讲)", "", query)
    query = re.sub(r"^继续(?=播放)", "", query)
    if query.startswith(("播放歌单", "播放列表", "播放本地歌单")):
        return None
    if query in ("播放下一首", "播放上一首", "播放下一集", "播放上一集"):
        return None
    match = re.match(
        r"^(?:我想听|我要听|听故事|听音乐|讲一个故事|讲个故事|讲故事|讲一个|讲个|讲一段|播放|放一首|放首|放个|放)(.*)$",
        query,
    )
    if not match:
        return None
    name = match.group(1).strip(" ，。！？!?")
    name = re.sub(
        r"^(?:本地歌曲|本地音乐|本地|一首歌曲|一首歌|一首|歌曲|音乐|故事|小说|有声书)\s*",
        "",
        name,
    )
    return name.strip(" ，。！？!?")
