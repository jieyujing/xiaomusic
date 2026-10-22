# 已审批 UI 的 Docker 部署记录

- 生产地址：http://192.168.100.99:8090/
- 部署目录：`/vol1/1000/DockerData/xiaomusic`
- 新镜像：`xiaomusic:ui-3b102c083d74`
- 镜像 ID：`sha256:f099417d213e074d22cb24a8c4d7ae8ea532052230542c0ec73bcf604409fb73`
- 父镜像（原运行版本）：`xiaomusic:auth-diagnostics-b5c479e8186a`，保留用于回退。
- 发布包与备份：`ui-releases/approved-20261022/`，包含 `Dockerfile`、静态资源包、SHA-256 清单、`compose.before.yml`、权限 0600 的 `conf.before.tar.gz`。

本次镜像仅覆盖 index.html、manifest.json 与 library/ 六个文件。Compose 仅修改 image。实际运行容器已 recreate，健康状态 healthy；后端代码、配置卷、媒体只读挂载保持原部署状态。

生产验收：8 个 HTTP 资源的 SHA-256 与本地审批版完全一致；102 个真实路由中没有缺失的 UI 可用接口；媒体库返回 785 个列表，配置有 1 台启用音箱。真实地址的媒体库、设置、管理页面在 390/1024px 下横向溢出均为 0，无浏览器脚本错误。在线搜索返回 403，既有本地策略继续生效。

验收只执行页面和配置／媒体库读取，没有在生产删除媒体、改写标签、保存设置或发送播放指令；未重新验证音箱实际出声。媒体卷只读，删除文件和写入原文件标签受该权限限制。

回退（在部署目录执行）：

```sh
cp -p ui-releases/approved-20261022/compose.before.yml docker-compose.yml
docker compose up -d --wait
```

普通 UI 回退无需恢复 conf 备份，以免覆盖部署后的用户配置。
