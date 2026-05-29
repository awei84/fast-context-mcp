import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ToolExecutor } from "../src/executor.mjs";

function makeProject() {
  const root = mkdtempSync(join(tmpdir(), "fc-executor-"));
  writeFileSync(join(root, "a.txt"), "alpha\n");
  writeFileSync(join(root, "b.txt"), "bravo\n");
  return root;
}

describe("ToolExecutor path boundary", () => {
  it("allows /codebase-rooted paths", () => {
    const executor = new ToolExecutor(makeProject());
    const out = executor.readfile("/codebase/a.txt");
    assert.match(out, /1:alpha/);
  });

  it("rejects traversal outside /codebase", () => {
    const executor = new ToolExecutor(makeProject());
    const out = executor.readfile("/codebase/../../../etc/passwd");
    assert.match(out, /must stay within \/codebase/);
  });

  it("rejects absolute filesystem paths", () => {
    const executor = new ToolExecutor(makeProject());
    const out = executor.readfile("/etc/passwd");
    assert.match(out, /must stay within \/codebase/);
  });

  it("rejects non-/codebase search paths", () => {
    const executor = new ToolExecutor(makeProject());
    const out = executor.rg("alpha", "/tmp");
    assert.match(out, /must stay within \/codebase/);
  });
});

describe("ToolExecutor command ordering", () => {
  it("sorts command keys by numeric suffix", () => {
    const executor = new ToolExecutor(makeProject());
    const out = executor.execToolCall({
      command10: { type: "readfile", file: "/codebase/b.txt" },
      command2: { type: "readfile", file: "/codebase/a.txt" },
      command1: { type: "readfile", file: "/codebase/a.txt" },
    });

    assert.ok(
      out.indexOf("<command1_result>") < out.indexOf("<command2_result>"),
      "command1 should come before command2",
    );
    assert.ok(
      out.indexOf("<command2_result>") < out.indexOf("<command10_result>"),
      "command2 should come before command10",
    );
  });
});
