"""Deployment policy: media must be an existing file below the NAS music root.

This root is deliberately not a web setting. The container mounts it read-only.
"""

from pathlib import Path
from urllib.parse import unquote, urlsplit

from xiaomusic.const import SUPPORT_MUSIC_TYPE

MEDIA_ROOT = Path("/vol2/1000/music")
MEDIA_ORIGIN = "http://192.168.100.99:8090"

# Disable alternate media delivery and import paths, including the updater that
# would otherwise replace this deployment's policy with upstream code.
BLOCKED_PATHS = {
    "/proxy",
    "/api/proxy",
    "/api/search",
    "/api/play/getMediaSource",
    "/api/device/pushUrl",
    "/api/device/pushList",
    "/debug_play_by_music_url",
    "/downloadjson",
    "/downloadplaylist",
    "/downloadonemusic",
    "/resume_download",
    "/restart_download",
    "/uploadmusic",
    "/updateversion",
}


def blocked_media_request(path):
    path = path.rstrip("/")
    return any(
        path == prefix or path.startswith(prefix + "/") for prefix in BLOCKED_PATHS
    ) or (
        Path(path).suffix.lower() in SUPPORT_MUSIC_TYPE
        and not path.startswith("/music/")
    )


def require_media_file(path):
    """Resolve again on every use, rejecting traversal and escaping symlinks."""
    try:
        source = Path(path).resolve(strict=True)
        root = MEDIA_ROOT.resolve(strict=True)
        if (
            not source.is_relative_to(root)
            or not source.is_file()
            or source.suffix.lower() not in SUPPORT_MUSIC_TYPE
        ):
            raise PermissionError("Only media under /vol2/1000/music is allowed")
        return source
    except (OSError, RuntimeError, ValueError) as exc:
        raise PermissionError(
            "Media is unavailable or outside the allowed root"
        ) from exc


def require_media_url(url):
    """Accept only this server's /music URL backed by an authorized local file."""
    try:
        parsed = urlsplit(url)
        # The web-editable hostname must never authorize an external origin.
        origin = urlsplit(MEDIA_ORIGIN)
        if (
            parsed.scheme not in ("http", "https")
            or (parsed.scheme, parsed.hostname, parsed.port)
            != (origin.scheme, origin.hostname, origin.port)
            or parsed.username is not None
            or parsed.password is not None
            or parsed.fragment
            or not parsed.path.startswith("/music/")
        ):
            raise ValueError("Not a local media URL")
        relative = unquote(parsed.path[len("/music/") :])
        if Path(relative).is_absolute() or ".." in Path(relative).parts:
            raise ValueError("Invalid media path")
        return require_media_file(MEDIA_ROOT / relative)
    except (TypeError, ValueError) as exc:
        raise PermissionError("External and proxy media URLs are disabled") from exc
