import { lstatSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";

const DEFAULT_MAX_DEPTH = Number.POSITIVE_INFINITY;

function shouldExclude(name, exclude = []) {
  return exclude.some((pattern) => {
    if (pattern instanceof RegExp) return pattern.test(name);
    if (typeof pattern === "string") return pattern === name;
    return false;
  });
}

function readEntries(dir, exclude) {
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => !shouldExclude(entry.name, exclude))
    .sort((a, b) => {
      const aDir = a.isDirectory();
      const bDir = b.isDirectory();
      if (aDir !== bDir) return aDir ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
}

function isDirectoryEntry(parent, entry) {
  if (typeof entry.isSymbolicLink === "function" && entry.isSymbolicLink()) {
    return false;
  }
  if (typeof entry.isDirectory === "function") {
    return entry.isDirectory();
  }
  try {
    return lstatSync(join(parent, entry.name)).isDirectory();
  } catch {
    return false;
  }
}

function renderChildren(dir, depth, maxDepth, exclude, prefix, lines) {
  if (depth >= maxDepth) return;

  let entries;
  try {
    entries = readEntries(dir, exclude);
  } catch (e) {
    if (depth === 0) throw e;
    lines.push(`${prefix}(inaccessible: ${e.message})`);
    return;
  }

  entries.forEach((entry, index) => {
    const isLast = index === entries.length - 1;
    const branch = isLast ? "└── " : "├── ";
    lines.push(`${prefix}${branch}${entry.name}`);

    if (isDirectoryEntry(dir, entry)) {
      const nextPrefix = prefix + (isLast ? "    " : "│   ");
      renderChildren(join(dir, entry.name), depth + 1, maxDepth, exclude, nextPrefix, lines);
    }
  });
}

/**
 * 渲染目录树文本，作为轻量内置 tree 实现。
 *
 * @param {string} root
 * @param {{ maxDepth?: number, exclude?: Array<RegExp|string>, rootLabel?: string }} [options]
 * @returns {string}
 */
export function renderTree(root, options = {}) {
  const maxDepth = Number.isFinite(options.maxDepth) && options.maxDepth >= 0
    ? options.maxDepth
    : DEFAULT_MAX_DEPTH;
  const rootLabel = options.rootLabel || basename(root) || root;
  const lines = [rootLabel];

  if (maxDepth > 0) {
    renderChildren(root, 0, maxDepth, options.exclude || [], "", lines);
  }

  return lines.join("\n");
}
