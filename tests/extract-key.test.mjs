import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import initSqlJs from "sql.js";

import {
  getDbPathCandidates,
  getDbPath,
  extractKey,
} from "../src/extract-key.mjs";

async function writeAuthDb(dbPath, apiKey) {
  mkdirSync(dirname(dbPath), { recursive: true });
  const SQL = await initSqlJs();
  const db = new SQL.Database();
  db.run("CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value TEXT)");
  db.run(
    "INSERT INTO ItemTable (key, value) VALUES (?, ?)",
    ["windsurfAuthStatus", JSON.stringify({ apiKey })],
  );
  writeFileSync(dbPath, Buffer.from(db.export()));
  db.close();
}

describe("getDbPathCandidates", () => {
  it("macOS: 包含 Windsurf 和 Devin 两条路径", () => {
    const ps = getDbPathCandidates({ platform: "darwin", home: "/fakehome" });
    assert.equal(ps.length, 2);
    assert.equal(ps[0], "/fakehome/Library/Application Support/Windsurf/User/globalStorage/state.vscdb");
    assert.equal(ps[1], "/fakehome/Library/Application Support/Devin/User/globalStorage/state.vscdb");
  });

  it("Linux: Windsurf 大写、Devin 小写（按实际安装观察）", () => {
    const ps = getDbPathCandidates({ platform: "linux", home: "/fakehome" });
    assert.equal(ps.length, 2);
    assert.equal(ps[0], "/fakehome/.config/Windsurf/User/globalStorage/state.vscdb");
    assert.equal(ps[1], "/fakehome/.config/devin/User/globalStorage/state.vscdb");
  });

  it("Linux: XDG_CONFIG_HOME 优先于 HOME", () => {
    const ps = getDbPathCandidates({
      platform: "linux",
      home: "/fakehome",
      xdgConfigHome: "/custom/xdg",
    });
    assert.equal(ps.length, 2);
    assert.ok(ps[0].startsWith("/custom/xdg/"));
    assert.ok(ps[0].includes("Windsurf"));
    assert.ok(ps[1].startsWith("/custom/xdg/"));
    assert.ok(ps[1].includes("devin"));
  });

  it("Windows: APPDATA 存在时返回 Windsurf + Devin 两条路径", () => {
    const ps = getDbPathCandidates({
      platform: "win32",
      appdata: "C:\\Users\\fake\\AppData\\Roaming",
    });
    assert.equal(ps.length, 2);
    assert.ok(ps[0].includes("AppData\\Roaming") || ps[0].includes("AppData/Roaming"));
    assert.ok(ps[0].includes("Windsurf"));
    assert.ok(ps[1].includes("Devin"));
  });

  it("Windows: APPDATA 缺失时 throw", () => {
    assert.throws(
      () => getDbPathCandidates({ platform: "win32", appdata: "" }),
      /Cannot determine APPDATA path/,
    );
    assert.throws(
      () => getDbPathCandidates({ platform: "win32" }), // undefined → throw
      /Cannot determine APPDATA path/,
    );
  });

  it("fallback 到 home/.config（Linux 无 XDG）", () => {
    const ps = getDbPathCandidates({ platform: "linux", home: "/h" });
    assert.equal(ps[0], "/h/.config/Windsurf/User/globalStorage/state.vscdb");
    assert.equal(ps[1], "/h/.config/devin/User/globalStorage/state.vscdb");
  });
});

describe("getDbPath (backward-compat)", () => {
  it("返回第一个候选（Windsurf 老路径），不探测文件存在性", () => {
    const p = getDbPath({ platform: "darwin", home: "/fakehome" });
    assert.equal(p, "/fakehome/Library/Application Support/Windsurf/User/globalStorage/state.vscdb");
    assert.ok(p.includes("Windsurf"));
  });

  it("Linux 平台也返回 Windsurf 在前", () => {
    const p = getDbPath({ platform: "linux", home: "/fakehome" });
    assert.equal(p, "/fakehome/.config/Windsurf/User/globalStorage/state.vscdb");
  });
});

