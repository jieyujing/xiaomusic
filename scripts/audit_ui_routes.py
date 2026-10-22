"""Explicit route-to-workflow inventory. New unclassified routes fail the audit."""
import ast
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
GROUPS = {
    ('active', '媒体库 / 播放器 / 播放列表'): '''GET /searchmusic
GET /playingmusic
GET /musiclist
GET /musicinfo
POST /playmusic
GET /curplaylist
POST /playmusiclist
GET /getvolume
POST /setvolume
POST /cmd
GET /cmdstatus
POST /device/stop''',
    ('active', '设置'): '''GET /api/get_qrcode
GET /getsetting
POST /savesetting
POST /api/system/modifiysetting
GET /device_list
POST /refreshmusictag
POST /api/music/refreshlist
POST /api/file/cleantempdir
GET /downloadlog''',
    ('active', '管理 / 歌单'): '''POST /playlistadd
POST /playlistdel
POST /playlistupdatename
GET /playlistnames
POST /playlistaddmusic
POST /playlistdelmusic
POST /playlistupdatemusic
GET /playlistmusics''',
    ('active', '管理 / 媒体'): '''POST /setmusictag
POST /delmusic''',
    ('active', '管理 / 设备'): '''GET /getplayerstatus
GET /playurl
GET /playtts''',
    ('active', '管理 / 插件'): '''GET /api/js-plugins
PUT /api/js-plugins/{plugin_name}/disable
DELETE /api/js-plugins/{plugin_name}/uninstall
GET /api/password/check
POST /api/password/verify''',
    ('active', '管理 / 高级（只读状态）'): '''GET /api/platforms
GET /api/lxServer/load
GET /api/plugin-source/load
GET /api/back-conf/load
GET /api/advanced-config/load
GET /api/box-play-platform/load''',
    ('active', '管理 / 系统'): '''GET /getversion
GET /latestversion
GET /docs
GET /redoc
GET /api/debug/simulate_token_expire
GET /download_progress
POST /clear_completed_tasks
POST /pause_download
POST /stop_download
POST /delete_download_task''',
    ('restricted', '管理 / 系统 / 在线媒体功能；仅本地模式禁用'): '''POST /updateversion
GET /api/search/online
GET /api/search/online_playlist
GET /api/search/online_playlist_detail
GET /api/proxy/real-url
GET /api/proxy/plugin-url
POST /api/play/getMediaSource
POST /api/play/getLyric
POST /api/device/pushUrl
POST /api/device/pushList
POST /debug_play_by_music_url
POST /downloadjson
POST /downloadplaylist
POST /downloadonemusic
POST /resume_download
POST /restart_download
POST /uploadytdlpcookie
POST /uploadmusic
GET /proxy/{type}
GET /proxy''',
    ('restricted', '管理 / 插件；仅本地模式禁用安装与启用'): '''PUT /api/js-plugins/{plugin_name}/enable
POST /api/js-plugins/upload
POST /api/js-plugins/import-online''',
    ('restricted', '管理 / 高级；在线服务配置与同步禁用'): '''GET /api/lxServer/test
POST /api/lxServer/toggle
POST /api/lxServer/updateUrl
POST /api/lxServer/updatePlatforms
POST /api/lxServer/updateAuth
GET /api/lxServer/userList
GET /api/lxServer/pullPlaylist
GET /api/lxServer/convertPlaylist
POST /api/lxServer/deletePlaylists
POST /api/lxServer/clearXiaomusicPlaylists
POST /api/plugin-source/refresh
POST /api/plugin-source/updateUrl
POST /api/back-conf/update
POST /api/advanced-config/update
POST /api/box-play-platform/update''',
    ('internal', '页面 / 文档 / 状态推送 / 资源传输，无独立按钮'): '''GET /
GET /openapi.json
GET /music/{file_path:path}
OPTIONS /music/{file_path:path}
GET /picture/{file_path:path}
GET /generate_ws_token
WEBSOCKET /ws/playingmusic''',
    ('equivalent', '批量歌曲详情；功能使用 /musicinfo 单曲读取覆盖，无单独批量 API 操作台'): '''GET /musicinfos
POST /musicinfos''',
}


def inventory():
    entries = {}
    for (status, entry), routes in GROUPS.items():
        for route in routes.splitlines():
            if route in entries:
                raise AssertionError(f'Duplicate route: {route}')
            entries[route] = {'route': route, 'status': status, 'entry': entry}
    actual = set()
    for file in [*ROOT.glob('xiaomusic/api/routers/*.py'), ROOT / 'xiaomusic/api/websocket.py']:
        for node in ast.walk(ast.parse(file.read_text())):
            if not isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                continue
            for decorator in node.decorator_list:
                if (isinstance(decorator, ast.Call)
                        and isinstance(decorator.func, ast.Attribute)
                        and decorator.func.attr in {'get', 'post', 'put', 'delete', 'patch', 'options', 'websocket'}
                        and decorator.args and isinstance(decorator.args[0], ast.Constant)):
                    actual.add(f'{decorator.func.attr.upper()} {decorator.args[0].value}')
    assert actual == set(entries), f'Unclassified: {actual - set(entries)}; obsolete: {set(entries) - actual}'
    return [entries[key] for key in sorted(entries)]


if __name__ == '__main__':
    rows = inventory()
    target = ROOT / 'xiaomusic/static/library/route-coverage.json'
    target.write_text(json.dumps(rows, ensure_ascii=False, indent=2) + '\n')
    report = ['# UI 功能迁移清单', '', '按当前路由声明核对，包含 OPTIONS。active 表示有工作流入口，不代表已在生产执行；restricted 为用户确认保留禁用的在线能力。', '', '| 方法 / 路径 | 状态 | 入口 / 说明 |', '| --- | --- | --- |']
    report += [f"| `{row['route']}` | {row['status']} | {row['entry']} |" for row in rows]
    (ROOT / 'docs/ui-route-coverage.md').write_text('\n'.join(report) + '\n')
    print(json.dumps({s: sum(r['status'] == s for r in rows) for s in sorted({r['status'] for r in rows})}))
