#!/usr/bin/env node
/**
 * Windsurf Fast Context MCP Server (Node.js)
 *
 * AI-driven semantic code search via reverse-engineered Windsurf protocol.
 *
 * Configuration (environment variables):
 *   WINDSURF_API_KEY     — Windsurf API key (auto-discovered from local install if not set)
 *   FC_MAX_TURNS         — Search rounds per query (default: 3)
 *   FC_MAX_COMMANDS      — Max parallel commands per round (default: 8)
 *   FC_TIMEOUT_MS        — Connect-Timeout-Ms for streaming requests (default: 30000)
 *
 * Start:
 *   node src/server.mjs
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { z } from "zod";

import { searchWithContent, extractKeyInfo } from "./core.mjs";
import { projectPathSchema, validateProjectPath } from "./project-path.mjs";

const PACKAGE_JSON = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
export const SERVER_VERSION = PACKAGE_JSON.version;

/**
 * Parse an integer env var with optional clamping.
 * @param {string} name
 * @param {number} defaultValue
 * @param {{ min?: number, max?: number }} [opts]
 * @returns {number}
 */
export function readIntEnv(name, defaultValue, opts = {}, env = process.env) {
  const raw = env[name];
  const parsed = Number.parseInt(raw ?? "", 10);
  if (!Number.isFinite(parsed)) return defaultValue;
  const min = typeof opts.min === "number" ? opts.min : null;
  const max = typeof opts.max === "number" ? opts.max : null;
  let value = parsed;
  if (min !== null) value = Math.max(min, value);
  if (max !== null) value = Math.min(max, value);
  return value;
}

/**
 * Parse a boolean env var.
 * @param {string} name
 * @param {boolean} defaultValue
 * @returns {boolean}
 */
export function readBoolEnv(name, defaultValue, env = process.env) {
  const raw = env[name];
  if (raw == null) return defaultValue;
  const v = String(raw).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(v)) return true;
  if (["0", "false", "no", "off"].includes(v)) return false;
  return defaultValue;
}

export function readRuntimeConfig(env = process.env) {
  return {
    maxTurns: readIntEnv("FC_MAX_TURNS", 3, { min: 1, max: 5 }, env),
    maxCommands: readIntEnv("FC_MAX_COMMANDS", 8, { min: 1, max: 20 }, env),
    timeoutMs: readIntEnv("FC_TIMEOUT_MS", 30000, { min: 1000, max: 300000 }, env),
    repoMapMode: env.FC_REPO_MAP_MODE === "classic" ? "classic" : "bootstrap_hotspot",
    bootstrapTreeDepth: readIntEnv("FC_BOOTSTRAP_TREE_DEPTH", 1, { min: 1, max: 3 }, env),
    hotspotTopK: readIntEnv("FC_HOTSPOT_TOP_K", 4, { min: 0, max: 8 }, env),
    hotspotTreeDepth: readIntEnv("FC_HOTSPOT_TREE_DEPTH", 2, { min: 1, max: 4 }, env),
    hotspotMaxBytes: readIntEnv("FC_HOTSPOT_MAX_BYTES", 122880, { min: 16384, max: 262144 }, env),
    bootstrapEnabled: readBoolEnv("FC_BOOTSTRAP_ENABLED", true, env),
    bootstrapMaxTurns: readIntEnv("FC_BOOTSTRAP_MAX_TURNS", 2, { min: 1, max: 3 }, env),
    bootstrapMaxCommands: readIntEnv("FC_BOOTSTRAP_MAX_COMMANDS", 6, { min: 1, max: 8 }, env),
    includeSnippets: readBoolEnv("FC_INCLUDE_SNIPPETS", false, env),
    includeSnippetsExplicitlySet: env.FC_INCLUDE_SNIPPETS != null,
  };
}