describe("extractKey (auto-detect)", () => {
  let tmpRoot;

  before(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "fc-extract-key-test-"));
  });

  after(() => {
    if (tmpRoot && existsSync(tmpRoot)) {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it("全部候选都不存在时，错误信息列出所有尝试过的路径", async () => {
    const r = await extractKey(undefined, { platform: "darwin", home: tmpRoot });
    assert.ok(!r.api_key);
    assert.ok(r.error, "应当返回 error");
    assert.ok(r.error.includes("Tried:"), "错误信息应包含 'Tried:'");
    assert.ok(r.error.includes("Windsurf"));
    assert.ok(r.error.includes("Devin"));
    assert.ok(r.hint && r.hint.includes("Windsurf") && r.hint.includes("Devin"));
  });

  it("Linux 平台下，全部候选都不存在时，错误信息列出 .config/Windsurf + .config/devin", async () => {
    const r = await extractKey(undefined, { platform: "linux", home: tmpRoot });
    assert.ok(!r.api_key);
    assert.ok(r.error.includes("Tried:"));
    assert.ok(r.error.includes(".config/Windsurf"));
    assert.ok(r.error.includes(".config/devin"));
  });

  it("显式传入 dbPath 时不走自动探测", async () => {
    const fakePath = join(tmpRoot, "no-such-db.vscdb");
    const r = await extractKey(fakePath);
    assert.ok(!r.api_key);
    assert.ok(r.error.includes("Windsurf / Devin database not found"));
    assert.equal(r.db_path, fakePath);
  });

  it("Windows 同时存在 Windsurf 与 Devin DB 时，优先选择 devin-session-token", async () => {
    const appdata = join(tmpRoot, "win-appdata-current-token");
    const windsurfDb = join(appdata, "Windsurf", "User", "globalStorage", "state.vscdb");
    const devinDb = join(appdata, "Devin", "User", "globalStorage", "state.vscdb");
    await writeAuthDb(windsurfDb, "sk-ws-01-old-token");
    await writeAuthDb(devinDb, "devin-session-token$eyJ.current.payload");

    const r = await extractKey(undefined, { platform: "win32", appdata });

    assert.equal(r.api_key, "devin-session-token$eyJ.current.payload");
    assert.equal(r.db_path, devinDb);
  });

  it("没有 devin-session-token 时，回退到第一个可用 key", async () => {
    const appdata = join(tmpRoot, "win-appdata-legacy-token");
    const windsurfDb = join(appdata, "Windsurf", "User", "globalStorage", "state.vscdb");
    await writeAuthDb(windsurfDb, "sk-ws-01-legacy-token");

    const r = await extractKey(undefined, { platform: "win32", appdata });

    assert.equal(r.api_key, "sk-ws-01-legacy-token");
    assert.equal(r.db_path, windsurfDb);
  });

  it("真实环境集成测试：能从本机 Devin/Windsurf DB 取到 key（若已装）", async (t) => {
    // 跳过条件：CI 容器 / 干净 mac 通常没装 Devin，跑这个 case 没意义
    const home = process.env.HOME || "";
    const devinPath = join(
      home,
      "Library",
      "Application Support",
      "Devin",
      "User",
      "globalStorage",
      "state.vscdb",
    );
    const windsurfPath = join(
      home,
      "Library",
      "Application Support",
      "Windsurf",
      "User",
      "globalStorage",
      "state.vscdb",
    );
    if (!existsSync(devinPath) && !existsSync(windsurfPath)) {
      t.skip("local Devin/Windsurf DB is not installed");
      return;
    }
    const r = await extractKey();
    if (r.error) {
      assert.fail(`DB exists but api key extraction failed: ${r.error}`);
    }
    assert.ok(r.api_key, "应当能取到 api_key");
    assert.ok(r.api_key.length > 20, "api_key 长度合理");
    assert.ok(
      r.db_path === devinPath || r.db_path === windsurfPath,
      `db_path 应为 Devin 或 Windsurf 之一，实际: ${r.db_path}`,
    );
  });
});
