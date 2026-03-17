import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  PROJECT_PATH_REQUIRED_MESSAGE,
  projectPathSchema,
  validateProjectPath,
} from "../src/project-path.mjs";

describe("project_path schema validation", () => {
  it("rejects empty string", () => {
    const result = projectPathSchema.safeParse("");
    assert.equal(result.success, false, "empty string should be rejected");
  });

  it("rejects whitespace-only string", () => {
    const result = projectPathSchema.safeParse("   ");
    assert.equal(result.success, false, "whitespace-only should be rejected (trim + min(1))");
  });

  it("returns the shared required message", () => {
    const result = projectPathSchema.safeParse("");
    assert.equal(result.success, false);
    assert.equal(result.error.issues[0]?.message, PROJECT_PATH_REQUIRED_MESSAGE);
  });

  it("accepts non-empty string", () => {
    const result = projectPathSchema.safeParse("/some/path");
    assert.equal(result.success, true, "non-empty path should be accepted at schema level");
    assert.equal(result.data, "/some/path");
  });

  it("trims leading/trailing whitespace", () => {
    const result = projectPathSchema.safeParse("  /some/path  ");
    assert.equal(result.success, true);
    assert.equal(result.data, "/some/path", "should trim whitespace");
  });
});

describe("project_path runtime validation", () => {
  it("rejects empty project_path", () => {
    const err = validateProjectPath("");
    assert.ok(err, "empty path should return an error");
    assert.match(err, /required/i);
  });

  it("rejects null project_path", () => {
    const err = validateProjectPath(null);
    assert.ok(err, "null path should return an error");
    assert.match(err, /required/i);
  });

  it("rejects relative path", () => {
    const err = validateProjectPath("./src");
    assert.ok(err, "relative path should return an error");
    assert.match(err, /absolute/i);
  });

  it("rejects bare directory name", () => {
    const err = validateProjectPath("my-project");
    assert.ok(err, "bare name should return an error");
    assert.match(err, /absolute/i);
  });

  it("rejects non-existent absolute path", () => {
    const err = validateProjectPath("/nonexistent/path/that/doesnt/exist/xyz123");
    assert.ok(err, "non-existent path should return an error");
    assert.match(err, /does not exist/i);
  });

  it("rejects path to a file (not directory)", () => {
    // Create a temp file
    const tempDir = mkdtempSync(join(tmpdir(), "fc-test-"));
    const tempFile = join(tempDir, "not-a-dir.txt");
    writeFileSync(tempFile, "test");

    const err = validateProjectPath(tempFile);
    assert.ok(err, "file path should return an error");
    assert.match(err, /not a directory/i);
  });

  it("accepts valid absolute directory path", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "fc-test-"));
    const err = validateProjectPath(tempDir);
    assert.equal(err, null, "valid directory should pass validation");
  });

  it("surfaces permission errors instead of reporting missing path", () => {
    const err = validateProjectPath("/restricted/path", () => {
      const error = new Error("permission denied");
      error.code = "EACCES";
      throw error;
    });
    assert.equal(err, "Error: cannot access project_path (EACCES): /restricted/path");
  });

  it("surfaces unexpected fs errors with the real reason", () => {
    const err = validateProjectPath("/broken/path", () => {
      const error = new Error("i/o failure");
      error.code = "EIO";
      throw error;
    });
    assert.equal(err, "Error: failed to validate project_path: EIO: i/o failure");
  });
});