export function buildFastContextSearchTool({
  config = readRuntimeConfig(),
  deps = {},
} = {}) {
  const runSearchWithContent = deps.searchWithContent || searchWithContent;
  const validatePath = deps.validateProjectPath || validateProjectPath;
  const description =
    "AI-driven semantic code search using Windsurf's Devstral model. " +
    "Searches a codebase with natural language and returns relevant file paths with line ranges, " +
    "plus suggested grep keywords for follow-up searches.\n" +
    "For best semantic search quality, write the query primarily in English; add local-language business terms only when needed.\n" +
    "Use tree_depth/max_turns/max_results for task-level tuning; use exclude_paths to reduce payload or noise.\n" +
    (config.includeSnippetsExplicitlySet
      ? `- include_code_snippets: Server-configured default is ${config.includeSnippets}. Do NOT override unless explicitly asked by the user.\n`
      : "- include_code_snippets: Default false (lightweight mode, ~2-5KB output). " +
      "Set to true to include full code snippets in the response (~45KB output).\n") +
    "Response includes a [config] line showing actual parameters used \u2014 use this to decide adjustments on retry.";

  const schema = {
    query: z.string().describe(
      'Natural language search query. English is recommended for best semantic matching; add local-language business terms when useful (e.g. "where is user login authentication and JWT validation handled 登录鉴权", "database connection pool")'
    ),
    project_path: projectPathSchema.describe(
      "Absolute path to project root directory (required). " +
      "Example: /Users/username/projects/myproject or C:/Users/username/projects/myproject"
    ),
    tree_depth: z
      .number()
      .int()
      .min(0)
      .max(6)
      .default(3)
      .describe(
        "Directory tree depth for the initial repo map sent to the remote AI. " +
        "Use 0 for auto depth based on project size. " +
        "Default 3. Use 1-2 for huge monorepos (>5000 files) or if you get payload size errors. " +
        "Use 4-6 for small projects (<200 files) where you want the AI to see deeper structure. " +
        "Auto falls back to a lower depth if tree output exceeds 250KB."
      ),
    max_turns: z
      .number()
      .int()
      .min(1)
      .max(5)
      .default(config.maxTurns)
      .describe(
        "Number of search rounds. Each round: remote AI generates search commands → local execution → results sent back. " +
        "Default 3. Use 1 for quick simple lookups. Use 4-5 for complex queries requiring deep tracing across many files. " +
        "More rounds = better results but slower and uses more API quota."
      ),
    max_results: z
      .number()
      .int()
      .min(1)
      .max(30)
      .default(10)
      .describe(
        "Maximum number of files to return. Default 10. " +
        "Use a smaller value (3-5) for focused queries. " +
        "Use a larger value (15-30) for broad exploration queries."
      ),
    exclude_paths: z
      .array(z.string())
      .default([])
      .describe(
        "Directory/file patterns to exclude from tree and search context. " +
        "Useful for reducing payload size on large repos. " +
        "Examples: ['node_modules', 'dist', '.git', 'build', 'coverage', '*.min.*']"
      ),
    include_code_snippets: z
      .boolean()
      .default(config.includeSnippets)
      .describe(
        config.includeSnippetsExplicitlySet
          ? `Include full code snippets in the response. ` +
          `Server default: ${config.includeSnippets} (configured via FC_INCLUDE_SNIPPETS env var). ` +
          `Do NOT override this value unless the user explicitly asks for a different mode.`
          : `Include full code snippets in the response. ` +
          `Default false (lightweight mode: file paths + line ranges + grep keywords, ~2-5KB output). ` +
          `Set to true for full code context (~45KB output).`
      ),
  };

  const handler = async ({
    query,
    project_path,
    tree_depth,
    max_turns,
    max_results,
    exclude_paths,
    include_code_snippets,
  }) => {
    const projectPath = project_path;
    const validationError = validatePath(projectPath);
    if (validationError) {
      return { content: [{ type: "text", text: validationError }] };
    }

    try {
      const result = await runSearchWithContent({
        query,
        projectRoot: projectPath,
        maxTurns: max_turns,
        maxCommands: config.maxCommands,
        maxResults: max_results,
        treeDepth: tree_depth,
        timeoutMs: config.timeoutMs,
        excludePaths: exclude_paths,
        repoMapMode: config.repoMapMode,
        bootstrapTreeDepth: config.bootstrapTreeDepth,
        hotspotTopK: config.hotspotTopK,
        hotspotTreeDepth: config.hotspotTreeDepth,
        hotspotMaxBytes: config.hotspotMaxBytes,
        bootstrapEnabled: config.bootstrapEnabled,
        bootstrapMaxTurns: config.bootstrapMaxTurns,
        bootstrapMaxCommands: config.bootstrapMaxCommands,
        includeSnippets: include_code_snippets,
      });
      return { content: [{ type: "text", text: result }] };
    } catch (e) {
      const code = e.code || "UNKNOWN";
      return {
        content: [{
          type: "text", text:
            `Error [${code}]: ${e.message}\n\n` +
            `[hint] Suggestions based on error type:\n` +
            `  - Reduce tree_depth (current: ${tree_depth})\n` +
            `  - Add exclude_paths to filter large directories (e.g. ['node_modules', 'dist'])\n` +
            `  - Narrow project_path to a subdirectory\n` +
            `  - Reduce max_turns (current: ${max_turns})`
        }]
      };
    }
  };

  return {
    name: "fast_context_search",
    description,
    schema,
    handler,
  };
}

