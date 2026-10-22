/* Isolated UI regression: real static assets, fixture APIs, no speaker traffic.
 * NODE_PATH=/path/to/node_modules node test/ui/library.spec.cjs
 * Optional: BROWSER_EXECUTABLE=/path/to/chromium UI_ARTIFACT_DIR=/tmp/ui
 */
const { chromium } = require("playwright");
const {
  wsServer: WebSocketServer,
} = require("playwright-core/lib/utilsBundle");
const assert = require("node:assert/strict");
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const root = path.resolve(__dirname, "../../xiaomusic/static");
const schema = JSON.parse(
  fs.readFileSync(path.join(root, "library/settings-schema.json"), "utf8"),
);
const configuration = Object.fromEntries(
  schema.fields
    .filter((f) => f.type !== "file")
    .map((f) => [
      f.key,
      f.type === "select"
        ? f.options[0]?.value || ""
        : f.type === "number"
          ? 1
          : "",
    ]),
);
Object.assign(configuration, {
  account: "fixture-account",
  password: "******",
  httpauth_password: "******",
  cookie: "fixture-cookie-private",
  hostname: "http://192.168.100.99",
  public_port: 8090,
  music_path: "/vol2/1000/music",
  conf_path: "conf",
  cache_dir: "conf/cache",
  temp_path: "conf/tmp",
  download_path: "conf/downloads",
  fuzzy_match_cutoff: 0.6,
  exclude_dirs: "@eaDir,tmp",
  crontab_json: "",
  music_list_json: "",
  disable_download: true,
  enable_file_watch: false,
});
let selectedDids = "a,b",
  failSave = false,
  savedPayloads = [];
const artifacts = process.env.UI_ARTIFACT_DIR || "/tmp/xiaomusic-ui-artifacts";
fs.mkdirSync(artifacts, { recursive: true });
const tracks = [
  ["周杰伦－晴天", "晴天", "周杰伦", "叶惠美", 269],
  ["周杰伦－七里香", "七里香", "周杰伦", "七里香", 299],
  ["陈奕迅－好久不见", "好久不见", "陈奕迅", "认了吧", 252],
  ["陈奕迅－十年", "十年", "陈奕迅", "黑白灰", 205],
  ["王菲－红豆", "红豆", "王菲", "唱游", 255],
  ["王菲－人间", "人间", "王菲", "王菲", 285],
  ["孙燕姿－遇见", "遇见", "孙燕姿", "The Moment", 210],
  ["许巍－蓝莲花", "蓝莲花", "许巍", "时光·漫步", 270],
  ["旅行团－逝去的歌", "逝去的歌", "旅行团", "10 DAY’S", 234],
  [
    "<img src=x onerror=alert(1)>",
    "<img src=x onerror=alert(1)>",
    "<未知>",
    "测试专辑",
    42,
  ],
  ...Array.from({ length: 73 }, (_, i) => [
    `有声书－第${i + 1}章`,
    `第${i + 1}章`,
    "朗读者",
    "睡前故事",
    600 + i,
  ]),
];
const baseLists = {
  所有歌曲: tracks.map((t) => t[0]),
  全部: tracks.map((t) => t[0]),
  最近新增: tracks.slice(0, 5).map((t) => t[0]),
  QQ音乐: tracks.slice(0, 9).map((t) => t[0]),
  有声书: tracks.slice(10).map((t) => t[0]),
  收藏: [],
};
let lists = structuredClone(baseLists);
let requests = [],
  failLibrary = false,
  emptyLibrary = false,
  noDevices = false,
  failStatus = false,
  failVolume = false,
  delayA = false,
  voiceEnabled = true,
  qrLoggedIn = true;
