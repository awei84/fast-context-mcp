import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { renderTree } from "../src/tree.mjs";

function makeFixture() {
  const root = mkdtempSync(join(tmpdir(), "fc-tree-"));
  mkdirSync(join(root, "src"));
  mkdirSync(join(root, "src", "nested"));
  mkdirSync(join(root, "dist"));
  writeFileSync(join(root, "README.md"), "readme\n");
  writeFileSync(join(root, "src", "index.mjs"), "export {};\n");
  writeFileSync(join(root, "src", "nested", "deep.txt"), "deep\n");
  writeFileSync(join(root, "dist", "bundle.js"), "bundle\n");
  return root;
}

describe("renderTree", () => {
  it("renders a stable text tree with maxDepth", () => {
    const root = makeFixture();

    const tree = renderTree(root, { maxDepth: 1, rootLabel: "/codebase" });

    assert.equal(tree, [
      "/codebase",
      "├── dist",
      "├── src",
      "└── README.md",
    ].join("\n"));
  });

  it("filters excluded entries", () => {
    const root = makeFixture();

    const tree = renderTree(root, {
      maxDepth: 2,
      rootLabel: "/codebase",
      exclude: [/^dist$/],
    });

    assert.doesNotMatch(tree, /dist/);
    assert.match(tree, /src/);
    assert.match(tree, /README\.md/);
  });

  it("throws when the root directory cannot be read", () => {
    const root = makeFixture();

    assert.throws(
      () => renderTree(join(root, "missing"), { rootLabel: "/codebase" }),
      /ENOENT/,
    );
  });

  it("does not recurse into symlinks", (t) => {
    const root = makeFixture();
    try {
      symlinkSync(join(root, "src"), join(root, "src-link"), "dir");
    } catch {
      t.skip("symlink creation is not available in this environment");
      return;
    }

    const tree = renderTree(root, { maxDepth: 2, rootLabel: "/codebase" });
    const linkLine = tree.split("\n").find((line) => line.includes("src-link"));

    assert.ok(linkLine);
    assert.doesNotMatch(tree, /src-link.*\n.*index\.mjs/s);
  });
});
