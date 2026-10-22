/* Management workflows use the existing router contracts; no speaker/browser playback engine. */
"use strict";
window.XiaoMusicManage = ({
  api,
  toast,
  getDevices,
  getNames,
  onChanged,
  command,
  clearToast,
}) => {
  const root = document.createElement("div");
  root.className = "manage-editor";
  let mediaDirty = false;
  let section = "",
    busy = false,
    playlist = "",
    songs = [],
    original = [],
    generation = 0;
  const e = (value) =>
    String(value ?? "").replace(
      /[&<>"']/g,
      (c) =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;",
        })[c],
    );
  const button = (label, action, extra = "") =>
    `<button type="button" class="button" data-manage="${action}" ${extra}>${e(label)}</button>`;
  const field = (key, label, value = "", type = "text") =>
    `<label class="manage-field">${e(label)}<input name="${key}" type="${type}" value="${e(value)}" ${type === "password" ? 'autocomplete="new-password"' : ""}></label>`;
  const select = (key, label, values, value = "") =>
    `<label class="manage-field">${e(label)}<select name="${key}">${values
      .map((v) => {
        const [id, label] = Array.isArray(v) ? v : [v, v];
        return `<option value="${e(id)}" ${id === value ? "selected" : ""}>${e(label)}</option>`;
      })
      .join("")}</select></label>`;
  const area = (key, label, value = "") =>
    `<label class="manage-field">${e(label)}<textarea name="${key}" rows="5">${e(value)}</textarea></label>`;
  const card = (title, body) =>
    `<section class="manage-card"><h3>${e(title)}</h3>${body}</section>`;
  const note = (text) => `<p class="manage-note">${e(text)}</p>`;
  const locked = (
    label,
    reason = "仅本地媒体模式：此功能涉及在线媒体，当前禁用。",
  ) =>
    `<div class="manage-locked"><span>${e(label)}</span><span>${e(reason)}</span></div>`;
  const val = (key) => root.querySelector(`[name="${key}"]`)?.value || "";
  const required = (key) => {
    const v = val(key).trim();
    if (!v) {
      const node = root.querySelector(`[name="${key}"]`);
      node.disabled = false;
      node.focus();
      node.setAttribute("aria-invalid", "true");
      throw new Error("请填写必填内容。");
    }
    return v;
  };
  const device = () => required("did");
  const options = () => getDevices().map((d) => [d.did, d.name || d.did]);
  const dirty = () => JSON.stringify(songs) !== JSON.stringify(original);
  const hasDraft = () => dirty() || mediaDirty;
  function status(text, error = false) {
    const node = root.querySelector("[data-manage-status]");
    node.textContent = text;
    node.classList.toggle("error", error);
  }
  async function request(path, method, body) {
    const response = await fetch(path, {
      method,
      credentials: "same-origin",
      cache: "no-store",
      signal: AbortSignal.timeout(30000),
      ...(body === undefined ? {} : { body }),
    });
    if (!response.ok) throw new Error(`服务请求失败（${response.status}）。`);
    const data = await response.json();
    if (data.success === false || (data.ret && data.ret !== "OK"))
      throw new Error("操作未完成，请检查服务状态。");
    return data;
  }
  async function run(task, success = "操作完成") {
    if (busy) return;
    busy = true;
    root.setAttribute("aria-busy", "true");
    status("正在处理…");
    root.querySelectorAll("button,input,select,textarea").forEach((n) => {
      n.dataset.wasDisabled = n.disabled ? "1" : "0";
      n.disabled = true;
    });
    try {
      const result = await task();
      status(result === false ? "已取消操作" : success);
    } catch (error) {
      status(error.message || "请求失败，请重试。", true);
      toast(error.message || "请求失败", true);
    } finally {
      busy = false;
      root.removeAttribute("aria-busy");
      root.querySelectorAll("[data-was-disabled]").forEach((n) => {
        n.disabled = n.dataset.wasDisabled === "1";
        delete n.dataset.wasDisabled;
      });
    }
  }
  function shell() {
    root.innerHTML = `<p class="manage-note">管理本地收藏与音箱。在线媒体相关功能保留入口及说明，当前禁用。</p><div class="manage-tabs" aria-label="管理分类">${[
      ["playlists", "歌单"],
      ["media", "媒体"],
      ["device", "设备"],
      ["plugins", "插件"],
      ["advanced", "高级"],
      ["system", "系统"],
    ]
      .map(([id, label]) =>
        button(label, `section:${id}`, `aria-pressed="${section === id}"`),
      )
      .join(
        "",
      )}</div><p data-manage-status role="status" aria-live="polite"></p><div data-manage-body></div>`;
  }
  function body(html) {
    root.querySelector("[data-manage-body]").innerHTML = html;
  }
  async function show(next) {
    if (hasDraft() && !confirm("存在未保存的修改，放弃修改并切换？")) return;
    clearToast();
    mediaDirty = false;
    section = next;
    playlist = "";
    songs = [];
    original = [];
    const token = ++generation;
    shell();
    await run(async () => {
      if (next === "playlists") {
        const data = await api("/playlistnames");
        if (token !== generation) return;
        body(
          card(
            "自定义歌单",
            note(
              "目录列表由媒体扫描生成；这里编辑自定义歌单。删除歌单不会删除媒体文件。",
            ) +
              select("playlist", "选择歌单", ["", ...(data.names || [])]) +
              `<div class="manage-actions">${button("打开歌单", "playlist-open")}</div>` +
              field("new-name", "新歌单名称") +
              button("创建歌单", "playlist-create"),
          ) + "<div data-playlist-editor></div>",
        );
      } else if (next === "media") {
        body(
          card(
            "媒体标签与文件",
            field("music", "选择本地歌曲") +
              '<datalist id="manage-tracks">' +
              getNames()
                .map((n) => `<option value="${e(n)}"></option>`)
                .join("") +
              "</datalist>" +
              button("读取标签", "media-open"),
          ) + "<div data-media-editor></div>",
        );
        root
          .querySelector('[name="music"]')
          .setAttribute("list", "manage-tracks");
      } else if (next === "device") {
        body(
          card(
            "音箱操作",
            select("did", "目标音箱", options()) +
              `<div class="manage-actions">${button("刷新详细状态", "device-status")}${button("停止播放", "device-stop")}</div><dl data-device-status></dl>` +
              area("tts", "语音播报内容") +
              button("播报", "device-tts") +
              field("cmd", "自定义指令") +
              note(
                "指令由现有命令处理器执行，可能改变播放或媒体状态。提交前请确认内容。",
              ) +
              button("发送指令", "device-command") +
              field("local-url", "本地媒体链接") +
              note(
                "仅接受当前媒体服务根目录内的文件地址，服务端继续校验路径。",
              ) +
              button("播放本地链接", "device-url"),
          ),
        );
      } else if (next === "plugins") {
        const gate = await api("/api/password/check");
        if (gate.data?.required)
          body(
            card(
              "插件管理验证",
              field("plugin-password", "管理密码", "", "password") +
                button("验证并打开", "plugins-unlock"),
            ),
          );
        else await plugins();
      } else if (next === "advanced") {
        const results = await Promise.allSettled(
          [
            "/api/advanced-config/load",
            "/api/back-conf/load",
            "/api/box-play-platform/load",
            "/api/lxServer/load",
            "/api/plugin-source/load",
            "/api/platforms",
          ].map((p) => api(p)),
        );
        const data = (i) =>
          results[i].status === "fulfilled"
            ? results[i].value.data || {}
            : null;
        body(
          card(
            "高级配置",
            note(
              "以下为现有服务中的在线配置。仅本地模式下可以查看状态，相关启用、保存、同步和转换操作禁用。",
            ) +
              (data(0)
                ? note(
                    `自动添加歌曲：${data(0).auto_add_song ? "开" : "关"} · 自动转换歌单：${data(0).auto_convert ? "开" : "关"} · 搜单策略：${data(0).voice_playlist_strategy || "default"}`,
                  )
                : note("高级配置读取失败，请重试。")) +
              locked("自动添加歌曲 / 自动转换歌单") +
              locked("AI 接口配置与密钥") +
              locked("语音搜单策略") +
              locked("保存高级配置"),
          ) +
            card(
              "音乐服务与平台",
              note(
                data(1)
                  ? `后台类型：${data(1).api_type || "未设置"}`
                  : "后台类型读取失败。",
              ) +
                note(
                  data(2)
                    ? `口令搜索平台：${data(2).platform || "未设置"}`
                    : "平台偏好读取失败。",
                ) +
                locked("切换 MusicFree / LXServer") +
                locked("修改口令搜索平台"),
            ) +
            card(
              "LXServer",
              note(
                data(3)
                  ? `服务状态：${data(3).enabled ? "启用" : "停用"}；认证信息不回显。`
                  : "服务配置读取失败。",
              ) +
                [
                  "测试连接",
                  "启停服务",
                  "修改接口地址",
                  "修改平台列表",
                  "更新认证",
                  "用户歌单",
                  "拉取歌单",
                  "转换歌单",
                  "删除远程歌单",
                  "清空已转换歌单",
                ]
                  .map((label) => locked(label))
                  .join(""),
            ) +
            card(
              "插件订阅源",
              note(
                data(4)
                  ? "已读取订阅配置；地址和认证信息不回显。"
                  : "订阅配置读取失败。",
              ) +
                locked("修改订阅地址") +
                locked("刷新订阅源"),
            ),
        );
      } else {
        const version = await api("/getversion");
        body(
          card(
            "下载任务管理",
            note(
              "可以查看、暂停、停止和清理已有任务；新建、继续和重新下载保持禁用。",
            ) +
              button("刷新任务", "tasks-refresh") +
              button("清理过期任务记录", "tasks-clear") +
              "<div data-download-tasks></div>",
          ) +
            card(
              "版本与维护",
              note(`当前版本：${version.version || "未知"}`) +
                button("检查新版本", "version-check") +
                "<p data-version></p>" +
                locked(
                  "在线更新",
                  "本地部署固定运行版本，请通过原有 Docker 部署流程更新。",
                ) +
                `<div class="manage-actions"><a class="button" href="/downloadlog">下载日志</a><a class="button" href="/docs" target="_blank" rel="noopener">接口文档</a><a class="button" href="/redoc" target="_blank" rel="noopener">接口参考</a></div>`,
            ) +
            card(
              "认证诊断",
              note("模拟登录过期会清空当前认证令牌，可能需要重新登录。") +
                button("模拟登录过期", "auth-expire"),
            ) +
            card(
              "在线媒体功能",
              [
                "在线歌曲搜索",
                "在线歌单搜索与详情",
                "在线歌词",
                "远程链接推送",
                "远程歌单推送",
                "音乐上传",
                "单曲下载",
                "歌单下载",
                "远程 JSON 导入",
                "暂停后继续下载",
                "重新下载",
                "媒体代理与地址解析",
                "下载 Cookie 上传",
              ]
                .map((label) => locked(label))
                .join(""),
            ),
        );
      }
    }, "已加载");
  }
  async function plugins() {
    const result = await api("/api/js-plugins");
    body(
      card(
        "已安装插件",
        note(
          "可禁用或卸载已有插件。启用、安装和在线导入会增加在线媒体能力，当前禁用。",
        ) +
          (result.data || [])
            .map(
              (p) =>
                `<div class="manage-plugin"><strong>${e(p.name)}</strong><span>${p.enabled ? "已启用" : "已停用"}</span><div class="manage-actions">${button("禁用", "plugin-disable", `data-plugin="${e(p.name)}" ${!p.enabled ? "disabled" : ""}`)}${button("卸载", "plugin-uninstall", `data-plugin="${e(p.name)}"`)}</div></div>`,
            )
            .join("") +
          (!(result.data || []).length ? note("尚未安装插件。") : "") +
          locked("启用插件") +
          locked("上传 JS 插件") +
          locked("在线导入插件"),
      ),
    );
  }
  function renderSongs() {
    const target = root.querySelector("[data-playlist-editor]");
    target.innerHTML = card(
      playlist,
      field("rename", "歌单名称", playlist) +
        `<div class="manage-actions">${button("重命名", "playlist-rename")}${button("删除歌单", "playlist-delete")}</div>` +
        select("add-song", "添加本地歌曲", getNames()) +
        button("加入歌单", "playlist-add-song") +
        note("上下移动调整顺序，点击“保存顺序”后生效。移除歌曲不会删除文件。") +
        `<ol class="manage-song-list">${songs.map((name, index) => `<li><span>${e(name)}</span><div class="manage-actions">${button("上移", "song-up", `data-index="${index}" ${index === 0 ? "disabled" : ""} aria-label="上移 ${e(name)}"`)}${button("下移", "song-down", `data-index="${index}" ${index === songs.length - 1 ? "disabled" : ""} aria-label="下移 ${e(name)}"`)}${button("移除", "song-remove", `data-index="${index}" aria-label="移除 ${e(name)}"`)}</div></li>`).join("")}</ol><div class="manage-actions">${button("保存顺序", "playlist-save")}${button("放弃排序", "playlist-reset")}</div>` +
        note(dirty() ? "有未保存的顺序修改。" : `${songs.length} 首歌曲`),
    );
  }
  async function openPlaylist(name) {
    const result = await api(
      "/playlistmusics?name=" + encodeURIComponent(name),
    );
    playlist = name;
    songs = [...(result.musics || [])];
    original = [...songs];
    renderSongs();
  }
  async function tasks() {
    const result = await api("/download_progress");
    root.querySelector("[data-download-tasks]").innerHTML =
      Object.entries(result.tasks || {})
        .map(
          ([id, t]) =>
            `<div class="manage-plugin"><strong>${e(t.dirname || "下载任务")}</strong>${note(`${t.status} · ${t.completed}/${t.total} · ${t.progress}%`)}<div class="manage-actions">${button("暂停", "task-pause", `data-task="${e(id)}" ${t.status !== "downloading" ? "disabled" : ""}`)}${button("停止", "task-stop", `data-task="${e(id)}"`)}${button("删除记录", "task-delete", `data-task="${e(id)}" ${["pending", "downloading", "paused"].includes(t.status) ? "disabled" : ""}`)}</div></div>`,
        )
        .join("") || note("没有可显示的任务。服务仅返回活跃及近期完成任务。");
  }
  async function mediaOpen() {
    if (mediaDirty && !confirm("放弃未保存的媒体标签？")) return;
    const name = required("music");
    if (!getNames().includes(name)) throw new Error("请从本地媒体库选择歌曲。");
    const info = await api(
      "/musicinfo?musictag=true&name=" + encodeURIComponent(name),
    );
    const tags = info.tags || {};
    mediaDirty = false;
    root.querySelector("[data-media-editor]").innerHTML = card(
      name,
      note("标签保存到现有标签库；开启“保存标签到文件”时也会写入媒体文件。") +
        `<form data-tags data-name="${e(name)}">${[
          ["title", "标题"],
          ["artist", "艺术家"],
          ["album", "专辑"],
          ["year", "年份"],
          ["genre", "流派"],
        ]
          .map(([key, label]) => field(key, label, tags[key] || ""))
          .join(
            "",
          )}${area("lyrics", "歌词", tags.lyrics || "")}<label class="manage-field">替换封面（JPEG / PNG，最大 5 MB）<input type="file" name="picture" accept="image/jpeg,image/png"></label><div class="manage-actions">${button("保存标签", "media-save")}${button("删除媒体文件", "media-delete")}</div></form>`,
    );
  }
  root.addEventListener("click", (event) => {
    const node = event.target.closest("[data-manage]");
    if (!node || node.disabled || busy) return;
    const action = node.dataset.manage;
    if (action.startsWith("section:")) {
      void show(action.slice(8));
      return;
    }
    if (action === "playlist-reset") {
      songs = [...original];
      renderSongs();
      return;
    }
    if (action === "song-up" || action === "song-down") {
      const i = Number(node.dataset.index),
        j = i + (action === "song-up" ? -1 : 1);
      [songs[i], songs[j]] = [songs[j], songs[i]];
      renderSongs();
      return;
    }
    void run(async () => {
      if (action === "playlist-open") {
        if (dirty() && !confirm("放弃未保存的排序？")) return false;
        await openPlaylist(required("playlist"));
      } else if (action === "playlist-create") {
        if (dirty() && !confirm("放弃未保存的排序并创建歌单？")) return false;
        const name = required("new-name");
        await api("/playlistadd", { name });
        const s = root.querySelector('[name="playlist"]');
        s.add(new Option(name, name));
        s.value = name;
        await openPlaylist(name);
        await onChanged();
      } else if (action === "playlist-rename") {
        const name = required("rename");
        await api("/playlistupdatename", { oldname: playlist, newname: name });
        const s = root.querySelector('[name="playlist"]');
        const option = [...s.options].find((o) => o.value === playlist);
        if (option) {
          option.value = name;
          option.textContent = name;
        }
        playlist = name;
        renderSongs();
        await onChanged();
      } else if (action === "playlist-delete") {
        if (!confirm(`删除歌单“${playlist}”？媒体文件会保留。`)) return false;
        await api("/playlistdel", { name: playlist });
        root
          .querySelector(
            `[name="playlist"] option[value="${CSS.escape(playlist)}"]`,
          )
          ?.remove();
        playlist = "";
        songs = [];
        original = [];
        root.querySelector("[data-playlist-editor]").replaceChildren();
        await onChanged();
      } else if (action === "playlist-add-song" || action === "song-remove") {
        if (dirty()) throw new Error("请先保存或放弃排序，再增删歌曲。");
        const name =
          action === "playlist-add-song"
            ? required("add-song")
            : songs[Number(node.dataset.index)];
        await api(
          action === "playlist-add-song"
            ? "/playlistaddmusic"
            : "/playlistdelmusic",
          { name: playlist, music_list: [name] },
        );
        await openPlaylist(playlist);
        await onChanged();
      } else if (action === "playlist-save") {
        await api("/playlistupdatemusic", {
          name: playlist,
          music_list: songs,
        });
        original = [...songs];
        renderSongs();
        await onChanged();
      } else if (action === "media-open") await mediaOpen();
      else if (action === "media-save") {
        const form = root.querySelector("[data-tags]"),
          payload = { musicname: form.dataset.name };
        for (const key of [
          "title",
          "artist",
          "album",
          "year",
          "genre",
          "lyrics",
        ])
          payload[key] = form.elements[key].value;
        const file = form.elements.picture.files[0];
        payload.picture = "";
        if (file) {
          if (
            !["image/jpeg", "image/png"].includes(file.type) ||
            file.size > 5 * 1024 * 1024
          )
            throw new Error("请选择不超过 5 MB 的 JPEG 或 PNG 图片。");
          payload.picture = await new Promise((resolve, reject) => {
            const r = new FileReader();
            r.onload = () => resolve(r.result.split(",")[1]);
            r.onerror = () => reject(new Error("封面读取失败"));
            r.readAsDataURL(file);
          });
        }
        await api("/setmusictag", payload);
        mediaDirty = false;
        await onChanged();
      } else if (action === "media-delete") {
        const name = root.querySelector("[data-tags]").dataset.name;
        if (!confirm(`永久删除磁盘上的“${name}”？此操作无法撤销。`))
          return false;
        await api("/delmusic", { name });
        const lists = await api("/musiclist");
        if (
          Object.values(lists).some((a) => Array.isArray(a) && a.includes(name))
        )
          throw new Error("服务仍返回该媒体，删除未确认；请检查文件权限。");
        mediaDirty = false;
        root.querySelector("[data-media-editor]").replaceChildren();
        await onChanged();
      } else if (action === "device-status") {
        const result = await api(
          "/getplayerstatus?did=" + encodeURIComponent(device()),
        );
        const s = typeof result === "string" ? JSON.parse(result) : result;
        const detail = s.play_song_detail || {};
        root.querySelector("[data-device-status]").innerHTML =
          `<dt>播放状态</dt><dd>${e({ 0: "停止", 1: "播放", 2: "暂停" }[s.status] || "未知")}</dd><dt>音量</dt><dd>${e(s.volume ?? "未知")}</dd><dt>进度 / 时长（毫秒）</dt><dd>${e(detail.position ?? "—")} / ${e(detail.duration ?? "—")}</dd>`;
      } else if (action === "device-stop")
        await api("/device/stop", { did: device() });
      else if (action === "device-tts")
        await api(
          "/playtts?" +
            new URLSearchParams({ did: device(), text: required("tts") }),
        );
      else if (action === "device-command") {
        const did = device(),
          cmd = required("cmd");
        if (!confirm(`向所选音箱发送指令“${cmd}”？`)) return false;
        await command(did, cmd);
      } else if (action === "device-url")
        await api(
          "/playurl?" +
            new URLSearchParams({ did: device(), url: required("local-url") }),
        );
      else if (action === "plugins-unlock") {
        await api("/api/password/verify", {
          password: required("plugin-password"),
        });
        root.querySelector('[name="plugin-password"]').value = "";
        await plugins();
      } else if (action === "plugin-disable" || action === "plugin-uninstall") {
        if (
          action === "plugin-uninstall" &&
          !confirm(`卸载插件“${node.dataset.plugin}”？`)
        )
          return false;
        await request(
          "/api/js-plugins/" +
            encodeURIComponent(node.dataset.plugin) +
            (action === "plugin-disable" ? "/disable" : "/uninstall"),
          action === "plugin-disable" ? "PUT" : "DELETE",
        );
        await plugins();
      } else if (action === "tasks-refresh") await tasks();
      else if (action === "tasks-clear") {
        const result = await api("/clear_completed_tasks", {});
        await tasks();
        toast(`已清理 ${result.cleared_count} 条超过五分钟的任务记录。`);
      } else if (action.startsWith("task-")) {
        if (
          !confirm(
            "确认" +
              (action === "task-delete" ? "删除任务记录" : "改变下载任务状态") +
              "？",
          )
        )
          return false;
        const path = {
          "task-pause": "/pause_download",
          "task-stop": "/stop_download",
          "task-delete": "/delete_download_task",
        }[action];
        await api(
          path + "?task_id=" + encodeURIComponent(node.dataset.task),
          {},
        );
        await tasks();
      } else if (action === "version-check") {
        const result = await api("/latestversion");
        root.querySelector("[data-version]").textContent =
          "最新版本：" + result.version;
      } else if (action === "auth-expire") {
        if (confirm("清空认证令牌并模拟登录过期？音箱服务可能暂时中断。")) {
          await api("/api/debug/simulate_token_expire");
          toast("已清空令牌，请到设置重新验证登录。");
        }
      }
    });
  });
  root.addEventListener("submit", (event) => event.preventDefault());
  root.addEventListener("input", (event) => {
    event.target.removeAttribute("aria-invalid");
    if (event.target.closest("[data-tags]")) mediaDirty = true;
  });
  window.addEventListener("beforeunload", (event) => {
    if (hasDraft()) {
      event.preventDefault();
      event.returnValue = "";
    }
  });
  return {
    element: root,
    open() {
      if (!section) void show("playlists");
    },
  };
};
