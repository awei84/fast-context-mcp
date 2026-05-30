import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { isAcceptableApiKey, looksTruncated } from "../src/core.mjs";

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
