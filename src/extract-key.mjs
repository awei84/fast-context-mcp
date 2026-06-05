/**
 * Windsurf API Key extraction from local installation.
 *
 * Cross-platform: macOS / Windows / Linux.
 * Uses sql.js (pure JS/WASM) to read state.vscdb — no native compilation needed.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir, platform } from "node:os";
import initSqlJs from "sql.js";

/**
 * Get all candidate paths to state.vscdb across Windsurf and Devin installations.
 *
 * Windsurf 已被 Devin 接管（同一团队的接续产品），DB schema 一字未改（表名 `ItemTable`、
 * 字段名 `windsurfAuthStatus` 保留），仅应用目录名从 `Windsurf` 改为 `Devin`。
 * 老用户可能仍是 Windsurf，新用户一律 Devin。候选路径顺序保留 legacy 兼容；
 * 自动提取时会读取所有候选 DB，并优先选择 devin-session-token$ 格式的当前凭证。
 *
 * @param {Object} [deps]  依赖注入（便于测试）
 * @param {string} [deps.platform]  覆盖 os.platform()，取 "darwin" | "win32" | 其他
 * @param {string} [deps.home]     覆盖 os.homedir()
 * @param {string} [deps.xdgConfigHome]  覆盖 process.env.XDG_CONFIG_HOME
 * @param {string} [deps.appdata]  覆盖 process.env.APPDATA
 * @returns {string[]}
 */
export function getDbPathCandidates(deps = {}) {
  const plat = deps.platform ?? platform();
  const home = deps.home ?? homedir();
  const xdg = deps.xdgConfigHome ?? process.env.XDG_CONFIG_HOME;
  const appdata = deps.appdata ?? process.env.APPDATA;
  const out = [];

  if (plat === "darwin") {
    const appSupp = join(home, "Library", "Application Support");
    out.push(join(appSupp, "Windsurf", "User", "globalStorage", "state.vscdb"));
    out.push(join(appSupp, "Devin", "User", "globalStorage", "state.vscdb"));
  } else if (plat === "win32") {
    if (!appdata) {
      throw new Error("Cannot determine APPDATA path");
    }
    out.push(join(appdata, "Windsurf", "User", "globalStorage", "state.vscdb"));
    out.push(join(appdata, "Devin", "User", "globalStorage", "state.vscdb"));
  } else {
    // Linux（Devin 目录名小写 devin，Windsurf 大写 Windsurf——按实际安装观察）
    const config = xdg || join(home, ".config");
    out.push(join(config, "Windsurf", "User", "globalStorage", "state.vscdb"));
    out.push(join(config, "devin", "User", "globalStorage", "state.vscdb"));
  }
  return out;
}

/**
 * Backward-compatible: return the first candidate (legacy Windsurf path).
 * 不论文件是否存在，都返回第一个候选——保留旧行为以便外部代码继续单点探测。
 * 若想自动选择可用凭证，请用 `extractKey()`。
 * @param {Object} [deps]
 * @returns {string}
 */
export function getDbPath(deps) {
  return getDbPathCandidates(deps)[0];
}

/**
 * 判断是否是当前 Devin/Windsurf 会话 token。
 * @param {string} key
 * @returns {boolean}
 */
function isPreferredApiKey(key) {
  return typeof key === "string" && key.startsWith("devin-session-token$");
}

async function readApiKeyFromDb(dbPath) {
  if (!existsSync(dbPath)) {
    return {
      error: `Windsurf / Devin database not found: ${dbPath}`,
      hint: "Ensure Windsurf or Devin is installed and logged in.",
      db_path: dbPath,
    };
  }

  let db;
  try {
    const SQL = await initSqlJs();
    const buf = readFileSync(dbPath);
    db = new SQL.Database(buf);
  } catch (e) {
    return { error: `Failed to open database: ${e.message}`, db_path: dbPath };
  }

  try {
    const stmt = db.prepare("SELECT value FROM ItemTable WHERE key = 'windsurfAuthStatus'");
    if (!stmt.step()) {
      stmt.free();
      return {
        error: "windsurfAuthStatus record not found",
        hint: "Ensure Windsurf or Devin is logged in.",
        db_path: dbPath,
      };
    }

    const row = stmt.getAsObject();
    stmt.free();

    let data;
    try {
      data = JSON.parse(row.value);
    } catch {
      return { error: "windsurfAuthStatus data parse failed", db_path: dbPath };
    }

    const apiKey = data.apiKey || "";
    if (!apiKey) {
      return { error: "apiKey field is empty", db_path: dbPath };
    }

    return { api_key: apiKey, db_path: dbPath };
  } catch (e) {
    return { error: `Extraction failed: ${e.message}`, db_path: dbPath };
  } finally {
    db.close();
  }
}

/**
 * Extract API Key from Windsurf / Devin state.vscdb.
 *
 * 自动探测会扫描 Windsurf / Devin 候选 DB，优先返回 devin-session-token$ 格式的当前凭证。
 * 也可显式传入 dbPath（测试 / 高级场景）。
 *
 * @param {string} [dbPath]
 * @param {Object} [deps]  依赖注入（便于测试）
 * @returns {Promise<{ api_key?: string, db_path: string, error?: string, hint?: string }>}
 */
export async function extractKey(dbPath, deps) {
  if (dbPath) {
    return readApiKeyFromDb(dbPath);
  }

  const candidates = getDbPathCandidates(deps);
  const existing = candidates.filter((p) => existsSync(p));
  if (!existing.length) {
    return {
      error: `Windsurf / Devin database not found. Tried:\n${candidates.map((p) => `  - ${p}`).join("\n")}`,
      hint: "Ensure Windsurf or Devin is installed and logged in.",
      db_path: candidates[0] || "",
    };
  }

  let firstUsable = null;
  const failures = [];
  for (const p of existing) {
    const result = await readApiKeyFromDb(p);
    if (result.api_key) {
      if (isPreferredApiKey(result.api_key)) {
        return result;
      }
      if (!firstUsable) firstUsable = result;
    } else {
      failures.push(result);
    }
  }

  if (firstUsable) return firstUsable;

  return {
    error: `No usable apiKey found in Windsurf / Devin databases. Tried:\n${failures.map((r) => `  - ${r.db_path}: ${r.error}`).join("\n")}`,
    hint: "Ensure Windsurf or Devin is installed and logged in.",
    db_path: existing[0] || candidates[0] || "",
  };
}
