# Fast Context MCP

[English](./README.md) · [中文](./README_CN.md)

基于 Windsurf 逆向工程 SWE-grep 协议的 AI 语义代码搜索 MCP 工具。

任何兼容 MCP 的客户端（Claude Code、Claude Desktop、Cursor 等）均可通过自然语言查询搜索代码库。所有依赖通过 npm 打包，**无需安装系统级依赖**（ripgrep 由 `@vscode/ripgrep` 提供，tree 由 `tree-node-cli` 提供）。支持 macOS、Windows 和 Linux。

## 工作原理

```
你: "认证逻辑在哪里？"
         │
         ▼
┌─────────────────────────┐
│  Fast Context MCP       │
│  (本地 MCP 服务)         │
│                         │
│  1. 映射项目目录 → /codebase
│  2. 发送查询到 Windsurf Devstral API
│  3. AI 生成 rg/readfile/tree 命令
│  4. 本地执行命令（内置 rg）
│  5. 返回结果给 AI
│  6. 重复 N 轮
│  7. 返回文件路径 + 行号范围
│     + 建议搜索关键词
└─────────────────────────┘
         │
         ▼
找到 3 个相关文件。
  [1/3] /project/src/auth/handler.py (L10-60)
  [2/3] /project/src/middleware/jwt.py (L1-40)
  [3/3] /project/src/models/user.py (L20-80)

建议搜索关键词：
  authenticate, jwt.*verify, session.*token
```

## 前置条件

- **Node.js** >= 18
- **Windsurf 账号** — 免费版即可（用于获取 API Key）

无需手动安装 ripgrep，已通过 `@vscode/ripgrep` 打包内置。

## 安装

### 方式 A：npm（推荐）

已在 npm 上发布两个等价包名，任选其一：

```bash
# 两者完全相同，功能一致
npx fast-context-mcp
# 或
npx fast-cxt-mcp
```

无需全局安装，`npx` 会自动拉取最新版本。

### 方式 B：从源码安装

```bash
git clone https://github.com/SammySnake-d/fast-context-mcp.git
cd fast-context-mcp
npm install
```

## 配置

### 1. 获取 Windsurf API Key

服务器会自动从本地 Windsurf 安装中提取 API Key。也可以在启动后使用 `extract_windsurf_key` MCP 工具提取，或手动设置 `WINDSURF_API_KEY` 环境变量。

Key 存储在 Windsurf 的本地 SQLite 数据库中：

| 平台 | 路径 |
|------|------|
| macOS | `~/Library/Application Support/Windsurf/User/globalStorage/state.vscdb` |
| Windows | `%APPDATA%/Windsurf/User/globalStorage/state.vscdb` |
| Linux | `~/.config/Windsurf/User/globalStorage/state.vscdb` |

### 2. 配置 MCP 客户端

#### Claude Code

在 `~/.claude.json` 的 `mcpServers` 下添加：

```json
{
  "fast-context": {
    "command": "npx",
    "args": ["-y", "fast-context-mcp"],
    "env": {
      "WINDSURF_API_KEY": "sk-ws-01-xxxxx"
    }
  }
}
```

若从源码安装：

```json
{
  "fast-context": {
    "command": "node",
    "args": ["/absolute/path/to/fast-context-mcp/src/server.mjs"],
    "env": {
      "WINDSURF_API_KEY": "sk-ws-01-xxxxx"
    }
  }
}
```

#### Claude Desktop

在 `claude_desktop_config.json` 的 `mcpServers` 下添加：

```json
{
  "fast-context": {
    "command": "npx",
    "args": ["-y", "fast-context-mcp"],
    "env": {
      "WINDSURF_API_KEY": "sk-ws-01-xxxxx"
    }
  }
}
```

> 若省略 `WINDSURF_API_KEY`，服务器会自动从本地 Windsurf 安装中发现并提取。

## 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `WINDSURF_API_KEY` | *(自动发现)* | Windsurf API Key |
| `FC_MAX_TURNS` | `3` | 每次查询的搜索轮数（越多越深入，但越慢） |
| `FC_MAX_COMMANDS` | `8` | 每轮最大并行命令数 |
| `FC_TIMEOUT_MS` | `30000` | 流式请求连接超时（毫秒） |
| `FC_RESULT_MAX_LINES` | `50` | 每条命令输出的最大行数（截断） |
| `FC_LINE_MAX_CHARS` | `250` | 每行输出的最大字符数（截断） |
| `WS_MODEL` | `MODEL_SWE_1_6_FAST` | Windsurf 模型名称 |
| `WS_APP_VER` | `1.48.2` | Windsurf 应用版本（协议元数据） |
| `WS_LS_VER` | `1.9544.35` | Windsurf 语言服务器版本（协议元数据） |

