"""Rank local filenames without mixing strong and weak matching tiers."""

import difflib
import re
import unicodedata
from collections import Counter, defaultdict
from pathlib import Path

from xiaomusic.utils.text_utils import custom_sort_key, traditional_to_simple

_BRACKETS = re.compile(r"\[([^\]]*)\]|\(([^)]*)\)|【([^】]*)】|（([^）]*)）")
_TRACK_PREFIX = re.compile(r"^(?:\d{1,3}[-_.\s]+)+")
_VERSIONS = re.compile(
    r"\bai\b|翻唱|合唱|伴奏|纯音乐|现场|演奏|演唱会|\blive\b|remix|cover|explicit|无损|高品质",
    re.IGNORECASE,
)


def _compact(text):
    text = traditional_to_simple(unicodedata.normalize("NFKC", text).casefold())
    return "".join(char for char in text if char.isalnum())


def _forms(text):
    """Keep explicit versions and translations, plus a clean title alias."""
    forms = {_compact(text)}

    def strip_version(match):
        content = next(value for value in match.groups() if value is not None)
        if _VERSIONS.search(content):
            return ""
        forms.add(_compact(content))
        return match.group(0)

    forms.add(_compact(_BRACKETS.sub(strip_version, text)))
    return forms - {""}


def _artist_title(text):
    parts = re.split(r"\s+[-–—]\s+|[–—]", text, maxsplit=1)
    if len(parts) == 1 and "-" in text:
        parts = text.rsplit("-", 1)
    return parts if len(parts) == 2 else ("", text)


class LocalMusicMatcher:
    def __init__(self, music, aliases=None):
        self.names = frozenset(music)
        self.exact = defaultdict(set)
        self.manual = defaultdict(set)
        self.records = []
        for name, filename in music.items():
            clean = _TRACK_PREFIX.sub("", name)
            artist, title = _artist_title(clean)
            keys = _forms(name) | _forms(clean) | _forms(title)
            artists = {_compact(artist)} - {""}
            parts = Path(filename).parts
            if "Albums" in parts:
                position = parts.index("Albums") + 1
                if position < len(parts) - 1:
                    artists.add(_compact(parts[position]))
            titles = _forms(title)
            for artist_key in artists:
                keys.add(artist_key)
                for title_key in titles:
                    keys.update((artist_key + title_key, artist_key + "的" + title_key))
            # Parent directories are a lower-priority fallback, never the NAS root.
            context = {_compact(part) for part in parts[4:-1]} - {""}
            self.records.append((name, keys, context))
            for key in keys:
                self.exact[key].add(name)
        self._fuzzy = [(key, Counter(key), names) for key, names in self.exact.items()]
        if isinstance(aliases, dict):
            for alias, targets in aliases.items():
                if not isinstance(alias, str) or not _compact(alias):
                    continue
                if isinstance(targets, str):
                    targets = [targets]
                if isinstance(targets, list):
                    self.manual[_compact(alias)].update(
                        target for target in targets if isinstance(target, str) and target in self.names
                    )

    @staticmethod
    def _top(scored, n):
        if not scored:
            return []
        best = max(scored.values())
        names = (name for name, score in scored.items() if abs(score - best) < 1e-9)
        return sorted(names, key=custom_sort_key)[:n]

    def find(self, query, n=100, cutoff=0.6):
        if n <= 0:
            return []
        query = re.sub(r"\.(?:mp3|ogg|flac|wav|ape|m4a|wma)$", "", query, flags=re.I)
        if query in self.names:
            return [query]
        query = _compact(query)
        if not query:
            return []
        if self.manual.get(query):
            return sorted(self.manual[query], key=custom_sort_key)[:n]
        if query in self.exact:
            return sorted(self.exact[query], key=custom_sort_key)[:n]

        # Only the strongest containment matches are eligible for random choice.
        contains = {}
        for name, keys, _ in self.records:
            scores = [len(query) / len(key) for key in keys if query in key]
            if scores:
                contains[name] = max(scores)
        if contains:
            return self._top(contains, n)

        context_matches = {
            name: max(len(query) / len(key) for key in context if query in key)
            for name, _, context in self.records
            if any(query in key for key in context)
        }
        if context_matches:
            return self._top(context_matches, n)

        # A one-character mistake in a very short title is too ambiguous to guess.
        if len(query) < 4:
            return []
        threshold = max(cutoff, 0.72)
        fuzzy = {}
        query_counts = Counter(query)
        query_chars = set(query_counts)
        for key, counts, names in self._fuzzy:
            total = len(query) + len(key)
            if 2 * min(len(query), len(key)) < threshold * total:
                continue
            if query_chars.isdisjoint(counts):
                continue
            overlap = sum(min(count, counts.get(char, 0)) for char, count in query_counts.items())
            if 2 * overlap < threshold * total:
                continue
            score = difflib.SequenceMatcher(None, query, key, autojunk=False).ratio()
            if score >= threshold:
                for name in names:
                    fuzzy[name] = max(fuzzy.get(name, 0), score)
        return self._top(fuzzy, n)
