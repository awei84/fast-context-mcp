/**
 * Windsurf API Key extraction from local installation.
 *
 * Cross-platform: macOS / Windows / Linux.
 * Supports both legacy (plaintext windsurfAuthStatus) and new
 * (Chromium safeStorage encrypted) storage formats.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir, platform } from "node:os";
import { execSync } from "node:child_process";
import crypto from "node:crypto";
import Database from "better-sqlite3";

const SECRET_KEY = 'secret://{"extensionId":"codeium.windsurf","key":"windsurf_auth.sessions"}';

/**
 * Get the platform-specific path to Windsurf's state.vscdb.
 * @returns {string}
 */
export function getDbPath() {
  const plat = platform();
  const home = homedir();

  if (plat === "darwin") {
    return join(home, "Library", "Application Support", "Windsurf", "User", "globalStorage", "state.vscdb");
  } else if (plat === "win32") {
    const appdata = process.env.APPDATA || "";
    if (!appdata) throw new Error("Cannot determine APPDATA path");
    return join(appdata, "Windsurf", "User", "globalStorage", "state.vscdb");
  } else {
    // Linux
    const config = process.env.XDG_CONFIG_HOME || join(home, ".config");
    return join(config, "Windsurf", "User", "globalStorage", "state.vscdb");
  }
}

// ─── Legacy extraction (plaintext windsurfAuthStatus) ──────

/**
 * Try extracting API key from legacy plaintext storage.
 * @param {Database.Database} db
 * @returns {{ api_key?: string } | null} null if key not found
 */
function extractFromLegacy(db) {
  const row = db.prepare("SELECT value FROM ItemTable WHERE key = 'windsurfAuthStatus'").get();
  if (!row) return null;

  let data;
  try {
    data = JSON.parse(row.value);
  } catch {
    return null;
  }

  const apiKey = data.apiKey || "";
  return apiKey ? { api_key: apiKey } : null;
}

// ─── New encrypted extraction (Chromium safeStorage) ───────

/**
 * Retrieve the master password from system keychain.
 * @returns {string}
 */
function getMasterPassword() {
  const plat = platform();

  if (plat === "darwin") {
    return execSync(
      'security find-generic-password -s "Windsurf Safe Storage" -a "Windsurf Key" -w',
      { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }
    ).trim();
  }

  if (plat === "linux") {
    // Try libsecret (GNOME Keyring / KDE Wallet)
    try {
      return execSync(
        'secret-tool lookup application windsurf service "Windsurf Safe Storage" account "Windsurf Key"',
        { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }
      ).trim();
    } catch {
      // No keyring available — Chromium falls back to hardcoded password
      return "peanuts";
    }
  }

  // Windows: not applicable (uses DPAPI directly, no master password)
  return "";
}

/**
 * Decrypt safeStorage data on macOS / Linux.
 * Format: 'v10' (3 bytes) + AES-128-CBC ciphertext (PBKDF2 derived key).
 * @param {Buffer} encrypted
 * @param {string} masterPassword
 * @returns {string}
 */
function decryptAesCbc(encrypted, masterPassword) {
  const plat = platform();
  const iterations = plat === "darwin" ? 1003 : 1;
  const derivedKey = crypto.pbkdf2Sync(masterPassword, "saltysalt", iterations, 16, "sha1");

  const ciphertext = encrypted.slice(3); // strip 'v10' prefix
  const iv = Buffer.alloc(16, 0x20);

  const decipher = crypto.createDecipheriv("aes-128-cbc", derivedKey, iv);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}

/**
 * Decrypt safeStorage data on Windows via DPAPI (PowerShell).
 * Electron on Windows encrypts with CryptProtectData directly — no 'v10' prefix.
 * Uses -EncodedCommand to avoid cmd.exe quoting/escaping issues.
 * @param {Buffer} encrypted
 * @returns {string}
 */
function decryptDpapi(encrypted) {
  const b64 = encrypted.toString("base64");
  const psScript =
    `Add-Type -AssemblyName System.Security;` +
    `$bytes = [Convert]::FromBase64String('${b64}');` +
    `$dec = [Security.Cryptography.ProtectedData]::Unprotect($bytes, $null, 'CurrentUser');` +
    `[Text.Encoding]::UTF8.GetString($dec)`;

  // Encode the script as UTF-16LE base64 for -EncodedCommand
  const encoded = Buffer.from(psScript, "utf16le").toString("base64");

  return execSync(`powershell -NoProfile -EncodedCommand ${encoded}`, {
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
  }).trim();
}

/**
 * Try extracting API key from encrypted secret storage.
 * @param {Database.Database} db
 * @returns {{ api_key?: string, method?: string } | null}
 */
function extractFromSecret(db) {
  const row = db.prepare("SELECT value FROM ItemTable WHERE key = ?").get(SECRET_KEY);
  if (!row) return null;

  let encryptedBuf;
  try {
    const parsed = JSON.parse(row.value);
    encryptedBuf = Buffer.from(parsed.data);
  } catch {
    return null;
  }

  let decrypted;
  const plat = platform();

  if (plat === "win32") {
    // Windows: raw DPAPI blob (no 'v10' prefix)
    decrypted = decryptDpapi(encryptedBuf);
  } else {
    // macOS / Linux: 'v10' + AES-128-CBC
    const prefix = encryptedBuf.slice(0, 3).toString("utf8");
    if (prefix !== "v10" && prefix !== "v11") return null;
    const masterPassword = getMasterPassword();
    decrypted = decryptAesCbc(encryptedBuf, masterPassword);
  }

  let sessions;
  try {
    sessions = JSON.parse(decrypted);
  } catch {
    return null;
  }

  // sessions is an array — take the first entry with an accessToken
  const entry = Array.isArray(sessions)
    ? sessions.find((s) => s.accessToken)
    : sessions;

  const token = entry?.accessToken || "";
  return token ? { api_key: token, method: "safeStorage" } : null;
}

// ─── Main entry point ──────────────────────────────────────

/**
 * Extract API Key from Windsurf state.vscdb.
 * Tries legacy plaintext first, then falls back to encrypted safeStorage.
 * @param {string} [dbPath]
 * @returns {{ api_key?: string, db_path: string, method?: string, error?: string, hint?: string }}
 */
export function extractKey(dbPath) {
  if (!dbPath) {
    dbPath = getDbPath();
  }

  if (!existsSync(dbPath)) {
    return {
      error: `Windsurf database not found: ${dbPath}`,
      hint: "Ensure Windsurf is installed and logged in.",
      db_path: dbPath,
    };
  }

  let db;
  try {
    db = new Database(dbPath, { readonly: true });
  } catch (e) {
    return { error: `Failed to open database: ${e.message}`, db_path: dbPath };
  }

  try {
    // 1) Legacy plaintext
    const legacy = extractFromLegacy(db);
    if (legacy) {
      return { ...legacy, db_path: dbPath, method: "legacy" };
    }

    // 2) Encrypted safeStorage
    const secret = extractFromSecret(db);
    if (secret) {
      return { ...secret, db_path: dbPath };
    }

    return {
      error: "No API key found in database (tried legacy + safeStorage)",
      hint: "Ensure Windsurf is logged in. You can also set WINDSURF_API_KEY manually.",
      db_path: dbPath,
    };
  } catch (e) {
    return { error: `Extraction failed: ${e.message}`, db_path: dbPath };
  } finally {
    db.close();
  }
}
