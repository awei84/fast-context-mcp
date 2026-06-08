import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  formatNoRelevantFilesFound,
  isAcceptableApiKey,
  looksTruncated,
  selectNoResultRetryProjectRoots,
} from "../src/core.mjs";

describe("isAcceptableApiKey", () => {
  it("accepts the legacy sk-ws- key format", () => {
    assert.equal(isAcceptableApiKey("sk-ws-01-abcdefg"), true);
  });

  it("accepts the current devin-session-token key format", () => {
    // 回归保护：Windsurf 已从 sk-ws- 改为 devin-session-token，
    // 旧的 startsWith("sk-") 校验会错误丢弃此格式，导致自动发现失败。
    assert.equal(isAcceptableApiKey("devin-session-token-xxxxxxxx"), true);
  });

  it("accepts any non-empty string (no prefix assumption)", () => {
    assert.equal(isAcceptableApiKey("future-unknown-prefix-123"), true);
  });

  it("rejects empty, whitespace, and non-string values", () => {
    assert.equal(isAcceptableApiKey(""), false);
    assert.equal(isAcceptableApiKey("   "), false);
    assert.equal(isAcceptableApiKey(null), false);
    assert.equal(isAcceptableApiKey(undefined), false);
    assert.equal(isAcceptableApiKey(12345), false);
  });
});

describe("looksTruncated", () => {
  it("accepts a complete devin-session-token$<jwt> key as NOT truncated", () => {
    assert.equal(
      looksTruncated("devin-session-token$eyJhbGciOiJ.payload.sig"),
      false
    );
  });

  it("flags a key truncated to just the prefix (the $ was eaten)", () => {
    // shell 把 $eyJ... 当变量展开后，key 退化成纯前缀 —— 实测会导致 HTTP 401
    assert.equal(looksTruncated("devin-session-token"), true);
  });

  it("flags a key with a bare $ but no JWT body", () => {
    assert.equal(looksTruncated("devin-session-token$"), true);
  });

  it("flags a key whose $-suffix is not a JWT", () => {
    assert.equal(looksTruncated("devin-session-token$garbage"), true);
  });

  it("does not flag non-devin keys (legacy sk-ws- or unknown)", () => {
    // 只对 devin-session-token 格式做截断判断，避免误伤其他格式
    assert.equal(looksTruncated("sk-ws-01-abcdef"), false);
    assert.equal(looksTruncated("some-other-token"), false);
    assert.equal(looksTruncated(""), false);
    assert.equal(looksTruncated(null), false);
  });
});

describe("formatNoRelevantFilesFound", () => {
  it("keeps raw response diagnostics and suggests narrowing large repos", () => {
    const text = formatNoRelevantFilesFound({
      rawResponse: "x".repeat(700),
      meta: {
        treeDepth: 1,
        hotspotDepth: 2,
        treeSizeKB: 118.4,
        fellBack: true,
        repoMapStrategy: "bootstrap_hotspot",
        hotDirs: ["backend", "docs"],
      },
      projectRoot: "/repo",
      treeDepth: 3,
      maxTurns: 2,
      maxResults: 8,
      timeoutMs: 30000,
      excludePaths: ["dist"],
    });

    assert.match(text, /No relevant files found/);
    assert.match(text, /raw_response_truncated=true, raw_response_chars=700/);
    assert.match(text, /tree_depth_used=1 \(fell back from requested depth\), hotspot_depth=2/);
    assert.match(text, /hot_dirs=\[backend, docs\]/);
    assert.match(text, /project_path=\/repo, requested_tree_depth=3/);
    assert.match(text, /exclude_paths=\[dist\]/);
    assert.match(text, /narrow project_path to a likely source subtree/);
    assert.match(text, /backend, server, src, app/);
    assert.match(text, /ent/);
  });
});

describe("selectNoResultRetryProjectRoots", () => {
  it("uses existing safe subdirectories and limits retries", () => {
    const root = mkdtempSync(join(tmpdir(), "fc-retry-roots-"));
    mkdirSync(join(root, "api"));
    mkdirSync(join(root, "src"));
    mkdirSync(join(root, "docs"));

    const roots = selectNoResultRetryProjectRoots(root, {
      hotDirs: ["../outside", "docs", "missing"],
    }, 2);

    assert.equal(roots.length, 2);
    assert.equal(roots.includes(join(root, "../outside")), false);
    assert.equal(roots.includes(join(root, "missing")), false);
    assert.ok(roots.every((p) => p.startsWith(root)));
  });

  it("falls back to common source directories", () => {
    const root = mkdtempSync(join(tmpdir(), "fc-retry-roots-"));
    mkdirSync(join(root, "src"));

    assert.deepEqual(selectNoResultRetryProjectRoots(root, null, 2), [
      join(root, "src"),
    ]);
  });

  it("prioritizes directories with local query-token matches over hot_dirs", () => {
    const root = mkdtempSync(join(tmpdir(), "fc-retry-roots-"));
    mkdirSync(join(root, "alpha"));
    mkdirSync(join(root, "beta"));
    writeFileSync(join(root, "alpha", "scheduler.go"), "openai account scheduler gateway request\n");
    writeFileSync(join(root, "beta", "view.ts"), "dashboard component settings\n");

    assert.deepEqual(
      selectNoResultRetryProjectRoots(
        root,
        { hotDirs: ["beta"] },
        2,
        "where is OpenAI account scheduler and gateway request handling implemented",
      ),
      [
        join(root, "alpha"),
        join(root, "beta"),
      ],
    );
  });

  it("works for any directory names when query tokens point elsewhere", () => {
    const root = mkdtempSync(join(tmpdir(), "fc-retry-roots-"));
    mkdirSync(join(root, "north"));
    mkdirSync(join(root, "south"));
    writeFileSync(join(root, "north", "worker.rb"), "payment reconciliation queue worker\n");
    writeFileSync(join(root, "south", "notes.md"), "account profile page\n");

    assert.deepEqual(
      selectNoResultRetryProjectRoots(
        root,
        { hotDirs: ["south"] },
        2,
        "payment queue reconciliation worker",
      ),
      [
        join(root, "north"),
        join(root, "south"),
      ],
    );
  });
});