const players = {
  a: {
    ret: "OK",
    cur_music: tracks[0][0],
    cur_playlist: "QQ音乐",
    is_playing: true,
    offset: 82,
    duration: 269,
    mode: 2,
    volume: 35,
  },
  b: {
    ret: "OK",
    cur_music: tracks[4][0],
    cur_playlist: "QQ音乐",
    is_playing: false,
    offset: 0,
    duration: 255,
    mode: 4,
    volume: 20,
  },
};
const respond = (res, data, code = 200) => {
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
};
const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, "http://localhost");
  if (u.pathname === "/" || u.pathname.startsWith("/static/")) {
    const relative =
      u.pathname === "/"
        ? "index.html"
        : decodeURIComponent(u.pathname.slice("/static/".length));
    const file = path.resolve(root, relative);
    if (!file.startsWith(root + path.sep) || !fs.existsSync(file)) {
      res.writeHead(404);
      res.end();
      return;
    }
    res.writeHead(200, {
      "Content-Type": file.endsWith(".css")
        ? "text/css"
        : file.endsWith(".js")
          ? "text/javascript"
          : file.endsWith(".json")
            ? "application/json"
            : file.endsWith(".ico")
              ? "image/x-icon"
              : "text/html",
    });
    res.end(fs.readFileSync(file));
    return;
  }
  let text = "";
  for await (const chunk of req) text += chunk;
  const body = text ? JSON.parse(text) : null;
  requests.push({
    path: u.pathname,
    method: req.method,
    body,
    query: Object.fromEntries(u.searchParams),
  });
  const did = u.searchParams.get("did") || body?.did || "a";
  const p = players[did];
  if (/^\/api\/js-plugins\/[^/]+\/(disable|uninstall)$/.test(u.pathname))
    return respond(res, { success: true });
  switch (u.pathname) {
    case "/playlistnames":
      return respond(res, {
        ret: "OK",
        names: Object.keys(lists).filter(
          (n) => !Object.hasOwn(baseLists, n) || n === "收藏",
        ),
      });
    case "/playlistmusics":
      return respond(res, {
        ret: "OK",
        musics: lists[u.searchParams.get("name")] || [],
      });
    case "/playlistadd":
      if (Object.hasOwn(lists, body.name))
        return respond(res, { ret: "Duplicate" });
      lists[body.name] = [];
      return respond(res, { ret: "OK" });
    case "/playlistupdatename":
      lists[body.newname] = lists[body.oldname];
      delete lists[body.oldname];
      return respond(res, { ret: "OK" });
    case "/playlistdel":
      delete lists[body.name];
      return respond(res, { ret: "OK" });
    case "/playlistupdatemusic":
      lists[body.name] = body.music_list;
      return respond(res, { ret: "OK" });
    case "/setmusictag":
      return respond(res, {
        ret:
          body.title === "fixture-fail" ? "Tag generation task running" : "OK",
      });
    case "/delmusic":
      for (const name of Object.keys(lists))
        lists[name] = lists[name].filter((n) => n !== body.name);
      return respond(res, "success");
    case "/getplayerstatus":
      return respond(res, {
        status: 1,
        volume: 35,
        play_song_detail: { position: 12000, duration: 180000 },
      });
    case "/playtts":
      return respond(res, { ret: "OK" });
    case "/playurl":
      return respond(res, { ret: "OK" });
    case "/getversion":
      return respond(res, { version: "0.6.1" });
    case "/latestversion":
      return respond(res, { ret: "OK", version: "0.6.2" });
    case "/api/password/check":
      return respond(res, { success: true, data: { required: true } });
    case "/api/password/verify":
      return respond(res, { success: body.password === "fixture-admin" });
    case "/api/js-plugins":
      return respond(res, {
        success: true,
        data: [{ name: "FixturePlugin", enabled: true }],
      });
    case "/api/advanced-config/load":
      return respond(res, {
        success: true,
        data: {
          auto_add_song: false,
          auto_convert: false,
          voice_playlist_strategy: "default",
          aiapi_info: { api_key: "fixture-hidden-key" },
        },
      });
    case "/api/back-conf/load":
      return respond(res, { success: true, data: { api_type: 1 } });
    case "/api/box-play-platform/load":
      return respond(res, { success: true, data: { platform: "all" } });
    case "/api/lxServer/load":
      return respond(res, {
        success: true,
        data: { enabled: false, "x-user-token": "fixture-hidden-token" },
      });
    case "/api/plugin-source/load":
      return respond(res, { success: true, data: {} });
    case "/api/platforms":
      return respond(res, { success: true, data: [] });
    case "/download_progress":
      return respond(res, {
        ret: "OK",
        tasks: {
          fixtureTask: {
            status: "downloading",
            completed: 2,
            total: 10,
            progress: 20,
            dirname: "历史下载",
          },
        },
      });
    case "/pause_download":
    case "/stop_download":
    case "/delete_download_task":
    case "/api/debug/simulate_token_expire":
      return respond(res, { ret: "OK" });
    case "/clear_completed_tasks":
      return respond(res, { ret: "OK", cleared_count: 0 });
    case "/musiclist":
      return respond(
        res,
        emptyLibrary ? { 所有歌曲: [] } : lists,
        failLibrary ? 503 : 200,
      );
    case "/getsetting":
      return respond(res, {
        ...configuration,
        mi_did: noDevices ? "" : selectedDids,
        devices: {
          internalA: {
            did: "a",
            name: "客厅的小爱",
            play_type: players.a.mode,
          },
          internalB: {
            did: "b",
            name: "卧室的小爱",
            play_type: players.b.mode,
          },
        },
        enable_pull_ask: voiceEnabled,
        music_path: "/vol2/1000/music",
      });
    case "/musicinfo": {
      const name = u.searchParams.get("name"),
        t = tracks.find((t) => t[0] === name);
      return respond(res, {
        ret: "OK",
        name,
        url: "",
        tags: {
          title: t?.[1],
          artist: t?.[2],
          album: t?.[3],
          duration: t?.[4],
        },
      });
    }
    case "/searchmusic": {
      const q = u.searchParams.get("name").toLowerCase();
      return respond(
        res,
        tracks
          .filter((t) => t.slice(0, 4).some((v) => v.toLowerCase().includes(q)))
          .map((t) => t[0]),
      );
    }
    case "/generate_ws_token":
      return respond(res, { token: `fixture-${did}`, expire_in: 300 });
    case "/curplaylist":
      return respond(res, p.cur_playlist);
    case "/playlistaddmusic":
      lists[body.name] = [
        ...new Set([...(lists[body.name] || []), ...body.music_list]),
      ];
      return respond(res, { ret: "OK" });
    case "/playlistdelmusic":
      lists[body.name] = (lists[body.name] || []).filter(
        (name) => !body.music_list.includes(name),
      );
      return respond(res, { ret: "OK" });
    case "/device_list":
      return respond(res, {
        devices: [
          { miotDID: "a", name: "客厅的小爱", hardware: "LX06" },
          { miotDID: "b", name: "卧室的小爱", hardware: "LX06" },
        ],
      });
    case "/savesetting":
      if (failSave) return respond(res, {}, 503);
      savedPayloads.push(structuredClone(body));
      Object.assign(configuration, body);
      if (Object.hasOwn(body, "mi_did")) selectedDids = body.mi_did;
      if (Object.hasOwn(body, "enable_pull_ask"))
        voiceEnabled = body.enable_pull_ask;
      return respond(res, "save success");
    case "/refreshmusictag":
      return respond(res, { ret: "OK" });
    case "/api/file/cleantempdir":
      return respond(res, { ret: "OK" });
    case "/api/system/modifiysetting":
      voiceEnabled = body.enable_pull_ask;
      return respond(res, { success: true });
    case "/api/get_qrcode":
      return respond(
        res,
        qrLoggedIn
          ? {
              success: true,
              already_logged_in: true,
              device_count: 2,
              message: "音箱账号已登录，发现 2 台设备，无需扫码",
            }
          : {
              success: true,
              qrcode_url:
                "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a4QAAAABJRU5ErkJggg==",
            },
      );
    case "/playingmusic": {
      const snapshot = { ...p };
      if (delayA && did === "a") await new Promise((r) => setTimeout(r, 800));
      return respond(res, snapshot, failStatus ? 503 : 200);
    }
    case "/getvolume":
      return respond(res, { volume: p.volume });
    case "/setvolume":
      if (failVolume) return respond(res, {}, 503);
      p.volume = body.volume;
      return respond(res, { ret: "OK" });
    case "/playmusiclist":
      p.cur_music = body.musicname;
      p.cur_playlist = body.listname;
      p.is_playing = true;
      return respond(res, { ret: "OK" });
    case "/playmusic":
      p.cur_music = body.musicname;
      p.is_playing = true;
      return respond(res, { ret: "OK" });
    case "/device/stop":
      p.is_playing = false;
      return respond(res, { ret: "OK" });
    case "/api/music/refreshlist":
      return respond(res, { ret: "OK" });
    case "/cmd": {
      const modes = [
        "单曲循环",
        "全部循环",
        "随机播放",
        "单曲播放",
        "顺序播放",
      ];
      if (modes.includes(body.cmd)) p.mode = modes.indexOf(body.cmd);
      return respond(res, { ret: "OK" });
    }
    case "/cmdstatus":
      return respond(res, { ret: "OK", status: "finish" });
    default:
      return respond(res, { error: "unhandled fixture" }, 404);
  }
});
const socketServer = new WebSocketServer({ server, path: "/ws/playingmusic" });
let socketConnections = 0;
socketServer.on("connection", (socket, req) => {
  socketConnections++;
  const did = new URL(req.url, "http://localhost").searchParams
    .get("token")
    .replace("fixture-", "");
  const timer = setInterval(() => {
    if (!failStatus && socket.readyState === 1)
      socket.send(JSON.stringify(players[did]));
  }, 200);
  socket.on("close", () => clearInterval(timer));
});
(async () => {
  await new Promise((r) =>
    server.listen(Number(process.env.UI_PREVIEW_PORT || 0), "127.0.0.1", r),
  );
  const origin = `http://127.0.0.1:${server.address().port}`;
  if (process.env.UI_PREVIEW_ONLY === "1") {
    console.log(`Isolated fixture preview: ${origin}`);
    return;
  }
  const browser = await chromium.launch({
    headless: true,
    ...(process.env.BROWSER_EXECUTABLE
      ? { executablePath: process.env.BROWSER_EXECUTABLE }
      : {}),
  });
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
  });
  const errors = [],
    external = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("request", (req) => {
    if (!req.url().startsWith(origin)) external.push(req.url());
  });
  const nav = (view) => page.locator(`.main-nav [data-view="${view}"]`).click();
  const ready = async () => {
    await page.goto(origin);
    await page.locator(".track").first().waitFor();
    await page.waitForFunction(
      () => document.querySelector("#now-title").textContent === "晴天",
    );
  };
  try {
    await ready();
    assert.equal(await page.locator(".track").count(), 60);
    assert.equal(await page.locator("audio,video").count(), 0);
    await page.getByRole("button", { name: "下一页", exact: true }).click();
    assert.equal(await page.locator(".track").count(), 23);
    await page.getByRole("button", { name: "上一页", exact: true }).click();
    for (const width of [1440, 1024, 390]) {
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.setViewportSize({ width, height: 1000 });
      await page.waitForTimeout(150);
      await page.evaluate(
        () =>
          new Promise((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(resolve)),
          ),
      );
      assert.equal(
        await page.evaluate(
          () =>
            document.documentElement.scrollWidth -
            document.documentElement.clientWidth,
        ),
        0,
        `overflow ${width}`,
      );
      await page.screenshot({
        path: path.join(artifacts, `library-${width}.png`),
        fullPage: false,
      });
    }
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.getByRole("tab", { name: "歌手", exact: true }).click();
    await page
      .getByRole("button", { name: "周杰伦 2 首", exact: true })
      .click();
    assert.equal(await page.locator(".track").count(), 2);
    assert.equal(
      await page.locator("[data-play-all]").count(),
      0,
      "derived group must not pretend to create a playlist",
    );
    await page.locator('[data-play="周杰伦－七里香"]').first().click();
    await page.waitForFunction(
      () => !document.querySelector("#device-select").disabled,
    );
    assert.deepEqual(
      requests.filter((r) => r.path === "/playmusic").at(-1).body,
      { did: "a", musicname: "周杰伦－七里香", searchkey: "" },
    );
    await nav("library");
    await page.getByRole("tab", { name: "专辑", exact: true }).click();
    assert.ok((await page.locator(".group-card").count()) > 3);
    await page.getByRole("tab", { name: "歌曲", exact: true }).click();
    await page.locator("#search").fill("王菲");
    await page.waitForTimeout(350);
    assert.equal(await page.locator(".track").count(), 2);
    await page.locator('[data-play="王菲－红豆"]').first().click();
    await page.waitForFunction(
      () => document.querySelector("#now-title").textContent === "红豆",
    );
    assert.equal(
      requests.filter((r) => r.path === "/playmusic").at(-1).body.musicname,
      "王菲－红豆",
    );
    assert.ok(requests.some((r) => r.path === "/searchmusic"));
    await page.locator("#search").fill("没有这首歌");
    await page.waitForTimeout(350);
    await page.getByRole("heading", { name: "没有找到匹配内容" }).waitFor();
    await page.getByRole("button", { name: "清除搜索", exact: true }).click();
    assert.equal(await page.locator(".track").count(), 60);
    assert.equal(
      await page.locator('#content img[src="x"]').count(),
      0,
      "metadata must be escaped",
    );
    await nav("folders");
    await page
      .getByRole("button", { name: "有声书 73 首", exact: true })
      .click();
    await page.locator("[data-play-all]").click();
    await page.waitForFunction(
      () => !document.querySelector("#device-select").disabled,
    );
    assert.equal(
      requests.filter((r) => r.path === "/playmusiclist").at(-1).body.listname,
      "有声书",
    );
    await nav("queue");
    await page.locator(".track").first().waitFor();
    assert.equal(
      await page.locator(".track-title").first().getAttribute("data-play"),
      tracks[10][0],
      "existing playlist order (not invented shuffle order)",
    );
    await page.locator("[data-from-queue]").first().click();
    await page.waitForFunction(
      () => !document.querySelector("#device-select").disabled,
    );
    assert.equal(
      requests.filter((r) => r.path === "/playmusic").at(-1).body.musicname,
      tracks[10][0],
    );
    await page.locator('.player-dock [data-action="toggle"]').click();
    await page.waitForFunction(
      () => !document.querySelector("#device-select").disabled,
    );
    assert.equal(players.a.is_playing, false);
    await page.locator('.player-dock [data-action="toggle"]').click();
    await page.waitForFunction(
      () => !document.querySelector("#device-select").disabled,
    );
    assert.equal(players.a.is_playing, true);
    await page.locator("#expand-player").click();
    await page.locator("#favorite").click();
    await page.waitForFunction(
      () =>
        document.querySelector("#favorite").getAttribute("aria-pressed") ===
        "true",
    );
    assert.deepEqual(
      requests.filter((r) => r.path === "/playlistaddmusic").at(-1).body,
      { name: "收藏", music_list: [players.a.cur_music] },
    );
    await page.locator("#favorite").click();
    await page.waitForFunction(
      () =>
        document.querySelector("#favorite").getAttribute("aria-pressed") ===
        "false",
    );
    assert.ok(requests.some((r) => r.path === "/playlistdelmusic"));
    await page.locator(".sleep-timer summary").click();
    await page.locator('[data-sleep="30"]').click();
    await page.waitForFunction(
      () => !document.querySelector("#device-select").disabled,
    );
    assert.equal(
      requests.filter((r) => r.path === "/cmd").at(-1).body.cmd,
      "30分钟后关机",
    );
    await page.locator("#volume").fill("45");
    await page.locator("#volume").dispatchEvent("change");
    await page.waitForFunction(
      () => !document.querySelector("#volume").disabled,
    );
    assert.equal(players.a.volume, 45);
    failVolume = true;
    await page.locator("#volume").fill("72");
    await page.locator("#volume").dispatchEvent("change");
    await page.waitForFunction(
      () => !document.querySelector("#volume").disabled,
    );
    assert.equal(
      await page.locator("#volume").inputValue(),
      "45",
      "failed volume restores actual setting",
    );
    failVolume = false;
    await page.locator("#play-mode").selectOption("1");
    await page.waitForFunction(
      () => !document.querySelector("#play-mode").disabled,
    );
    assert.equal(players.a.mode, 1);
    await page.keyboard.press("Escape");
    await page.locator("#device-select").selectOption("b");
    await page.waitForFunction(
      () => document.querySelector("#now-title").textContent === "红豆",
    );
    await page.locator("#expand-player").click();
    await page.waitForFunction(
      () => document.querySelector("#volume").value === "20",
    );
    await page.keyboard.press("Escape");
    await nav("settings");
    await page.locator("[data-save-settings]").first().waitFor();
    assert.equal(
      await page.locator("[data-setting]").count(),
      schema.fields.length,
      "all default parameters remain represented",
    );
    assert.equal(
      await page.locator("[data-config-group]").count(),
      schema.groups.length,
    );
    assert.equal(await page.locator("#setting-password").inputValue(), "");
    assert.equal(await page.locator("#setting-cookie").inputValue(), "");
    assert.ok(
      !(await page.locator(".settings-editor").innerHTML()).includes(
        "fixture-cookie-private",
      ),
    );
    assert.equal(await page.locator("#setting-music_path").isDisabled(), true);
    assert.equal(
      await page.locator("#setting-disable_download").isDisabled(),
      true,
    );
    await page.locator("[data-config-search]").fill("enable_pull_ask");
    await page.locator("#setting-enable_pull_ask").selectOption("false");
    await page.locator("[data-save-settings]").first().click();
    await page.waitForFunction(
      () =>
        document.querySelector("[data-save-settings]")?.textContent ===
        "保存配置",
    );
    assert.equal(voiceEnabled, false);
    assert.deepEqual(savedPayloads.at(-1), { enable_pull_ask: false });
    await page.locator("[data-config-search]").fill("");
    await page.locator("[data-settings-qr]").click();
    await page.waitForFunction(() =>
      document.querySelector("[data-qr-status]").textContent.includes("已登录"),
    );
    qrLoggedIn = false;
    await page.locator("[data-settings-qr]").click();
    await page.locator(".login-qr").waitFor();
    qrLoggedIn = true;
    await page.locator("[data-discover-devices]").click();
    await page.waitForFunction(
      () => !document.querySelector("[data-discover-devices]").disabled,
    );
    assert.equal(await page.locator("[data-device-check]").count(), 2);
    // A change in another category must survive switching views and later saving.
    await page.locator("[data-config-search]").fill("exclude_dirs");
    await page.locator("#setting-exclude_dirs").fill("@eaDir,tmp,private");
    await nav("library");
    await nav("settings");
    assert.equal(
      await page.locator("#setting-exclude_dirs").inputValue(),
      "@eaDir,tmp,private",
    );
    await page.locator("[data-config-search]").fill("fuzzy_match_cutoff");
    await page.locator("#setting-fuzzy_match_cutoff").fill("0.7");
    await page.locator("[data-save-settings]").first().click();
    await page.waitForFunction(
      () =>
        document.querySelector("[data-save-settings]")?.textContent ===
        "保存配置",
    );
    assert.deepEqual(savedPayloads.at(-1), {
      exclude_dirs: "@eaDir,tmp,private",
      fuzzy_match_cutoff: 0.7,
    });
    assert.ok(!Object.hasOwn(savedPayloads.at(-1), "password"));
    // Invalid JSON blocks saving, retains the draft, and provides inline recovery.
    await page.locator("[data-config-search]").fill("crontab_json");
    await page.locator("#setting-crontab_json").fill("{broken");
    const savedCount = savedPayloads.length;
    await page.locator("[data-save-settings]").first().click();
    assert.equal(savedPayloads.length, savedCount);
    await page.locator('#setting-crontab_json[aria-invalid="true"]').waitFor();
    await page.locator("[data-discard-settings]").first().click();
    await page.locator("[data-config-search]").fill("crontab_json");
    await page.locator("#setting-crontab_json").fill("[]");
    await page.locator("[data-save-settings]").first().click();
    await page.waitForFunction(
      () =>
        document.querySelector("[data-save-settings]")?.textContent ===
          "保存配置" && !document.querySelector("#reload").disabled,
    );
    assert.equal(
      savedPayloads.at(-1).crontab_json,
      "[]",
      "JSON must remain a configuration string",
    );
    // A failed save must retain edits and must not send a masked credential.
    await page.locator("[data-config-search]").fill("keywords_playlocal");
    await page.locator("#setting-keywords_playlocal").fill("播放我的收藏");
    failSave = true;
    await page.locator("[data-save-settings]").first().click();
    await page.waitForFunction(
      () =>
        document.querySelector("[data-save-settings]")?.textContent ===
        "保存配置",
    );
    assert.equal(
      await page.locator("#setting-keywords_playlocal").inputValue(),
      "播放我的收藏",
    );
    failSave = false;
    await page.locator("[data-discard-settings]").first().click();
    await page.locator("[data-config-search]").fill("");
    await page.locator('[data-device-check][value="b"]').uncheck();
    await page.locator("[data-save-settings]").first().click();
    await page.waitForFunction(
      () =>
        document.querySelector("[data-save-settings]")?.textContent ===
        "保存配置",
    );
    assert.equal(selectedDids, "a");
    await page.locator("[data-discover-devices]").click();
    await page.waitForFunction(
      () => !document.querySelector("[data-discover-devices]").disabled,
    );
    await page.locator('[data-device-check][value="b"]').check();
    await page.locator("[data-save-settings]").first().click();
    await page.waitForFunction(
      () =>
        document.querySelector("[data-save-settings]")?.textContent ===
        "保存配置",
    );
    assert.equal(selectedDids, "a,b");
    await page.locator("[data-config-search]").fill("cookie");
    await page.locator("[data-clear-cookie]").click();
    await page.locator("[data-save-settings]").first().click();
    await page.waitForFunction(
      () =>
        document.querySelector("[data-save-settings]")?.textContent ===
          "保存配置" && !document.querySelector("#reload").disabled,
    );
    assert.deepEqual(
      savedPayloads.at(-1),
      { cookie: "" },
      "cookie clears only by explicit action and save",
    );
    await page.getByRole("button", { name: "清除设置搜索" }).click();
    await page.locator("#page-size").selectOption("30");
    await page.locator('[data-maintenance="scan"]').click();
    await page.waitForFunction(
      () => !document.querySelector('[data-maintenance="scan"]').disabled,
    );
    assert.ok(requests.some((r) => r.path === "/api/music/refreshlist"));
    await page.locator('[data-maintenance="tags"]').click();
    await page.waitForFunction(
      () => !document.querySelector('[data-maintenance="tags"]').disabled,
    );
    assert.ok(requests.some((r) => r.path === "/refreshmusictag"));
    assert.ok(
      !(await page.evaluate(() => JSON.stringify(localStorage))).includes(
        "fixture-cookie-private",
      ),
    );
    await nav("library");
    assert.equal(await page.locator(".track").count(), 30);
    // A slow response from the previously selected device must not overwrite B.
    delayA = true;
    await page.locator("#device-select").selectOption("a");
    await page.waitForTimeout(40);
    await page.locator("#device-select").selectOption("b");
    await page.waitForTimeout(1000);
    assert.equal(await page.locator("#now-title").textContent(), "红豆");
    ((delayA = false), (voiceEnabled = true), (qrLoggedIn = true));
    failStatus = true;
    await page.locator("#expand-player").click();
    await page.locator("#connection").waitFor({ state: "visible" });
    await page.keyboard.press("Escape");
    failStatus = false;
    failLibrary = true;
    await page.locator("#reload").click();
    await page.getByRole("heading", { name: "暂时连接不上媒体库" }).waitFor();
    failLibrary = false;
    await page.getByRole("button", { name: "重新加载", exact: true }).click();
    await page.locator(".track").first().waitFor();
    emptyLibrary = true;
    await page.locator("#reload").click();
    await page.getByRole("heading", { name: "收藏室等待第一首歌" }).waitFor();
    emptyLibrary = false;
    noDevices = true;
    await page.locator("#reload").click();
    await page.locator(".track").first().waitFor();
    assert.equal(await page.locator(".track-title:not(:disabled)").count(), 0);
    await nav("queue");
    await page.getByRole("heading", { name: "先选择一台音箱" }).waitFor();
    noDevices = false;
    lists = structuredClone(baseLists);
    players.a.cur_music = tracks[0][0];
    players.a.cur_playlist = "QQ音乐";
    await page.evaluate(() => localStorage.clear());
    await ready();
    for (const viewport of [
      { width: 375, height: 812 },
      { width: 844, height: 390 },
      { width: 390, height: 1000 },
      { width: 1024, height: 1000 },
      { width: 1440, height: 1000 },
    ]) {
      const { width } = viewport;
      await page.setViewportSize(viewport);
      await page.emulateMedia({ reducedMotion: "reduce" });
      for (const view of ["folders", "queue", "settings", "library"]) {
        await nav(view);
        if (view === "settings")
          await page.locator("[data-save-settings]").first().waitFor();
        await page.waitForTimeout(150);
        assert.equal(
          await page.evaluate(
            () =>
              document.documentElement.scrollWidth -
              document.documentElement.clientWidth,
          ),
          0,
          `${view} overflow ${width}`,
        );
        await page.screenshot({
          path: path.join(artifacts, `${view}-${width}.png`),
        });
      }
      await page.locator("#expand-player").click();
      await page.waitForTimeout(150);
      assert.equal(
        await page.evaluate(
          () =>
            document.documentElement.scrollWidth -
            document.documentElement.clientWidth,
        ),
        0,
        `player overflow ${width}`,
      );
      if (width === 844) {
        const box = await page
          .locator('#player-dialog [data-action="toggle"]')
          .boundingBox();
        assert.ok(
          box.y >= 0 && box.y + box.height <= viewport.height,
          "primary playback control visible in landscape",
        );
      }
      await page.screenshot({
        path: path.join(artifacts, `player-${width}.png`),
      });
      await page.keyboard.press("Escape");
    }
    await nav("settings");
    await page.setViewportSize({ width: 390, height: 1000 });
    await page.locator("[data-config-search]").fill("");
    await page.locator('[data-config-group="filewatch"]').evaluate((el) => {
      el.open = true;
    });
    await page
      .locator('[data-config-group="filewatch"]')
      .scrollIntoViewIfNeeded();
    await page.screenshot({
      path: path.join(artifacts, "settings-fields-390.png"),
    });
    if (process.env.LAYOUT_AUDIT_SCRIPT) {
      await page.addScriptTag({ path: process.env.LAYOUT_AUDIT_SCRIPT });
      const audit = await page.evaluate(() => __audit({}));
      fs.writeFileSync(
        path.join(artifacts, "audit-settings-390.json"),
        JSON.stringify(audit, null, 2),
      );
      await page.screenshot({
        path: path.join(artifacts, "audit-settings-390.png"),
      });
      await page.evaluate(() => __clearAudit());
    }
    await nav("library");
    // Optional audit script renders annotated screenshots for independent review.
    if (process.env.LAYOUT_AUDIT_SCRIPT) {
      for (const width of [1440, 1024, 390]) {
        await page.setViewportSize({ width, height: 1000 });
        await page.waitForTimeout(150);
        await page.evaluate(
          () =>
            new Promise((resolve) =>
              requestAnimationFrame(() => requestAnimationFrame(resolve)),
            ),
        );
        await page.addScriptTag({ path: process.env.LAYOUT_AUDIT_SCRIPT });
        const audit = await page.evaluate(() => __audit({}));
        fs.writeFileSync(
          path.join(artifacts, `audit-${width}.json`),
          JSON.stringify(audit, null, 2),
        );
        await page.screenshot({
          path: path.join(artifacts, `audit-${width}.png`),
        });
        await page.evaluate(() => __clearAudit());
      }
    }
    await require("./management.cjs")({ page, requests, lists, artifacts });
    const coverage = JSON.parse(
      fs.readFileSync(path.join(root, "library/route-coverage.json"), "utf8"),
    );
    for (const req of requests) {
      const match = coverage.find((row) => {
        const [method, route] = row.route.split(" ");
        return (
          method === req.method &&
          new RegExp("^" + route.replace(/\{[^}]+\}/g, "[^/]+") + "$").test(
            req.path,
          )
        );
      });
      assert.ok(match, "existing route: " + req.method + " " + req.path);
      assert.notEqual(
        match.status,
        "restricted",
        "restricted routes must never be requested",
      );
    }
    assert.ok(socketConnections > 0, "default status WebSocket was exercised");
    assert.deepEqual(errors, [], "browser errors");
    assert.deepEqual(external, [], "no external requests");
    console.log(
      JSON.stringify(
        {
          ok: true,
          requests: requests.length,
          socketConnections,
          endpoints: [...new Set(requests.map((r) => r.path))],
          overflows: { 1440: 0, 1024: 0, 844: 0, 390: 0, 375: 0 },
          browserErrors: errors,
          externalRequests: external,
          artifacts,
        },
        null,
        2,
      ),
    );
  } finally {
    await browser.close();
    socketServer.close();
    server.close();
  }
})().catch((error) => {
  console.error(error);
  server.close();
  process.exitCode = 1;
});
