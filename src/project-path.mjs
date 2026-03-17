import { statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { z } from "zod";

export const PROJECT_PATH_REQUIRED_MESSAGE =
  "project_path is required. Pass the absolute path to the project root directory.";

export const projectPathSchema = z
  .string()
  .trim()
  .min(1, PROJECT_PATH_REQUIRED_MESSAGE);

/**
 * Validate the project root path provided to fast_context_search.
 * Returns null when valid, otherwise an MCP-friendly error string.
 *
 * @param {string} projectPath
 * @param {(path: string) => import("node:fs").Stats} [statFn]
 * @returns {string|null}
 */
export function validateProjectPath(projectPath, statFn = statSync) {
  if (!projectPath) {
    return `Error: ${PROJECT_PATH_REQUIRED_MESSAGE}`;
  }

  if (!isAbsolute(projectPath)) {
    return `Error: project_path must be an absolute path, got: ${projectPath}`;
  }

  try {
    const st = statFn(projectPath);
    if (!st.isDirectory()) {
      return `Error: project_path is not a directory: ${projectPath}`;
    }
  } catch (error) {
    if (error?.code === "ENOENT") {
      return `Error: project_path does not exist: ${projectPath}`;
    }
    if (error?.code === "EACCES" || error?.code === "EPERM") {
      return `Error: cannot access project_path (${error.code}): ${projectPath}`;
    }
    const reason = error?.message ? `${error.code || "UNKNOWN"}: ${error.message}` : String(error);
    return `Error: failed to validate project_path: ${reason}`;
  }

  return null;
}