export function buildExtractWindsurfKeyTool({ deps = {} } = {}) {
  const getExtractKeyInfo = deps.extractKeyInfo || extractKeyInfo;

  return {
    name: "extract_windsurf_key",
    description:
      "Extract Windsurf API Key from local installation. " +
      "Auto-detects OS (macOS/Windows/Linux) and reads the API key from " +
      "Windsurf's local database. Set the result as WINDSURF_API_KEY env var.",
    schema: {},
    handler: async () => {
      const result = await getExtractKeyInfo();

      if (result.error) {
        const text = `Error: ${result.error}\n${result.hint || ""}\nDB path: ${result.db_path || "N/A"}`;
        return { content: [{ type: "text", text }] };
      }

      const key = result.api_key;
      const text =
        `Windsurf API Key extracted successfully\n\n` +
        `  Key: ${key.slice(0, 30)}...${key.slice(-10)}\n` +
        `  Length: ${key.length}\n` +
        `  Source: ${result.db_path}\n\n` +
        `Usage:\n` +
        `  export WINDSURF_API_KEY="${key}"`;

      return { content: [{ type: "text", text }] };
    },
  };
}

export function createServer({
  config = readRuntimeConfig(),
  deps = {},
} = {}) {
  const server = new McpServer({
    name: "windsurf-fast-context",
    version: SERVER_VERSION,
    instructions:
      "Windsurf Fast Context — AI-driven semantic code search. " +
      "Returns file paths with line ranges, grep keywords, and diagnostic [config] lines. " +
      "Retry with lower tree_depth/max_turns or add exclude_paths when payload, timeout, or noisy-result issues occur.",
  });

  const fastContextTool = buildFastContextSearchTool({ config, deps });
  server.tool(
    fastContextTool.name,
    fastContextTool.description,
    fastContextTool.schema,
    fastContextTool.handler,
  );

  const extractKeyTool = buildExtractWindsurfKeyTool({ deps });
  server.tool(
    extractKeyTool.name,
    extractKeyTool.description,
    extractKeyTool.schema,
    extractKeyTool.handler,
  );

  return server;
}

export function isDirectRun(argvPath = process.argv[1], moduleUrl = import.meta.url) {
  if (!argvPath) return false;
  try {
    return realpathSync(argvPath) === realpathSync(fileURLToPath(moduleUrl));
  } catch {
    return false;
  }
}

// ─── Start ─────────────────────────────────────────────────

async function main() {
  const transport = new StdioServerTransport();
  const server = createServer();
  await server.connect(transport);
}

if (isDirectRun()) {
  main().catch((err) => {
    console.error("Fatal error:", err);
    process.exit(1);
  });
}
