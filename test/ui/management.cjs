const assert = require("node:assert/strict");
const path = require("node:path");
module.exports = async ({ page, requests, lists, artifacts }) => {
  const click = async (action) => {
    await page.locator(`[data-manage="${action}"]`).click();
    await page.waitForFunction(
      () =>
        document.querySelector(".manage-editor") !== null &&
        !document.querySelector(".manage-editor").hasAttribute("aria-busy"),
    );
  };
  const last = (endpoint) => requests.filter((r) => r.path === endpoint).at(-1);
  await page.locator('[data-view="manage"]').click();
  await page.waitForSelector('[name="new-name"]');
  await page.locator('[name="new-name"]').fill("晚间收藏");
  await click("playlist-create");
  assert.deepEqual(last("/playlistadd").body, { name: "晚间收藏" });
  await page.locator('[name="add-song"]').selectOption("周杰伦－晴天");
  await click("playlist-add-song");
  await page.locator('[name="add-song"]').selectOption("王菲－红豆");
  await click("playlist-add-song");
  await page.locator('[data-manage="song-down"]').first().click();
  await click("playlist-save");
  assert.deepEqual(last("/playlistupdatemusic").body, {
    name: "晚间收藏",
    music_list: ["王菲－红豆", "周杰伦－晴天"],
  });
  await page.locator('[name="rename"]').fill("晚间精选");
  await click("playlist-rename");
  assert.deepEqual(lists["晚间精选"], ["王菲－红豆", "周杰伦－晴天"]);
  await page.locator('[data-manage="song-remove"]').first().click();
  await page.waitForFunction(
    () =>
      document.querySelector(".manage-editor") !== null &&
      !document.querySelector(".manage-editor").hasAttribute("aria-busy"),
  );
  assert.deepEqual(lists["晚间精选"], ["周杰伦－晴天"]);
  // Duplicate creation is an application error and keeps the entered name.
  await page.locator('[name="new-name"]').fill("晚间精选");
  await click("playlist-create");
  assert.match(
    await page.locator("[data-manage-status]").innerText(),
    /未完成/,
  );
  await click("section:media");
  await page.locator('[name="music"]').fill("周杰伦－晴天");
  await click("media-open");
  assert.equal(await page.locator('[name="title"]').inputValue(), "晴天");
  await page.locator('[name="title"]').fill("fixture-fail");
  await click("media-save");
  assert.match(
    await page.locator("[data-manage-status]").innerText(),
    /未完成/,
  );
  assert.equal(
    await page.locator('[name="title"]').inputValue(),
    "fixture-fail",
  );
  await page.locator('[name="title"]').fill("晴天（本地收藏）");
  await page.locator('[name="lyrics"]').fill("本地歌词");
  await click("media-save");
  assert.equal(last("/setmusictag").body.title, "晴天（本地收藏）");
  assert.equal(last("/setmusictag").body.artist, "周杰伦");
  // Confirmation cancellation must not delete a real file.
  const deletions = requests.filter((r) => r.path === "/delmusic").length;
  page.once("dialog", (d) => d.dismiss());
  await click("media-delete");
  assert.equal(
    requests.filter((r) => r.path === "/delmusic").length,
    deletions,
  );
  await page.locator('[name="music"]').fill("有声书－第73章");
  await click("media-open");
  page.once("dialog", (d) => d.accept());
  await click("media-delete");
  assert.equal(last("/delmusic").body.name, "有声书－第73章");
  assert.ok(!lists["全部"].includes("有声书－第73章"));
  await click("section:device");
  await page.locator('[name="did"]').selectOption("b");
  await click("device-status");
  assert.equal(last("/getplayerstatus").query.did, "b");
  assert.match(await page.locator("[data-device-status]").innerText(), /12000/);
  await page.locator('[name="tts"]').fill("晚安");
  await click("device-tts");
  assert.deepEqual(last("/playtts").query, { did: "b", text: "晚安" });
  await page.locator('[name="cmd"]').fill("单曲循环");
  page.once("dialog", (d) => d.accept());
  await click("device-command");
  assert.deepEqual(last("/cmd").body, { did: "b", cmd: "单曲循环" });
  await page
    .locator('[name="local-url"]')
    .fill("http://192.168.100.99:8090/music/test.mp3");
  await click("device-url");
  assert.equal(last("/playurl").query.did, "b");
  await click("section:plugins");
  await page.locator('[name="plugin-password"]').fill("wrong");
  await click("plugins-unlock");
  assert.equal(await page.locator("[data-plugin]").count(), 0);
  await page.locator('[name="plugin-password"]').fill("fixture-admin");
  await click("plugins-unlock");
  await click("plugin-disable");
  assert.equal(last("/api/js-plugins/FixturePlugin/disable").method, "PUT");
  page.once("dialog", (d) => d.accept());
  await click("plugin-uninstall");
  assert.equal(
    last("/api/js-plugins/FixturePlugin/uninstall").method,
    "DELETE",
  );
  await click("section:advanced");
  assert.ok(
    !(await page.locator(".manage-editor").innerHTML()).includes(
      "fixture-hidden",
    ),
  );
  for (const width of [390, 1024, 1440]) {
    await page.setViewportSize({ width, height: 1000 });
    await page.waitForTimeout(150);
    assert.equal(
      await page.evaluate(
        () =>
          document.documentElement.scrollWidth -
          document.documentElement.clientWidth,
      ),
      0,
    );
    await page.screenshot({
      path: path.join(artifacts, `management-advanced-${width}.png`),
      fullPage: true,
    });
  }
  await click("section:system");
  await click("tasks-refresh");
  page.once("dialog", (d) => d.accept());
  await click("task-pause");
  assert.deepEqual(last("/pause_download").query, { task_id: "fixtureTask" });
  page.once("dialog", (d) => d.accept());
  await click("task-stop");
  assert.deepEqual(last("/stop_download").query, { task_id: "fixtureTask" });
  await click("tasks-clear");
  await click("version-check");
  assert.match(await page.locator("[data-version]").innerText(), /0.6.2/);
  await click("section:playlists");
  await page.locator('[name="playlist"]').selectOption("晚间精选");
  await click("playlist-open");
  for (const width of [390, 1024, 1440]) {
    await page.setViewportSize({ width, height: 1000 });
    await page.waitForTimeout(150);
    assert.equal(
      await page.evaluate(
        () =>
          document.documentElement.scrollWidth -
          document.documentElement.clientWidth,
      ),
      0,
    );
    await page.screenshot({
      path: path.join(artifacts, `management-playlists-${width}.png`),
      fullPage: true,
    });
  }
  page.once("dialog", (d) => d.accept());
  await click("playlist-delete");
  assert.equal(lists["晚间精选"], undefined);
  for (const section of [
    "playlists",
    "media",
    "device",
    "plugins",
    "advanced",
    "system",
  ]) {
    await click("section:" + section);
    for (const [width, height] of [
      [375, 812],
      [390, 844],
      [844, 390],
      [1024, 1000],
    ]) {
      await page.setViewportSize({ width, height });
      await page.waitForTimeout(150);
      assert.equal(
        await page.evaluate(
          () =>
            document.documentElement.scrollWidth -
            document.documentElement.clientWidth,
        ),
        0,
        section + ":" + width,
      );
      if (width === 390 || width === 1024)
        await page.screenshot({
          path: path.join(
            artifacts,
            `management-${section}-viewport-${width}.png`,
          ),
        });
    }
    assert.equal(
      await page.locator("#toast").isVisible(),
      false,
      "section change clears stale notifications",
    );
  }
};
