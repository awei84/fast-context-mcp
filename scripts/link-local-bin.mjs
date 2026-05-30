#!/usr/bin/env node
/**
 * 为源码仓库创建本地 bin 自链接。
 *
 * npm/npx 在当前目录的 package 名称与请求包名相同时，会优先使用当前包。
 * 这种情况下不会像安装依赖那样自动生成 node_modules/.bin/fast-context-mcp，
 * 导致在本仓库根目录执行 `npx fast-context-mcp@x` 时出现 command not found。
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const initCwd = process.env.INIT_CWD ? resolve(process.env.INIT_CWD) : repoRoot;
if (initCwd !== repoRoot) {
  process.exit(0);
}

const packageJsonPath = join(repoRoot, "package.json");
const pkg = JSON.parse(readFileSync(packageJsonPath, "utf8"));

const binTarget = pkg.bin?.["fast-context-mcp"];
if (!binTarget) {
  process.exit(0);
}

const binDir = join(repoRoot, "node_modules", ".bin");
const entryPath = join(repoRoot, binTarget);
const linkPath = join(binDir, "fast-context-mcp");

mkdirSync(binDir, { recursive: true });
chmodSync(entryPath, 0o755);

if (process.platform === "win32") {
  writeFileSync(
    `${linkPath}.cmd`,
    `@ECHO off\r\nnode "%~dp0\\..\\..\\${binTarget.replaceAll("/", "\\")}" %*\r\n`,
    "utf8",
  );
} else {
  const relativeTarget = relative(binDir, entryPath);
  try {
    rmSync(linkPath, { force: true });
    symlinkSync(relativeTarget, linkPath);
  } catch {
    writeFileSync(linkPath, `#!/bin/sh\nexec node "${relativeTarget}" "$@"\n`, "utf8");
  }
  chmodSync(linkPath, 0o755);
}