## 可用模型

通过设置 `WS_MODEL` 环境变量切换模型（详见上方环境变量表）。

![可用模型](docs/models.png)

默认：`MODEL_SWE_1_6_FAST` — 速度最快，grep 关键词最丰富，定位粒度最细。

## MCP 工具

### `fast_context_search`

带可调参数的 AI 语义代码搜索。

| 参数 | 类型 | 必填 | 默认值 | 说明 |
|------|------|------|--------|------|
| `query` | string | 是 | — | 自然语言搜索查询 |
| `project_path` | string | **是** | — | 项目根目录的绝对路径 |
| `tree_depth` | integer | 否 | `3` | 仓库目录树深度（1-6）。越深上下文越丰富，但 payload 越大。超过 250KB 会自动降级。超大 monorepo（>5000 文件）用 1-2，普通项目用 3，小项目用 4-6。 |
| `max_turns` | integer | 否 | `3` | 搜索轮数（1-5）。越多越深入，但越慢。简单查找用 1-2，一般查询用 3，复杂分析用 4-5。 |
| `max_results` | integer | 否 | `10` | 最多返回的文件数（1-30）。越小越聚焦，越大覆盖越广。 |

返回：
1. **相关文件**及行号范围
2. **建议搜索关键词**（AI 搜索过程中使用的 rg pattern）
3. **诊断元数据**（`[config]` 行，包含 project_path、实际使用的 tree_depth、tree 大小及是否触发降级）

输出示例：
```
找到 3 个相关文件。

  [1/3] /project/src/auth/handler.py (L10-60, L120-180)
  [2/3] /project/src/middleware/jwt.py (L1-40)
  [3/3] /project/src/models/user.py (L20-80)

grep keywords: authenticate, jwt.*verify, session.*token

[config] project_path=/project, tree_depth=3, tree_size=12.5KB, max_turns=3
```

错误输出包含针对性提示：
```
Error: Request failed: HTTP 403

[hint] 403 Forbidden: Authentication failed. The API key may be expired or revoked.
Try re-extracting with extract_windsurf_key, or set a fresh WINDSURF_API_KEY env var.
```

```
Error: Request failed: HTTP 413

[diagnostic] tree_depth_used=3, tree_size=280.0KB (auto fell back from requested depth)
[hint] If the error is payload-related, try a lower tree_depth value.
```

### `extract_windsurf_key`

从本地 Windsurf 安装中提取 API Key。无需参数。

## 项目结构

```
fast-context-mcp/
├── package.json
├── src/
│   ├── server.mjs        # MCP 服务器入口
│   ├── core.mjs          # 认证、消息构建、流式传输、搜索循环
│   ├── executor.mjs      # 工具执行器：rg、readfile、tree、ls、glob
│   ├── extract-key.mjs   # Windsurf API Key 提取（SQLite）
│   └── protobuf.mjs      # Protobuf 编解码 + Connect-RPC 帧
├── README.md
├── README_CN.md
└── LICENSE
```

## 搜索流程详解

1. 项目目录映射为虚拟路径 `/codebase`
2. 按指定深度（默认 3）生成目录树，若超过 250KB 自动降级到更低深度
3. 查询 + 目录树通过 Connect-RPC/Protobuf 发送至 Windsurf Devstral 模型
4. Devstral 生成工具命令（ripgrep、文件读取、tree、ls、glob）
5. 命令在本地并行执行（每轮最多 `FC_MAX_COMMANDS` 条）
6. 结果返回给 Devstral，进入下一轮
7. 经过 `max_turns` 轮后，Devstral 返回文件路径 + 行号范围
8. 搜索过程中所有 rg pattern 汇总为建议关键词
9. 附加诊断元数据，帮助调用方 AI 调整参数

## 技术细节

- **协议**：Connect-RPC over HTTP/1.1，Protobuf 编码，gzip 压缩
- **模型**：Devstral（`MODEL_SWE_1_6_FAST`，可配置）
- **本地工具**：`rg`（via @vscode/ripgrep）、`readfile`（Node.js fs）、`tree`（tree-node-cli）、`ls`（Node.js fs）、`glob`（Node.js fs）
- **认证**：API Key → JWT（每次会话自动获取）
- **运行时**：Node.js >= 18（ESM）

### 依赖

| 包 | 用途 |
|----|------|
| `@modelcontextprotocol/sdk` | MCP 服务器框架 |
| `@vscode/ripgrep` | 内置跨平台 ripgrep |
| `tree-node-cli` | 跨平台目录树（替代系统 `tree`） |
| `sql.js` | 读取 Windsurf 本地 SQLite 数据库 |
| `zod` | Schema 校验（MCP SDK 依赖） |

## License

MIT
