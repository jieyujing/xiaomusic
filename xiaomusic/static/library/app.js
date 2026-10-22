/* XiaoMusic local library. No remote assets, analytics, or browser audio. */
"use strict";
(() => {
  const icons = {
    library:
      '<rect x="3" y="3" width="7" height="18" rx="1"/><path d="M14 3v18m4-17 3 16"/>',
    folder:
      '<path d="M3 7V5a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z"/>',
    queue: '<path d="M4 5h16M4 11h16M4 17h8m5-2 4 3-4 3z"/>',
    settings:
      '<path d="m9 3-1 3-3 1-2 3 2 2-1 3 2 3 3-1 3 2 3-2 3 1 2-3-1-3 2-2-2-3-3-1-1-3Z"/><circle cx="12" cy="11" r="3"/>',
    speaker:
      '<rect x="6" y="2" width="12" height="20" rx="3"/><circle cx="12" cy="14" r="3"/><path d="M11 6h2"/>',
    chevron: '<path d="m8 10 4 4 4-4"/>',
    search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/>',
    refresh:
      '<path d="M20 7v5h-5M4 17v-5h5"/><path d="M6 7a7 7 0 0 1 12-2l2 3M4 16l2 3a7 7 0 0 0 12-2"/>',
    close: '<path d="m6 6 12 12M6 18 18 6"/>',
    play: '<path d="m9 5 11 7-11 7Z" fill="currentColor" stroke-width="0"/>',
    stop: '<rect x="6" y="6" width="12" height="12" rx="1" fill="currentColor" stroke-width="0"/>',
    previous: '<path d="M5 5v14m14-14L8 12l11 7Z" fill="currentColor"/>',
    next: '<path d="M19 5v14M5 5l11 7-11 7Z" fill="currentColor"/>',
    volume:
      '<path d="m11 4-6 5H2v6h3l6 5V4Zm4 4a6 6 0 0 1 0 8m3-11a10 10 0 0 1 0 14"/>',
    back: '<path d="m14 6-6 6 6 6"/>',
    heart:
      '<path d="M20 5a5 5 0 0 0-8 1 5 5 0 0 0-8-1c-3 4 1 8 8 14 7-6 11-10 8-14Z"/>',
    music:
      '<path d="M9 18V5l11-2v13M9 8l11-2"/><ellipse cx="6" cy="18" rx="3" ry="2"/><ellipse cx="17" cy="16" rx="3" ry="2"/>',
  };
  const $ = (selector) => document.querySelector(selector);
  const $$ = (selector) => [...document.querySelectorAll(selector)];
  const icon = (name) =>
    `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[name] || icons.music}</svg>`;
  const esc = (value) =>
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
  const read = (key, fallback = "") => {
    try {
      return localStorage.getItem(`xm-library-${key}`) ?? fallback;
    } catch {
      return fallback;
    }
  };
  const store = (key, value) => {
    try {
      localStorage.setItem(`xm-library-${key}`, value);
    } catch {
      /* Storage is optional. */
    }
  };
  const pageSize = [30, 60, 100].includes(Number(read("page-size")))
    ? Number(read("page-size"))
    : 60;
  const state = {
    view: "library",
    tab: "songs",
    group: null,
    query: "",
    page: 1,
    pageSize,
    lists: {},
    names: [],
    tags: new Map(),
    devices: [],
    did: read("device"),
    settings: {},
    queue: null,
    playing: null,
    volume: null,
    busy: false,
    loading: true,
    loadError: false,
    statusError: false,
    metadataError: false,
    metadataLoading: false,
    generation: 0,
    deviceGeneration: 0,
    polling: false,
    refreshing: false,
    searchResults: null,
    searchPending: false,
    searchGeneration: 0,
    ws: null,
    wsHealthy: false,
    reconnectTimer: null,
    socketGeneration: 0,
    settingBusy: false,
    qrBusy: false,
    qrMessage: "",
    qrImage: "",
  };
  const viewTitles = {
    library: "媒体库",
    folders: "播放列表",
    queue: "当前播放列表",
    settings: "设置",
    manage: "管理",
  };
  const modes = ["单曲循环", "全部循环", "随机播放", "单曲播放", "顺序播放"];
  const palette = [
    ["#35443a", "#c8d6ab"],
    ["#514038", "#edbe9c"],
    ["#38444c", "#bed0d8"],
    ["#494339", "#e5d2a8"],
    ["#46404e", "#cfc4d9"],
    ["#3d4846", "#bdd2c5"],
  ];
  let toastTimer, searchTimer;

  const settingsPanel = window.XiaoMusicSettings({
    api,
    toast,
    getPageSize: () => state.pageSize,
    onSaved: async () => {
      state.tags.clear();
      await load();
    },
  });
  const managePanel = window.XiaoMusicManage({
    api,
    toast,
    command,
    clearToast: () => {
      clearTimeout(toastTimer);
      $("#toast").hidden = true;
    },
    getDevices: () => state.devices,
    getNames: () => state.names,
    onChanged: async () => {
      state.tags.clear();
      await load();
    },
  });
  function stampIcons(root = document) {
    root.querySelectorAll("[data-icon]").forEach((el) => {
      el.innerHTML = icon(el.dataset.icon);
    });
  }
  async function api(path, body) {
    let response;
    try {
      response = await fetch(path, {
        method: body === undefined ? "GET" : "POST",
        credentials: "same-origin",
        cache: "no-store",
        ...(body === undefined
          ? {}
          : {
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(body),
            }),
        signal: AbortSignal.timeout(30000),
      });
    } catch {
      throw new Error(
        body === undefined
          ? "连接超时，请检查服务后重试。"
          : "请求未确认，请先检查音箱状态再操作。",
      );
    }
    if (response.status === 401)
      throw new Error("登录已失效，请刷新页面重新登录。");
    if (!response.ok)
      throw new Error(`服务暂时不可用（${response.status}），请稍后重试。`);
    const data = await response.json();
    if (data?.ret && data.ret !== "OK")
      throw new Error(
        data.ret === "Did not exist"
          ? "音箱不可用，请重新选择设备。"
          : "操作未完成，请刷新状态后重试。",
      );
    if (data?.success === false) throw new Error("操作未完成，请稍后重试。");
    return data;
  }
  function toast(message, error = false) {
    clearTimeout(toastTimer);
    $("#toast").textContent = message;
    $("#toast").classList.toggle("error", error);
    $("#toast").hidden = false;
    toastTimer = setTimeout(
      () => {
        $("#toast").hidden = true;
      },
      error ? 7000 : 3500,
    );
  }
  function notice(message = "") {
    $("#connection").textContent = message;
    $("#connection").hidden = !message;
  }
  function clock(seconds) {
    const n = Math.max(0, Math.floor(Number(seconds) || 0));
    return n >= 3600
      ? `${Math.floor(n / 3600)}:${String(Math.floor(n / 60) % 60).padStart(2, "0")}:${String(n % 60).padStart(2, "0")}`
      : `${Math.floor(n / 60)}:${String(n % 60).padStart(2, "0")}`;
  }
  function meta(name) {
    const tags = state.tags.get(name) || {};
    return {
      title: tags.title || name,
      artist: tags.artist || "未知歌手",
      album: tags.album || "未标注专辑",
      duration: Number(tags.duration) || 0,
      picture: tags.picture || "",
    };
  }
  function pictureURL(value) {
    if (!value) return "";
    try {
      const url = new URL(value, location.origin);
      // Cached artwork is always requested from this server, never a tag's remote host.
      return /^https?:$/.test(url.protocol) &&
        url.pathname.startsWith("/picture/")
        ? url.pathname + url.search
        : "";
    } catch {
      return "";
    }
  }
  function cover(name, className = "cover") {
    const info = meta(name);
    const hash = [
      ...String(info.album === "未标注专辑" ? name : info.album),
    ].reduce((a, c) => (a + c.codePointAt(0)) % palette.length, 0);
    const [bg, fg] = palette[hash];
    const fallback = `<span class="cover-fallback" style="--art-bg:${bg};--art-fg:${fg}">${esc([...info.title.trim()][0] || "♪")}</span>`;
    const url = pictureURL(info.picture);
    return `<span class="${className}" aria-hidden="true">${url ? `<img src="${esc(url)}" alt="" loading="lazy" decoding="async">` : fallback}</span>`;
  }
  // Broken artwork falls back without an inline event handler or another network request.
  document.addEventListener(
    "error",
    (event) => {
      if (
        event.target instanceof HTMLImageElement &&
        event.target.closest(
          ".cover,.mini-cover,.large-cover,.group-art,.cover-fallback",
        )
      ) {
        const parent = event.target.parentElement;
        parent.replaceChildren(
          Object.assign(document.createElement("span"), {
            className: "cover-fallback",
            textContent: "♪",
          }),
        );
      }
    },
    true,
  );
  function empty(title, description, retry = false) {
    return `<div class="empty-state"><span data-icon="${state.view === "folders" ? "folder" : "music"}"></span><h3>${esc(title)}</h3><p>${esc(description)}</p>${retry ? '<button class="button" data-retry>重新加载</button>' : ""}</div>`;
  }
  function folders() {
    // /musiclist is authoritative: system, directory and user playlists all remain available.
    return Object.entries(state.lists).filter(
      ([name]) =>
        name !== "所有电台" &&
        !name.startsWith("_online_") &&
        !name.startsWith("_xiaomusic_ui_"),
    );
  }
  function groups() {
    const field = state.tab === "artists" ? "artist" : "album";
    const result = new Map();
    for (const name of state.names) {
      const info = meta(name);
      // Albums by different artists should never silently merge.
      const key =
        field === "album"
          ? JSON.stringify([info.album, info.artist])
          : info.artist;
      if (!result.has(key))
        result.set(key, {
          key,
          title: info[field],
          subtitle: field === "album" ? info.artist : "",
          names: [],
        });
      result.get(key).names.push(name);
    }
    return [...result.values()].sort((a, b) =>
      a.title.localeCompare(b.title, "zh-CN"),
    );
  }
  function matches(name) {
    const q = state.query.trim().toLocaleLowerCase();
    const info = meta(name);
    return (
      !q ||
      state.searchResults?.has(name) ||
      [name, info.title, info.artist, info.album].some((text) =>
        String(text).toLocaleLowerCase().includes(q),
      )
    );
  }
  function trackRows(names, queue = false) {
    const pages = Math.max(1, Math.ceil(names.length / state.pageSize));
    state.page = Math.min(Math.max(1, state.page), pages);
    const start = (state.page - 1) * state.pageSize;
    const items = names.slice(start, start + state.pageSize);
    return `<div class="list-header" aria-hidden="true"><span>#</span><span>标题 / 歌手</span><span class="album-heading">专辑</span><span>时长</span><span></span></div><div class="track-list">${items
      .map((name, index) => {
        const info = meta(name);
        const current = state.playing?.cur_music === name;
        return `<div class="track${current ? " current" : ""}"><span class="track-number">${current && state.playing.is_playing ? "♫" : start + index + 1}</span><button class="track-title" data-play="${esc(name)}" ${queue ? "data-from-queue" : ""} ${!state.did || state.busy ? "disabled" : ""} aria-label="播放 ${esc(info.title)}">${cover(name)}<span class="track-copy"><strong>${esc(info.title)}</strong><small>${esc(info.artist)}</small></span></button><span class="track-album">${esc(info.album)}</span><span class="track-duration">${info.duration ? clock(info.duration) : "—"}</span><button class="icon-button" data-play="${esc(name)}" ${queue ? "data-from-queue" : ""} ${!state.did || state.busy ? "disabled" : ""} aria-label="播放 ${esc(info.title)}">${icon("play")}</button></div>`;
      })
      .join(
        "",
      )}</div>${pages > 1 ? `<div class="pagination"><button class="button" data-page="${state.page - 1}" ${state.page === 1 ? "disabled" : ""}>上一页</button><span>${state.page} / ${pages}</span><button class="button" data-page="${state.page + 1}" ${state.page === pages ? "disabled" : ""}>下一页</button></div>` : ""}`;
  }
  function summary(count, extra = "", playable = true) {
    return `<div class="list-summary"><span>${count.toLocaleString()} 首${extra ? ` · ${esc(extra)}` : ""}</span><div class="summary-actions">${playable && count ? `<button class="button primary" data-play-all ${!state.did || state.busy ? "disabled" : ""}>${icon("play")}播放全部</button>` : ""}</div></div>`;
  }
  function render() {
    const library = state.view === "library";
    $("#intro").hidden = !library || !!state.group || !!state.query;
    $("#breadcrumb-title").textContent = viewTitles[state.view];
    $("#section-title").textContent =
      state.group?.title ||
      (library
        ? state.query
          ? "搜索本地收藏"
          : "我的媒体库"
        : viewTitles[state.view]);
    $("#section-kicker").textContent = {
      library: "LOCAL LIBRARY",
      folders: "PLAYLISTS",
      queue: "CURRENT PLAYLIST",
      settings: "PREFERENCES",
      manage: "MANAGEMENT",
    }[state.view];
    $("#library-tools").hidden = !["library", "folders"].includes(state.view);
    $(".tabs").hidden = !library || !!state.group;
    $("#clear-search").hidden = !state.query;
    $$(".main-nav [data-view]").forEach((button) => {
      button.classList.toggle("active", button.dataset.view === state.view);
      button.setAttribute(
        "aria-current",
        button.dataset.view === state.view ? "page" : "false",
      );
    });
    $$("[data-tab]").forEach((button) => {
      button.setAttribute(
        "aria-selected",
        String(button.dataset.tab === state.tab),
      );
      button.tabIndex = button.dataset.tab === state.tab ? 0 : -1;
    });
    $("#library-stats").innerHTML =
      `<span><b>${state.names.length.toLocaleString()}</b>首歌曲</span><span><b>${folders().length}</b>个列表</span><span><b>${state.devices.length}</b>台音箱</span>`;
    const content = $("#content");
    content.setAttribute("aria-busy", String(state.loading));
    if (state.loading)
      content.innerHTML = empty("正在打开你的收藏", "读取本地媒体库…");
    else if (state.loadError)
      content.innerHTML = empty(
        "暂时连接不上媒体库",
        "检查服务连接后，点击重新加载。",
        true,
      );
    else if (state.view === "manage") {
      if (content.firstElementChild !== managePanel.element)
        content.replaceChildren(managePanel.element);
      managePanel.open();
    } else if (state.view === "settings") {
      if (content.firstElementChild !== settingsPanel.element)
        content.replaceChildren(settingsPanel.element);
      settingsPanel.open();
    } else if (state.view === "queue") {
      if (!state.did)
        content.innerHTML = empty(
          "先选择一台音箱",
          "当前播放列表会跟随所选音箱显示。",
        );
      else if (!state.queue)
        content.innerHTML = empty(
          "播放列表暂时不可用",
          "请重新加载状态后重试。",
          true,
        );
      else if (!state.queue.names.length)
        content.innerHTML = empty(
          "播放列表还是空的",
          "从媒体库选择一首歌曲，开始聆听。",
        );
      else
        content.innerHTML =
          summary(
            state.queue.names.length,
            `${state.queue.playlist} · ${modes[state.queue.play_type] || "当前模式"}`,
            false,
          ) +
          `<p class="list-note">按媒体库列表显示；随机播放时，音箱的实际下一首可能不同。</p>` +
          trackRows(state.queue.names, true);
    } else if (!state.names.length)
      content.innerHTML = empty(
        "收藏室等待第一首歌",
        "将媒体放入已配置的本地目录，再到设置中扫描媒体库。",
      );
    else if (
      state.group ||
      (library && ["songs", "favorites"].includes(state.tab))
    ) {
      const names = currentNames();
      content.innerHTML =
        (state.group
          ? `<button class="back-button" data-back>${icon("back")}返回${state.view === "folders" ? "播放列表" : state.tab === "artists" ? "歌手" : "专辑"}</button>`
          : "") +
        summary(
          names.length,
          state.searchPending
            ? "正在搜索…"
            : (state.group && library) || state.query.trim()
              ? "选择歌曲点播"
              : "",
          !((state.group && library) || state.query.trim()),
        ) +
        (names.length
          ? trackRows(names)
          : empty(
              "没有找到匹配内容",
              "试试其他歌名、歌手或专辑；这里只搜索本地收藏。",
            ));
    } else {
      const isFolder = state.view === "folders";
      const candidates = isFolder
        ? folders().map(([key, names]) => ({ key, title: key, names }))
        : groups();
      const query = state.query.trim().toLocaleLowerCase();
      const entries = candidates.filter(
        (entry) =>
          !query ||
          entry.title.toLocaleLowerCase().includes(query) ||
          entry.names.some(matches),
      );
      state.groupEntries = entries;
      content.innerHTML =
        `<div class="list-summary"><span>${entries.length} ${isFolder ? "个列表" : state.tab === "artists" ? "位歌手" : "张专辑"}${state.metadataLoading && !isFolder ? " · 正在整理标签…" : state.metadataError ? " · 部分标签未加载，点击刷新重试" : ""}</span></div>` +
        (entries.length
          ? `<div class="group-grid">${entries.map((entry, index) => `<button class="group-card ${isFolder ? "folder" : state.tab === "artists" ? "artist" : ""}" data-group="${index}" aria-label="${esc(entry.title)} ${entry.names.length} 首">${isFolder ? `<span class="group-art">${icon("folder")}<span class="folder-total">${entry.names.length}</span></span>` : cover(entry.names[0], "group-art")}<strong>${esc(entry.title)}</strong><small>${entry.subtitle ? esc(entry.subtitle) + " · " : ""}${entry.names.length} 首</small></button>`).join("")}</div>`
          : empty("没有找到匹配内容", "试试其他关键词，或清除搜索。"));
    }
    stampIcons(content);
    updateControls();
  }
  function updateControls() {
    const unavailable = !state.did || state.busy;
    $(".player-dock").setAttribute("aria-busy", String(state.busy));
    $$("[data-action]").forEach((button) => {
      button.disabled =
        unavailable ||
        (button.dataset.action === "toggle" &&
          !state.playing?.cur_music &&
          !state.names.length);
    });
    $("#device-select").disabled =
      state.busy || state.loading || !state.devices.length;
    $("#volume").disabled = unavailable || state.volume === null;
    $("#play-mode").disabled = unavailable;
    $("#reload").disabled = state.loading || state.busy;
  }
  function resetDeviceState() {
    state.playing = null;
    state.queue = null;
    state.volume = null;
    state.statusError = false;
    $("#volume").value = "0";
    $("#volume-value").textContent = "—";
    updatePlayer();
  }
  function updatePlayer() {
    const current = state.playing?.cur_music;
    const info = current ? meta(current) : null;
    const device = state.devices.find((item) => item.did === state.did);
    $("#now-title").textContent = $("#full-title").textContent =
      info?.title || "选一首，开始聆听";
    $("#now-artist").textContent = $("#full-artist").textContent =
      info?.artist || "播放到你的小爱音箱";
    $("#mini-cover").innerHTML = $("#large-cover").innerHTML = cover(
      current || "音乐",
      "cover-fallback",
    );
    $("#dock-device").textContent = device?.name || "未选择音箱";
    const isPlaying = !!state.playing?.is_playing;
    $$('[data-action="toggle"]').forEach((button) => {
      button.innerHTML = icon(isPlaying ? "stop" : "play");
      button.setAttribute(
        "aria-label",
        isPlaying ? "停止播放" : "播放当前歌曲",
      );
    });
    $("#player-hint").textContent = state.statusError
      ? "状态暂未更新，请检查音箱连接"
      : !device
        ? "请选择音箱和歌曲"
        : isPlaying
          ? `播放设备 · ${device.name}`
          : current
            ? "已停止 · 点击播放将从头开始"
            : `播放设备 · ${device.name}`;
    const duration = Math.max(
      0,
      Number(state.playing?.duration) || info?.duration || 0,
    );
    const offset = Math.min(
      duration || Infinity,
      Math.max(0, Number(state.playing?.offset) || 0),
    );
    $("#elapsed").textContent = $("#full-elapsed").textContent = clock(offset);
    $("#duration").textContent = $("#full-duration").textContent =
      clock(duration);
    $("#progress").value = $("#full-progress").value = duration
      ? (offset / duration) * 100
      : 0;
    $("#queue-count").textContent = state.queue?.names.length || "";
    if (document.activeElement !== $("#play-mode"))
      $("#play-mode").value = String(device?.play_type ?? 2);
    const liked = !!current && (state.lists["收藏"] || []).includes(current);
    $("#favorite").setAttribute("aria-pressed", String(liked));
    $("#favorite").setAttribute(
      "aria-label",
      liked ? "取消收藏当前歌曲" : "收藏当前歌曲",
    );
    $("#favorite").disabled = !current || state.busy;
    $("#favorite-label").textContent = liked ? "已收藏" : "收藏";
    $$("[data-sleep]").forEach((button) => {
      button.disabled = !state.did || state.busy;
    });
    updateControls();
  }
  function applyPlaying(data) {
    if (data.ret !== "OK") return;
    const changed =
      state.playing?.cur_music !== data.cur_music ||
      state.playing?.cur_playlist !== data.cur_playlist;
    state.playing = data;
    state.statusError = false;
    state.queue = {
      names: state.lists[data.cur_playlist] || [],
      playlist: data.cur_playlist || "",
      play_type: state.devices.find((d) => d.did === state.did)?.play_type ?? 2,
    };
    notice("");
    if (changed) {
      render();
      if (state.names.includes(data.cur_music))
        void loadMetadata(state.generation, [data.cur_music]);
    }
    updatePlayer();
  }
  async function poll({ volume = false, settings = false } = {}) {
    const did = state.did,
      generation = state.deviceGeneration;
    if (!did) return;
    const results = await Promise.allSettled([
      api(`/playingmusic?${new URLSearchParams({ did })}`),
      api(`/curplaylist?${new URLSearchParams({ did })}`),
      ...(volume ? [api(`/getvolume?${new URLSearchParams({ did })}`)] : []),
      ...(settings ? [api("/getsetting")] : []),
    ]);
    if (did !== state.did || generation !== state.deviceGeneration) return;
    const [playing, playlist] = results;
    if (settings) {
      const configuration = results[results.length - 1];
      if (configuration.status === "fulfilled")
        applySettings(configuration.value);
    }
    if (playing.status === "fulfilled") applyPlaying(playing.value);
    else {
      state.statusError = true;
      notice("音箱播放状态暂未更新。请检查服务连接，或重新选择音箱。");
    }
    if (playlist.status === "fulfilled" && typeof playlist.value === "string") {
      const changed = state.queue?.playlist !== playlist.value;
      state.queue = {
        names: state.lists[playlist.value] || [],
        playlist: playlist.value,
        play_type: state.devices.find((d) => d.did === did)?.play_type ?? 2,
      };
      if (changed && state.view === "queue") render();
    }
    if (volume && results[2].status === "fulfilled") {
      state.volume = Math.min(
        100,
        Math.max(0, Number(results[2].value.volume) || 0),
      );
      $("#volume").value = String(state.volume);
      $("#volume-value").textContent = String(state.volume);
    }
    updatePlayer();
  }
  function closeSocket() {
    state.socketGeneration++;
    clearTimeout(state.reconnectTimer);
    if (state.ws) {
      state.ws.onclose = null;
      state.ws.close(1000);
    }
    state.ws = null;
    state.wsHealthy = false;
  }
  async function connectSocket() {
    closeSocket();
    const did = state.did,
      generation = state.deviceGeneration,
      socketGeneration = state.socketGeneration;
    if (!did) return;
    const current = () =>
      did === state.did &&
      generation === state.deviceGeneration &&
      socketGeneration === state.socketGeneration;
    const retry = () => {
      if (current() && !document.hidden)
        state.reconnectTimer = setTimeout(connectSocket, 4000);
    };
    try {
      const auth = await api(
        `/generate_ws_token?${new URLSearchParams({ did })}`,
      );
      if (!current()) return;
      const url = new URL("/ws/playingmusic", location.href);
      url.protocol = location.protocol === "https:" ? "wss:" : "ws:";
      url.searchParams.set("token", auth.token);
      const socket = new WebSocket(url);
      state.ws = socket;
      socket.onmessage = (event) => {
        if (!current() || state.ws !== socket) return;
        try {
          const data = JSON.parse(event.data);
          if (data.ret === "OK") {
            state.wsHealthy = true;
            applyPlaying(data);
          }
        } catch {
          /* Retain last valid state; HTTP remains available. */
        }
      };
      socket.onclose = () => {
        if (!current() || state.ws !== socket) return;
        state.ws = null;
        state.wsHealthy = false;
        retry();
      };
      socket.onerror = () => {
        state.wsHealthy = false;
      };
    } catch {
      state.wsHealthy = false;
      retry();
    }
  }
  function applySettings(settings) {
    state.settings = {
      music_path: settings.music_path,
      enable_pull_ask: !!settings.enable_pull_ask,
    };
    const enabled = String(settings.mi_did || "")
      .split(",")
      .map((id) => id.trim())
      .filter(Boolean);
    const devices = Object.values(settings.devices || {});
    state.devices = enabled.map((did) => {
      const device =
        devices.find((device) => device.did === did) || settings.devices?.[did];
      return {
        did,
        name: device?.name || `小爱音箱 ${did}`,
        play_type: device?.play_type ?? 2,
      };
    });
  }
  async function load() {
    if (state.busy) return;
    const generation = ++state.generation;
    state.loading = true;
    state.loadError = false;
    render();
    try {
      const [lists, settings] = await Promise.all([
        api("/musiclist"),
        api("/getsetting"),
      ]);
      if (generation !== state.generation) return;
      state.lists = Object.fromEntries(
        Object.entries(lists).filter(
          ([name, value]) =>
            Array.isArray(value) && !name.startsWith("_online_"),
        ),
      );
      state.names = [
        ...new Set(
          state.lists["所有歌曲"] ||
            state.lists["全部"] ||
            Object.values(state.lists).flat(),
        ),
      ];
      applySettings(settings);
      const enabled = state.devices.map((device) => device.did);
      if (!enabled.includes(state.did)) state.did = enabled[0] || "";
      store("device", state.did);
      $("#device-select").innerHTML = state.devices.length
        ? state.devices
            .map(
              (device) =>
                `<option value="${esc(device.did)}">${esc(device.name)}</option>`,
            )
            .join("")
        : '<option value="">未配置音箱</option>';
      $("#device-select").value = state.did;
      state.deviceGeneration++;
      closeSocket();
      resetDeviceState();
      state.loading = false;
      state.metadataError = false;
      state.metadataLoading = true;
      render();
      notice("");
      void poll({ volume: true });
      void connectSocket();
      void loadMetadata(generation);
    } catch (error) {
      if (generation !== state.generation) return;
      state.loading = false;
      state.loadError = true;
      render();
      notice(error.message);
    }
  }
  async function loadMetadata(
    generation,
    selection = state.names.slice(0, state.pageSize),
  ) {
    const full = selection.length > state.pageSize;
    if (full && state.fullMetadataGeneration === generation) return;
    if (full) state.fullMetadataGeneration = generation;
    const names = selection.filter((name) => !state.tags.has(name));
    if (!names.length) {
      state.metadataLoading = false;
      return;
    }
    state.metadataLoading = true;
    for (let start = 0; start < names.length; start += 6) {
      if (generation !== state.generation) return;
      const batch = await Promise.allSettled(
        names
          .slice(start, start + 6)
          .map((name) =>
            api(
              `/musicinfo?${new URLSearchParams({ name, musictag: "true" })}`,
            ),
          ),
      );
      if (generation !== state.generation) return;
      for (const item of batch) {
        if (item.status === "fulfilled" && item.value.tags)
          state.tags.set(item.value.name, item.value.tags);
        else if (item.status === "rejected") state.metadataError = true;
      }
      if (start + 6 >= names.length) state.metadataLoading = false;
      if (start === 0 || start % 60 === 0 || !state.metadataLoading) {
        if (!state.busy && !state.loading) {
          render();
          updatePlayer();
        }
      }
    }
  }
  function navigate(view) {
    state.view = view;
    state.group = null;
    state.query = "";
    state.searchResults = null;
    state.searchPending = false;
    state.searchGeneration++;
    state.page = 1;
    $("#search").value = "";
    render();
    if (view === "queue") void poll();
    window.scrollTo({ top: 0 });
  }
  function currentNames() {
    const source =
      state.group?.names ||
      (state.tab === "favorites" ? state.lists["收藏"] || [] : state.names);
    return source.filter(matches);
  }
  async function mutate(work, successMessage) {
    if (state.busy) return;
    if (!state.did) {
      toast("请先选择一台音箱。", true);
      return;
    }
    state.busy = true;
    render();
    toast("正在发送到音箱…");
    clearTimeout(toastTimer);
    try {
      await work(state.did);
      await poll();
      toast(successMessage);
    } catch (error) {
      toast(error.message, true);
    } finally {
      state.busy = false;
      render();
      updatePlayer();
    }
  }
  async function play(name, fromQueue = false) {
    if (!state.names.includes(name)) {
      toast("这首歌已不在媒体库中，请刷新列表。", true);
      return;
    }
    await mutate(async (did) => {
      // As in default/md.js: search/individual picks use /playmusic; lists use /playmusiclist.
      if (
        fromQueue ||
        state.query.trim() ||
        (state.group && state.view === "library")
      ) {
        return api("/playmusic", { did, musicname: name, searchkey: "" });
      }
      const listname =
        state.view === "folders" && state.group
          ? state.group.key
          : state.tab === "favorites"
            ? "收藏"
            : state.lists["所有歌曲"]
              ? "所有歌曲"
              : "全部";
      await api("/playmusiclist", { did, listname, musicname: name });
    }, "播放请求已发送到音箱");
  }
  async function command(did, cmd) {
    await api("/cmd", { did, cmd });
    // /cmd is asynchronous: do not mistake an acknowledgement for completion.
    for (let attempt = 0; attempt < 20; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      const result = await api("/cmdstatus");
      if (result.status === "finish") return;
    }
    throw new Error("指令仍在处理中，请稍后刷新状态。");
  }
  function openPlayer() {
    if (!$("#player-dialog").open) $("#player-dialog").showModal();
    if (state.did && !state.busy) void poll({ volume: true });
  }
  document.addEventListener("click", (event) => {
    const button = event.target.closest("button");
    if (!button || button.disabled) return;
    if (button.dataset.view) return navigate(button.dataset.view);
    if (button.dataset.tab) {
      state.tab = button.dataset.tab;
      if (["artists", "albums"].includes(state.tab))
        void loadMetadata(state.generation, state.names);
      state.group = null;
      state.page = 1;
      render();
      return;
    }
    if (button.hasAttribute("data-group")) {
      state.returnScroll = window.scrollY;
      state.returnPage = state.page;
      state.group = state.groupEntries[Number(button.dataset.group)];
      state.page = 1;
      render();
      return;
    }
    if (button.hasAttribute("data-back")) {
      state.group = null;
      state.page = state.returnPage || 1;
      render();
      window.scrollTo({ top: state.returnScroll || 0 });
      return;
    }
    if (button.hasAttribute("data-play")) {
      void play(button.dataset.play, button.hasAttribute("data-from-queue"));
      return;
    }
    if (button.hasAttribute("data-play-all")) {
      const first = currentNames()[0];
      if (first) void play(first);
      return;
    }
    if (button.hasAttribute("data-page")) {
      state.page = Number(button.dataset.page);
      void loadMetadata(
        state.generation,
        currentNames().slice(
          (state.page - 1) * state.pageSize,
          state.page * state.pageSize,
        ),
      );
      render();
      $("#section-title").scrollIntoView({ block: "start" });
      return;
    }
    if (button.hasAttribute("data-retry") || button.id === "reload") {
      void load();
      return;
    }
    if (button.id === "clear-search") {
      state.query = "";
      state.searchResults = null;
      state.searchPending = false;
      state.searchGeneration++;
      state.page = 1;
      $("#search").value = "";
      render();
      $("#search").focus();
      return;
    }
    if (
      button.id === "expand-player" ||
      button.hasAttribute("data-open-player")
    ) {
      openPlayer();
      return;
    }
    if (button.id === "close-player") {
      $("#player-dialog").close();
      return;
    }
    if (button.id === "favorite") {
      const name = state.playing?.cur_music;
      if (!name) return;
      const liked = (state.lists["收藏"] || []).includes(name);
      void mutate(
        async () => {
          await api(liked ? "/playlistdelmusic" : "/playlistaddmusic", {
            name: "收藏",
            music_list: [name],
          });
          const lists = await api("/musiclist");
          state.lists["收藏"] = lists["收藏"] || [];
        },
        liked ? "已取消收藏" : "已加入收藏",
      );
      return;
    }
    if (button.hasAttribute("data-sleep")) {
      const minutes = Number(button.dataset.sleep);
      if (![10, 30, 60].includes(minutes)) return;
      void mutate(async (did) => {
        await command(did, `${minutes}分钟后关机`);
        $("#timer-feedback").textContent = `已设置 ${minutes} 分钟后停止`;
      }, `已设置 ${minutes} 分钟后停止`);
      return;
    }
    if (button.hasAttribute("data-rescan")) {
      if (state.refreshing) return;
      state.refreshing = true;
      render();
      api("/api/music/refreshlist", {})
        .then(async () => {
          await load();
          toast("媒体库已更新");
        })
        .catch((error) => toast(error.message, true))
        .finally(() => {
          state.refreshing = false;
          render();
        });
      return;
    }
    if (button.dataset.action === "toggle") {
      if (state.playing?.is_playing)
        void mutate((did) => api("/device/stop", { did }), "已发送停止请求");
      else void play(state.playing?.cur_music || state.names[0], true);
      return;
    }
    if (
      button.dataset.action === "previous" ||
      button.dataset.action === "next"
    ) {
      void mutate(
        (did) =>
          command(
            did,
            button.dataset.action === "previous" ? "上一首" : "下一首",
          ),
        "切歌指令已处理",
      );
    }
  });
  $("#search").addEventListener("input", (event) => {
    clearTimeout(searchTimer);
    state.query = event.target.value;
    state.page = 1;
    const query = state.query.trim(),
      generation = ++state.searchGeneration;
    state.searchResults = null;
    state.searchPending = !!query;
    searchTimer = setTimeout(async () => {
      render();
      if (!query) return;
      try {
        const results = await api(
          `/searchmusic?${new URLSearchParams({ name: query })}`,
        );
        if (generation !== state.searchGeneration) return;
        state.searchResults = new Set(Array.isArray(results) ? results : []);
      } catch (error) {
        if (generation === state.searchGeneration) toast(error.message, true);
      } finally {
        if (generation === state.searchGeneration) {
          state.searchPending = false;
          render();
        }
      }
    }, 200);
  });
  $("#device-select").addEventListener("change", (event) => {
    state.did = event.target.value;
    state.deviceGeneration++;
    store("device", state.did);
    resetDeviceState();
    render();
    closeSocket();
    void connectSocket();
    void poll({ volume: true });
  });
  $("#volume").addEventListener("input", (event) => {
    $("#volume-value").textContent = event.target.value;
  });
  $("#volume").addEventListener("change", (event) => {
    const volume = Number(event.target.value);
    void mutate(async (did) => {
      try {
        await api("/setvolume", { did, volume });
      } finally {
        await poll({ volume: true });
      }
    }, "音量已更新");
  });
  $("#play-mode").addEventListener("change", (event) => {
    const cmd = modes[Number(event.target.value)];
    if (cmd)
      void mutate(async (did) => {
        await command(did, cmd);
        await poll({ settings: true });
      }, "播放模式指令已处理");
  });
  document.addEventListener("change", (event) => {
    if (event.target.id === "page-size") {
      state.pageSize = Number(event.target.value);
      state.page = 1;
      store("page-size", String(state.pageSize));
    }
  });
  $(".tabs").addEventListener("keydown", (event) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const tabs = $$("[data-tab]");
    const index = tabs.findIndex((tab) => tab.dataset.tab === state.tab);
    const next =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? tabs.length - 1
          : (index + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) %
            tabs.length;
    tabs[next].click();
    tabs[next].focus();
  });
  $("#player-dialog").addEventListener("click", (event) => {
    if (event.target !== $("#player-dialog")) return;
    const rect = event.target.getBoundingClientRect();
    if (
      event.clientX < rect.left ||
      event.clientX > rect.right ||
      event.clientY < rect.top ||
      event.clientY > rect.bottom
    )
      event.target.close();
  });
  window.addEventListener("pagehide", closeSocket);
  stampIcons();
  void load();
  setInterval(async () => {
    if (
      document.hidden ||
      state.loading ||
      state.busy ||
      state.polling ||
      !state.did ||
      state.wsHealthy
    )
      return;
    state.polling = true;
    try {
      await poll();
    } finally {
      state.polling = false;
    }
  }, 4000);
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) closeSocket();
    else if (!state.loading && !state.busy) {
      void connectSocket();
      void poll();
    }
  });
})();
