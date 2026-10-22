/* Complete editor for the existing default-page configuration contract. */
"use strict";
window.XiaoMusicSettings = ({
  api,
  toast,
  onSaved,
  getPageSize = () => 60,
}) => {
  const root = document.createElement("div");
  root.className = "settings-editor";
  const state = {
    schema: null,
    values: {},
    draft: {},
    secrets: {},
    devices: [],
    deviceLoaded: false,
    loading: false,
    loaded: false,
    readError: "",
    saving: false,
    discovering: false,
    search: "",
    errors: {},
    opened: new Set(["account"]),
    operation: false,
    qrBusy: false,
    qrMessage: "",
    qrImage: "",
    qrExpires: 0,
  };
  const secretKeys = new Set(["password", "httpauth_password", "cookie"]);
  const locked = {
    hostname: "本地媒体服务地址由当前部署固定。",
    public_port: "本地媒体服务端口由当前部署固定。",
    music_path: "本地媒体根目录固定，不允许通过设置扩大访问范围。",
    download_path: "此目录由配置目录派生；本地媒体模式不下载内容。",
    cache_dir: "此目录由配置目录派生。",
    temp_path: "此目录由配置目录派生。",
    disable_download: "本地媒体模式固定关闭下载功能。",
    music_list_url: "本地媒体模式不导入远程歌单。",
    music_list_json: "本地媒体模式不导入远程歌单。",
    convert_to_mp3: "当前本地媒体模式不转换媒体文件。",
    remove_id3tag: "当前本地媒体模式不改写媒体文件。",
    edge_tts_voice: "当前使用音箱原生语音，不启用在线 Edge-TTS。",
    enable_multi_result_selection: "当前语音点播策略固定关闭多结果选择。",
    multi_result_action: "当前语音点播策略固定使用本地匹配回退。",
    cache_max_size_mb: "本地媒体模式不使用在线歌曲缓存。",
    search_prefix: "本地媒体模式不使用在线搜索或下载。",
    proxy: "本地媒体模式不使用下载代理。",
    web_music_proxy: "本地媒体模式不代理网络歌曲。",
    enable_yt_dlp_cookies: "本地媒体模式不使用下载 Cookie。",
    yt_dlp_cookies_file: "本地媒体模式禁止上传下载 Cookie。",
    keywords_online_play: "本地媒体模式不提供在线播放。",
    keywords_online_playlist_play: "本地媒体模式不提供在线歌单搜索。",
    keywords_singer_play: "本地媒体模式不创建在线歌手歌单。",
  };
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
  const current = (key) =>
    Object.hasOwn(state.draft, key) ? state.draft[key] : state.values[key];
  const dirty = () => Object.keys(state.draft).length;
  const valueText = (value) =>
    value === undefined || value === null
      ? ""
      : typeof value === "object"
        ? JSON.stringify(value, null, 2)
        : String(value);
  const fieldAvailable = (field) =>
    field.type === "file" ||
    Object.hasOwn(state.values, field.key) ||
    secretKeys.has(field.key);
  const help = (field) =>
    locked[field.key] ||
    (!fieldAvailable(field)
      ? "当前服务未返回该参数，请核对服务版本。"
      : secretKeys.has(field.key)
        ? field.key === "cookie" &&
          Object.hasOwn(state.draft, "cookie") &&
          state.draft.cookie === ""
          ? "保存后将清除已保存的 Cookie。"
          : state.secrets[field.key] === "masked"
            ? "密码不回显，留空保持原值。"
            : state.secrets[field.key]
              ? "已设置，留空保持原值。"
              : "尚未设置。"
        : field.key === "crontab_json"
          ? "使用 JSON 格式配置定时任务，留空关闭。"
          : "");
  let qrTimer;

  function setDraft(key, value) {
    const unchanged = secretKeys.has(key)
      ? value === "" || value === "******"
      : valueText(value) === valueText(state.values[key]);
    if (unchanged) delete state.draft[key];
    else state.draft[key] = value;
    delete state.errors[key];
    const field = root.querySelector(`[data-field="${CSS.escape(key)}"]`);
    field?.querySelector(".field-error")?.remove();
    const input = field?.querySelector("[data-setting]");
    input?.removeAttribute("aria-invalid");
    input?.setAttribute("aria-describedby", `setting-${key}-help`);
    const summary = root.querySelector(".config-error-summary");
    summary
      ?.querySelector(`[data-error-target="${CSS.escape(key)}"]`)
      ?.remove();
    if (summary) summary.hidden = !Object.keys(state.errors).length;
    updateSaveState();
  }
  function updateSaveState() {
    root.querySelectorAll("[data-save-settings]").forEach((button) => {
      button.disabled = !dirty() || state.saving || state.loading;
      button.textContent = state.saving ? "正在保存…" : "保存配置";
    });
    root.querySelectorAll("[data-discard-settings]").forEach((button) => {
      button.disabled = !dirty() || state.saving || state.loading;
    });
    root.querySelectorAll("[data-dirty]").forEach((el) => {
      el.textContent = dirty()
        ? `${dirty()} 项未保存`
        : state.readError
          ? "尚未确认最新配置"
          : "已与服务端同步";
    });
    root.querySelectorAll("[data-refresh-settings]").forEach((button) => {
      button.disabled = state.saving || state.loading;
    });
  }
  function fieldHTML(field) {
    const key = field.key,
      id = `setting-${key}`,
      isSecret = secretKeys.has(key);
    const disabled =
      !!locked[key] || !fieldAvailable(field) || state.saving || state.loading;
    let value = isSecret ? state.draft[key] || "" : valueText(current(key));
    const attrs = `id="${id}" name="${esc(key)}" data-setting="${esc(key)}" ${disabled ? "disabled" : ""} aria-describedby="${id}-help${state.errors[key] ? ` ${id}-error` : ""}" ${state.errors[key] ? 'aria-invalid="true"' : ""}`;
    let input;
    if (field.type === "select") {
      const options = [...field.options];
      if (!options.some((option) => option.value === value))
        options.unshift({ value, label: value || "未设置" });
      input = `<select ${attrs}>${options.map((option) => `<option value="${esc(option.value)}" ${option.value === value ? "selected" : ""}>${esc(option.label === "true" ? "是" : option.label === "false" ? "否" : option.label)}</option>`).join("")}</select>`;
    } else if (field.type === "textarea")
      input = `<textarea ${attrs} rows="6" spellcheck="false">${esc(value)}</textarea>`;
    else
      input = `<input ${attrs} type="${isSecret ? "password" : field.type === "file" ? "file" : field.type === "number" ? "number" : "text"}" ${field.type !== "file" ? `value="${esc(value)}"` : ""} ${field.type === "number" ? `step="${key === "fuzzy_match_cutoff" ? "0.1" : "1"}"` : ""} ${isSecret ? 'autocomplete="new-password"' : key === "account" ? 'autocomplete="username"' : 'autocomplete="off"'} placeholder="${esc(isSecret ? (state.secrets[key] ? "留空保持原值" : "未设置") : field.placeholder)}">`;
    return `<div class="config-field${disabled ? " is-locked" : ""}" data-field="${esc(key)}"><label for="${id}">${esc(field.label)}</label><small class="config-key">${esc(key)}</small>${input}${key === "cookie" && state.secrets.cookie ? `<button type="button" class="button" data-clear-cookie ${state.saving ? "disabled" : ""}>清除已保存 Cookie</button>` : ""}<small class="field-help" id="${id}-help">${esc(help(field))}</small>${state.errors[key] ? `<small class="field-error" id="${id}-error">${esc(state.errors[key])}</small>` : ""}</div>`;
  }
  function devicesHTML() {
    const selected = new Set(
      String(current("mi_did") || "")
        .split(",")
        .filter(Boolean),
    );
    const devices = new Map();
    for (const device of state.devices) {
      const did = String(device.miotDID || device.did || "");
      if (did)
        devices.set(did, {
          did,
          name: device.name || "小爱音箱",
          hardware: device.hardware || "",
        });
    }
    for (const did of selected)
      if (!devices.has(did))
        devices.set(did, { did, name: "已配置音箱", hardware: "" });
    return `<div class="device-config"><div class="setting-row"><div><h3>播放设备</h3><small>勾选参与播放和语音点播的音箱</small></div><button type="button" class="button" data-discover-devices ${state.discovering || state.saving || state.loading ? "disabled" : ""}>${state.discovering ? "正在获取…" : "获取设备列表"}</button></div><div class="device-checks">${[...devices.values()].map((device) => `<label class="device-check"><input type="checkbox" data-device-check value="${esc(device.did)}" ${selected.has(device.did) ? "checked" : ""} ${state.saving || state.loading ? "disabled" : ""}><span><strong>${esc(device.name)}</strong><small>${esc(device.hardware)} ${esc(device.did)}</small></span></label>`).join("") || '<p class="field-help">还没有音箱，请先设置账号或扫码登录，再获取设备列表。</p>'}</div>${state.errors.mi_did ? `<p class="field-error">${esc(state.errors.mi_did)}</p>` : ""}</div>`;
  }
  function qrHTML() {
    return `<div class="config-login"><div class="setting-row"><div><h3>扫码登录</h3><small>使用米家 App 连接小米账号</small></div><button type="button" class="button" data-settings-qr ${state.qrBusy ? "disabled" : ""}>${state.qrBusy ? "正在获取…" : "检查登录 / 获取二维码"}</button></div><p class="auth-status" data-qr-status role="status">${esc(state.qrMessage)}</p>${state.qrImage ? `<img class="login-qr" src="${esc(state.qrImage)}" alt="小米账号登录二维码">` : ""}</div>`;
  }
  function operationsHTML() {
    return `<section class="settings-panel"><h3>维护操作</h3><div class="maintenance-actions"><button type="button" class="button" data-maintenance="scan" ${state.operation ? "disabled" : ""}>扫描媒体库</button><button type="button" class="button" data-maintenance="tags" ${state.operation ? "disabled" : ""}>刷新媒体标签</button><button type="button" class="button" data-maintenance="browser" ${state.operation ? "disabled" : ""}>清理浏览器偏好</button><button type="button" class="button" data-maintenance="temp" ${state.operation ? "disabled" : ""}>清理临时文件</button><a class="button" href="/downloadlog" download="xiaomusic.txt">下载运行日志</a><a class="button" href="/docs" target="_blank" rel="noopener">接口文档</a></div><p class="field-help">在线歌单获取和下载 Cookie 上传在本地媒体模式下不可用。</p></section>`;
  }
  function render() {
    if (!state.schema || !state.loaded) {
      root.innerHTML = `<div class="empty-state"><h3>${state.loading ? "正在读取全部设置" : "暂时无法读取设置"}</h3><p>从服务端载入当前配置。</p>${!state.loading ? '<button type="button" class="button" data-refresh-settings>重试</button>' : ""}</div>`;
      return;
    }
    const q = state.search.trim().toLowerCase();
    const fields = state.schema.fields.filter(
      (field) => !q || `${field.label} ${field.key}`.toLowerCase().includes(q),
    );
    const actions = `<div class="settings-savebar"><span data-dirty role="status"></span><div><button type="button" class="button" data-discard-settings>放弃更改</button><button type="button" class="button primary" data-save-settings>保存配置</button></div></div>`;
    root.innerHTML = `<div class="settings-overview"><p>${state.schema.fields.length} 项参数 · ${state.schema.groups.length} 个分类</p><button type="button" class="button" data-refresh-settings>重新读取</button></div><p class="field-help">保存配置会重新初始化播放器，可能中断当前播放。灰色项目由本地媒体模式固定，不能修改。</p>${actions}${state.readError ? `<p class="notice" role="alert">${esc(state.readError)}</p>` : ""}<div class="config-error-summary" role="alert" ${Object.keys(state.errors).length ? "" : "hidden"}>${Object.entries(
      state.errors,
    )
      .map(
        ([key, value]) =>
          `<button type="button" data-error-target="${esc(key)}">${esc(state.schema.fields.find((field) => field.key === key)?.label || "播放设备")}：${esc(value)}</button>`,
      )
      .join(
        "",
      )}</div><label class="search-box settings-search"><span class="sr-only">搜索设置参数</span><input type="search" data-config-search value="${esc(state.search)}" placeholder="搜索参数名称或关键字" autocomplete="off">${q ? '<button type="button" class="icon-button" data-clear-config-search aria-label="清除设置搜索">清除</button>' : ""}</label><div class="settings-categories">${!q ? devicesHTML() + qrHTML() : ""}${
      state.schema.groups
        .map((group) => {
          const items = fields.filter((field) => field.group === group.key);
          if (!items.length) return "";
          return `<details class="config-group" data-config-group="${esc(group.key)}" ${q || state.opened.has(group.key) ? "open" : ""}><summary><span>${esc(group.label)}</span><small>${items.length} 项</small></summary><div class="config-grid">${items.map(fieldHTML).join("")}</div></details>`;
        })
        .join("") ||
      '<div class="empty-state"><h3>没有匹配的参数</h3><p>试试中文名称或参数关键字。</p></div>'
    }</div>${actions}<section class="settings-panel"><h3>浏览偏好</h3><label class="setting-row"><span><strong>每页歌曲数</strong><small>仅保存在当前浏览器</small></span><select id="page-size">${[30, 60, 100].map((n) => `<option value="${n}" ${getPageSize() === n ? "selected" : ""}>${n} 首</option>`).join("")}</select></label></section>${operationsHTML()}`;
    updateSaveState();
  }
  async function readSettings() {
    if (dirty() || state.loading || state.saving) return;
    state.loading = true;
    render();
    try {
      const [schema, config] = await Promise.all([
        state.schema || api("/static/library/settings-schema.json?v=1"),
        api("/getsetting"),
      ]);
      state.schema = schema;
      state.values = { mi_did: config.mi_did || "" };
      state.secrets = {};
      for (const field of schema.fields) {
        if (secretKeys.has(field.key)) {
          state.secrets[field.key] =
            config[field.key] === "******" ? "masked" : !!config[field.key];
          state.values[field.key] = "";
        } else if (Object.hasOwn(config, field.key))
          state.values[field.key] = config[field.key];
      }
      state.devices = Object.values(config.devices || {}).map((device) => ({
        ...device,
        miotDID: device.did,
      }));
      state.draft = {};
      state.errors = {};
      state.loaded = true;
      state.readError = "";
    } catch (error) {
      state.readError = "无法重新读取配置，请恢复连接后核对。";
      toast(error.message, true);
    } finally {
      state.loading = false;
      render();
    }
  }
  function validate() {
    state.errors = {};
    for (const [key, value] of Object.entries(state.draft)) {
      const field = state.schema.fields.find((field) => field.key === key);
      if (key === "mi_did") {
        if (!String(value).trim()) state.errors[key] = "至少选择一台播放音箱。";
        continue;
      }
      if (!field || locked[key]) continue;
      if (field.type === "number") {
        const number = Number(value);
        if (value === "" || !Number.isFinite(number))
          state.errors[key] = "请输入有效数字。";
        else if (key !== "fuzzy_match_cutoff" && !Number.isInteger(number))
          state.errors[key] = "请输入整数。";
        else if (key === "fuzzy_match_cutoff" && (number < 0.1 || number > 0.9))
          state.errors[key] = "阈值应在 0.1 到 0.9 之间。";
        else if (key === "pull_ask_sec" && number < 1)
          state.errors[key] = "间隔至少为 1 秒。";
        else if (
          [
            "music_path_depth",
            "file_watch_debounce",
            "recently_added_playlist_len",
          ].includes(key) &&
          number < 0
        )
          state.errors[key] = "不能小于 0。";
      }
      if (field.type === "textarea" && String(value).trim()) {
        try {
          JSON.parse(value);
        } catch {
          state.errors[key] = "请输入有效 JSON，或留空。";
        }
      }
    }
    return !Object.keys(state.errors).length;
  }
  async function save() {
    if (state.saving || !dirty()) return;
    if (!validate()) {
      for (const key of Object.keys(state.errors)) {
        const field = state.schema.fields.find((field) => field.key === key);
        if (field) state.opened.add(field.group);
      }
      state.search = "";
      render();
      const first = Object.keys(state.errors)[0];
      root.querySelector(`#setting-${CSS.escape(first)}`)?.focus();
      return;
    }
    const payload = {};
    for (const [key, value] of Object.entries(state.draft)) {
      const field = state.schema.fields.find((field) => field.key === key);
      if (locked[key] || (key !== "mi_did" && !field)) continue;
      payload[key] =
        field?.type === "number"
          ? Number(value)
          : field?.type === "select" && ["true", "false"].includes(value)
            ? value === "true"
            : value;
    }
    state.saving = true;
    render();
    let saved = false;
    try {
      await api("/savesetting", payload);
      saved = true;
      state.draft = {};
      toast("配置已保存");
    } catch (error) {
      toast(error.message, true);
    } finally {
      state.saving = false;
      render();
    }
    if (saved) {
      await readSettings();
      await onSaved();
    }
  }
  async function discover() {
    if (state.discovering) return;
    state.discovering = true;
    render();
    try {
      const data = await api("/device_list");
      const raw = data.devices || [];
      state.devices = Array.isArray(raw)
        ? raw
        : Object.entries(raw).map(([did, device]) => ({
            ...device,
            miotDID: device.miotDID || device.did || did,
          }));
      state.deviceLoaded = true;
      if (!state.devices.length)
        toast("没有发现设备，请先确认账号已登录。", true);
    } catch (error) {
      toast(error.message, true);
    } finally {
      state.discovering = false;
      render();
    }
  }
  function tickQR() {
    const el = root.querySelector("[data-qr-status]");
    if (!state.qrExpires || !el) return;
    const seconds = Math.max(
      0,
      Math.ceil((state.qrExpires - Date.now()) / 1000),
    );
    state.qrMessage = seconds
      ? `请使用米家 App 扫码，二维码将在 ${seconds} 秒后过期。`
      : "二维码已过期，请重新获取。";
    el.textContent = state.qrMessage;
    if (!seconds) {
      state.qrImage = "";
      root.querySelector(".login-qr")?.remove();
      clearInterval(qrTimer);
      state.qrExpires = 0;
    }
  }
  async function getQR() {
    if (state.qrBusy) return;
    clearInterval(qrTimer);
    state.qrBusy = true;
    state.qrImage = "";
    state.qrMessage = "正在检查登录状态…";
    state.qrExpires = 0;
    render();
    try {
      const data = await api("/api/get_qrcode");
      if (data.already_logged_in)
        state.qrMessage = data.message || "音箱账号已登录，无需扫码。";
      else {
        const value = String(data.qrcode_url || "");
        try {
          const url = new URL(value);
          if (
            url.protocol === "https:" ||
            value.startsWith("data:image/png;base64,")
          )
            state.qrImage = value;
        } catch {
          /* Invalid URL. */
        }
        if (state.qrImage) {
          state.qrExpires =
            Date.now() +
            (Number(data.expire_seconds) > 0
              ? Number(data.expire_seconds)
              : 120) *
              1000;
          state.qrMessage = "请使用米家 App 扫码，完成后获取设备列表。";
          qrTimer = setInterval(tickQR, 1000);
        } else state.qrMessage = "未获取到二维码，请重试。";
      }
    } catch (error) {
      state.qrMessage = error.message;
    } finally {
      state.qrBusy = false;
      render();
    }
  }
  async function maintenance(action) {
    if (state.operation) return;
    if (
      ["temp", "browser"].includes(action) &&
      !window.confirm(
        action === "temp"
          ? "清理服务端临时目录中的文件？"
          : "清理当前浏览器的播放偏好？媒体文件不受影响。",
      )
    )
      return;
    state.operation = true;
    render();
    try {
      if (action === "browser") {
        for (const key of Object.keys(localStorage))
          if (key.startsWith("xm-library-")) localStorage.removeItem(key);
        toast("浏览器偏好已清理");
      } else if (action === "temp") {
        await api("/api/file/cleantempdir", {});
        toast("临时文件已清理");
      } else if (action === "tags") {
        await api("/refreshmusictag", {});
        toast("标签刷新已启动");
      } else if (action === "scan") {
        await api("/api/music/refreshlist", {});
        await onSaved();
        toast("媒体库已更新");
      }
    } catch (error) {
      toast(error.message, true);
    } finally {
      state.operation = false;
      render();
    }
  }
  root.addEventListener(
    "error",
    (event) => {
      if (
        event.target instanceof HTMLImageElement &&
        event.target.matches(".login-qr")
      ) {
        clearInterval(qrTimer);
        state.qrExpires = 0;
        state.qrImage = "";
        state.qrMessage = "二维码图片无法显示，请重新获取。";
        render();
      }
    },
    true,
  );
  root.addEventListener("input", (event) => {
    const el = event.target;
    if (el.hasAttribute("data-config-search")) {
      const start = el.selectionStart;
      state.search = el.value;
      render();
      const search = root.querySelector("[data-config-search]");
      search.focus();
      search.setSelectionRange(start, start);
      return;
    }
    const key = el.dataset.setting;
    if (key && !locked[key]) setDraft(key, el.value);
  });
  root.addEventListener("change", (event) => {
    const el = event.target;
    if (el.hasAttribute("data-device-check")) {
      const selected = [
        ...root.querySelectorAll("[data-device-check]:checked"),
      ].map((el) => el.value);
      setDraft("mi_did", selected.join(","));
    } else if (el.dataset.setting && !locked[el.dataset.setting])
      setDraft(el.dataset.setting, el.value);
  });
  root.addEventListener(
    "toggle",
    (event) => {
      if (event.target.dataset.configGroup && !state.search) {
        if (event.target.open)
          state.opened.add(event.target.dataset.configGroup);
        else state.opened.delete(event.target.dataset.configGroup);
      }
    },
    true,
  );
  root.addEventListener("click", (event) => {
    const button = event.target.closest("button");
    if (!button || button.disabled) return;
    if (button.hasAttribute("data-clear-config-search")) {
      state.search = "";
      render();
      root.querySelector("[data-config-search]").focus();
    } else if (button.hasAttribute("data-save-settings")) void save();
    else if (button.hasAttribute("data-clear-cookie")) {
      state.draft.cookie = "";
      render();
    } else if (button.hasAttribute("data-discard-settings")) {
      state.draft = {};
      state.errors = {};
      render();
    } else if (button.hasAttribute("data-refresh-settings")) {
      if (dirty()) {
        toast("请先保存或放弃未保存的更改。", true);
        return;
      }
      void readSettings();
    } else if (button.hasAttribute("data-discover-devices")) void discover();
    else if (button.hasAttribute("data-settings-qr")) void getQR();
    else if (button.dataset.maintenance)
      void maintenance(button.dataset.maintenance);
    else if (button.dataset.errorTarget)
      root
        .querySelector(`#setting-${CSS.escape(button.dataset.errorTarget)}`)
        ?.focus();
  });
  window.addEventListener("beforeunload", (event) => {
    if (dirty()) {
      event.preventDefault();
      event.returnValue = "";
    }
  });
  return {
    element: root,
    open() {
      if (!state.loaded && !state.loading) void readSettings();
    },
    hasChanges: () => !!dirty(),
  };
};
