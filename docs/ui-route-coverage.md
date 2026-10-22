# UI 功能迁移清单

按当前路由声明核对，包含 OPTIONS。active 表示有工作流入口，不代表已在生产执行；restricted 为用户确认保留禁用的在线能力。

| 方法 / 路径 | 状态 | 入口 / 说明 |
| --- | --- | --- |
| `DELETE /api/js-plugins/{plugin_name}/uninstall` | active | 管理 / 插件 |
| `GET /` | internal | 页面 / 文档 / 状态推送 / 资源传输，无独立按钮 |
| `GET /api/advanced-config/load` | active | 管理 / 高级（只读状态） |
| `GET /api/back-conf/load` | active | 管理 / 高级（只读状态） |
| `GET /api/box-play-platform/load` | active | 管理 / 高级（只读状态） |
| `GET /api/debug/simulate_token_expire` | active | 管理 / 系统 |
| `GET /api/get_qrcode` | active | 设置 |
| `GET /api/js-plugins` | active | 管理 / 插件 |
| `GET /api/lxServer/convertPlaylist` | restricted | 管理 / 高级；在线服务配置与同步禁用 |
| `GET /api/lxServer/load` | active | 管理 / 高级（只读状态） |
| `GET /api/lxServer/pullPlaylist` | restricted | 管理 / 高级；在线服务配置与同步禁用 |
| `GET /api/lxServer/test` | restricted | 管理 / 高级；在线服务配置与同步禁用 |
| `GET /api/lxServer/userList` | restricted | 管理 / 高级；在线服务配置与同步禁用 |
| `GET /api/password/check` | active | 管理 / 插件 |
| `GET /api/platforms` | active | 管理 / 高级（只读状态） |
| `GET /api/plugin-source/load` | active | 管理 / 高级（只读状态） |
| `GET /api/proxy/plugin-url` | restricted | 管理 / 系统 / 在线媒体功能；仅本地模式禁用 |
| `GET /api/proxy/real-url` | restricted | 管理 / 系统 / 在线媒体功能；仅本地模式禁用 |
| `GET /api/search/online` | restricted | 管理 / 系统 / 在线媒体功能；仅本地模式禁用 |
| `GET /api/search/online_playlist` | restricted | 管理 / 系统 / 在线媒体功能；仅本地模式禁用 |
| `GET /api/search/online_playlist_detail` | restricted | 管理 / 系统 / 在线媒体功能；仅本地模式禁用 |
| `GET /cmdstatus` | active | 媒体库 / 播放器 / 播放列表 |
| `GET /curplaylist` | active | 媒体库 / 播放器 / 播放列表 |
| `GET /device_list` | active | 设置 |
| `GET /docs` | active | 管理 / 系统 |
| `GET /download_progress` | active | 管理 / 系统 |
| `GET /downloadlog` | active | 设置 |
| `GET /generate_ws_token` | internal | 页面 / 文档 / 状态推送 / 资源传输，无独立按钮 |
| `GET /getplayerstatus` | active | 管理 / 设备 |
| `GET /getsetting` | active | 设置 |
| `GET /getversion` | active | 管理 / 系统 |
| `GET /getvolume` | active | 媒体库 / 播放器 / 播放列表 |
| `GET /latestversion` | active | 管理 / 系统 |
| `GET /music/{file_path:path}` | internal | 页面 / 文档 / 状态推送 / 资源传输，无独立按钮 |
| `GET /musicinfo` | active | 媒体库 / 播放器 / 播放列表 |
| `GET /musicinfos` | equivalent | 批量歌曲详情；功能使用 /musicinfo 单曲读取覆盖，无单独批量 API 操作台 |
| `GET /musiclist` | active | 媒体库 / 播放器 / 播放列表 |
| `GET /openapi.json` | internal | 页面 / 文档 / 状态推送 / 资源传输，无独立按钮 |
| `GET /picture/{file_path:path}` | internal | 页面 / 文档 / 状态推送 / 资源传输，无独立按钮 |
| `GET /playingmusic` | active | 媒体库 / 播放器 / 播放列表 |
| `GET /playlistmusics` | active | 管理 / 歌单 |
| `GET /playlistnames` | active | 管理 / 歌单 |
| `GET /playtts` | active | 管理 / 设备 |
| `GET /playurl` | active | 管理 / 设备 |
| `GET /proxy` | restricted | 管理 / 系统 / 在线媒体功能；仅本地模式禁用 |
| `GET /proxy/{type}` | restricted | 管理 / 系统 / 在线媒体功能；仅本地模式禁用 |
| `GET /redoc` | active | 管理 / 系统 |
| `GET /searchmusic` | active | 媒体库 / 播放器 / 播放列表 |
| `OPTIONS /music/{file_path:path}` | internal | 页面 / 文档 / 状态推送 / 资源传输，无独立按钮 |
| `POST /api/advanced-config/update` | restricted | 管理 / 高级；在线服务配置与同步禁用 |
| `POST /api/back-conf/update` | restricted | 管理 / 高级；在线服务配置与同步禁用 |
| `POST /api/box-play-platform/update` | restricted | 管理 / 高级；在线服务配置与同步禁用 |
| `POST /api/device/pushList` | restricted | 管理 / 系统 / 在线媒体功能；仅本地模式禁用 |
| `POST /api/device/pushUrl` | restricted | 管理 / 系统 / 在线媒体功能；仅本地模式禁用 |
| `POST /api/file/cleantempdir` | active | 设置 |
| `POST /api/js-plugins/import-online` | restricted | 管理 / 插件；仅本地模式禁用安装与启用 |
| `POST /api/js-plugins/upload` | restricted | 管理 / 插件；仅本地模式禁用安装与启用 |
| `POST /api/lxServer/clearXiaomusicPlaylists` | restricted | 管理 / 高级；在线服务配置与同步禁用 |
| `POST /api/lxServer/deletePlaylists` | restricted | 管理 / 高级；在线服务配置与同步禁用 |
| `POST /api/lxServer/toggle` | restricted | 管理 / 高级；在线服务配置与同步禁用 |
| `POST /api/lxServer/updateAuth` | restricted | 管理 / 高级；在线服务配置与同步禁用 |
| `POST /api/lxServer/updatePlatforms` | restricted | 管理 / 高级；在线服务配置与同步禁用 |
| `POST /api/lxServer/updateUrl` | restricted | 管理 / 高级；在线服务配置与同步禁用 |
| `POST /api/music/refreshlist` | active | 设置 |
| `POST /api/password/verify` | active | 管理 / 插件 |
| `POST /api/play/getLyric` | restricted | 管理 / 系统 / 在线媒体功能；仅本地模式禁用 |
| `POST /api/play/getMediaSource` | restricted | 管理 / 系统 / 在线媒体功能；仅本地模式禁用 |
| `POST /api/plugin-source/refresh` | restricted | 管理 / 高级；在线服务配置与同步禁用 |
| `POST /api/plugin-source/updateUrl` | restricted | 管理 / 高级；在线服务配置与同步禁用 |
| `POST /api/system/modifiysetting` | active | 设置 |
| `POST /clear_completed_tasks` | active | 管理 / 系统 |
| `POST /cmd` | active | 媒体库 / 播放器 / 播放列表 |
| `POST /debug_play_by_music_url` | restricted | 管理 / 系统 / 在线媒体功能；仅本地模式禁用 |
| `POST /delete_download_task` | active | 管理 / 系统 |
| `POST /delmusic` | active | 管理 / 媒体 |
| `POST /device/stop` | active | 媒体库 / 播放器 / 播放列表 |
| `POST /downloadjson` | restricted | 管理 / 系统 / 在线媒体功能；仅本地模式禁用 |
| `POST /downloadonemusic` | restricted | 管理 / 系统 / 在线媒体功能；仅本地模式禁用 |
| `POST /downloadplaylist` | restricted | 管理 / 系统 / 在线媒体功能；仅本地模式禁用 |
| `POST /musicinfos` | equivalent | 批量歌曲详情；功能使用 /musicinfo 单曲读取覆盖，无单独批量 API 操作台 |
| `POST /pause_download` | active | 管理 / 系统 |
| `POST /playlistadd` | active | 管理 / 歌单 |
| `POST /playlistaddmusic` | active | 管理 / 歌单 |
| `POST /playlistdel` | active | 管理 / 歌单 |
| `POST /playlistdelmusic` | active | 管理 / 歌单 |
| `POST /playlistupdatemusic` | active | 管理 / 歌单 |
| `POST /playlistupdatename` | active | 管理 / 歌单 |
| `POST /playmusic` | active | 媒体库 / 播放器 / 播放列表 |
| `POST /playmusiclist` | active | 媒体库 / 播放器 / 播放列表 |
| `POST /refreshmusictag` | active | 设置 |
| `POST /restart_download` | restricted | 管理 / 系统 / 在线媒体功能；仅本地模式禁用 |
| `POST /resume_download` | restricted | 管理 / 系统 / 在线媒体功能；仅本地模式禁用 |
| `POST /savesetting` | active | 设置 |
| `POST /setmusictag` | active | 管理 / 媒体 |
| `POST /setvolume` | active | 媒体库 / 播放器 / 播放列表 |
| `POST /stop_download` | active | 管理 / 系统 |
| `POST /updateversion` | restricted | 管理 / 系统 / 在线媒体功能；仅本地模式禁用 |
| `POST /uploadmusic` | restricted | 管理 / 系统 / 在线媒体功能；仅本地模式禁用 |
| `POST /uploadytdlpcookie` | restricted | 管理 / 系统 / 在线媒体功能；仅本地模式禁用 |
| `PUT /api/js-plugins/{plugin_name}/disable` | active | 管理 / 插件 |
| `PUT /api/js-plugins/{plugin_name}/enable` | restricted | 管理 / 插件；仅本地模式禁用安装与启用 |
| `WEBSOCKET /ws/playingmusic` | internal | 页面 / 文档 / 状态推送 / 资源传输，无独立按钮 |
