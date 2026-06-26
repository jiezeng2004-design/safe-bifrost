# PatchWarden Control Center MVP

> 本地 Web 控制中心，统一管理 PatchWarden Core 与 PatchWarden Direct 两个 MCP profile。
> 不合并工具，不发布到 npm，不打 git tag。

## 概述

Control Center 是一个绑定 `127.0.0.1:8090` 的本地 HTTP 服务，提供静态 UI 页面和一组容错 JSON API。
所有进程生命周期操作（start/stop/restart）均委托 `scripts/control/manage-patchwarden.ps1` 执行，
Control Center 自身不直接 kill 进程，也不读取任意 PID 文件。

- **Core profile**: `chatgpt_core`，17 个工具，HTTP 端口 8080
- **Direct profile**: `chatgpt_direct`，10 个工具，HTTP 端口 8081

## 新增文件

| 文件 | 说明 |
| --- | --- |
| `src/controlCenter.ts` | Control Center HTTP 服务主程序（TypeScript 源） |
| `scripts/checks/control-center-smoke.js` | 测试模式冒烟测试（ESM，仅用 Node 内置模块） |
| `scripts/control/start-control-center.ps1` | PowerShell 启动脚本（含构建检查、端口轮询、浏览器自动打开；支持 `-NoBrowser`） |
| `PatchWarden-Control.cmd` | 根目录 CMD 入口，调用上述 PowerShell 脚本 |
| `ui/pages/dashboard.html` | 总控首页（真实状态，7 个工具栏按钮，两张服务卡） |
| `ui/pages/tasks.html` | 任务列表页（接 `/api/tasks`） |
| `ui/pages/task-detail.html` | 任务详情页（接 `/api/tasks/:taskId`） |
| `ui/pages/workspace.html` | 工作区页（接轻量 `/api/workspace`） |
| `ui/pages/audit.html` | 审计历史页（接 `/api/audit`） |
| `ui/partials/project-shell.html` | 页面外壳（CDN 引用已替换为本地 `/vendor/`） |
| `ui/colors_and_type.css` | 颜色与字体样式 |
| `ui/vendor/tailwindcss-browser.js` | Tailwind v4.3.1 browser build（本地副本，离线可用） |
| `ui/vendor/lucide.js` | Lucide v1.8.0 UMD（本地副本，离线可用） |
| `docs/control-center/control-center-mvp.md` | 本文档 |

## 改动文件

| 文件 | 改动 |
| --- | --- |
| `package.json` | 新增 `start:control` 脚本（`node dist/controlCenter.js`）；`files` 数组新增 `ui/`；`test` 脚本末尾追加 `&& node scripts/checks/control-center-smoke.js` |
| `.gitignore` | 新增 `/CODE_WIKI.md`、`/PatchWarden-UI.zip`、`/patchwarden-v0.6.1-SHA256SUMS.txt`（避免 brand-check 误报） |

## 启动方式

### 方式一：CMD 入口（推荐用户使用）

```powershell
.\PatchWarden-Control.cmd
```

### 方式二：PowerShell 脚本

```powershell
# 正常启动（构建检查 + 打开浏览器）
powershell -ExecutionPolicy Bypass -File scripts\control\start-control-center.ps1

# 测试模式（不打开浏览器）
powershell -ExecutionPolicy Bypass -File scripts\control\start-control-center.ps1 -NoBrowser
```

### 方式三：npm 脚本（需先 `npm run build`）

```powershell
npm.cmd run build
npm.cmd run start:control
```

启动后自动打开 `http://127.0.0.1:8090`。

端口可通过环境变量覆盖（仅用于测试）：

```powershell
$env:PATCHWARDEN_CONTROL_PORT=18090; node dist/controlCenter.js
```

## 控制 Token 校验

- 服务启动时通过 `crypto.randomUUID()` 生成 token，**仅保存在内存中**，不写入任何文件。
- 前端通过 `GET /control-token.json` 从内存获取 token，响应头 `Cache-Control: no-store`。
- **所有 POST 接口**（含 `/api/start-all`、`/api/stop-all`、`/api/restart-all`、`/api/core/*`、`/api/direct/*`、`/api/open-logs-folder`）必须携带 `X-PatchWarden-Control-Token` 请求头。
- token 缺失或错误时返回 `403`，不执行任何进程控制或本地系统动作。
- GET 接口（status、tasks、logs 等）不需要 token。
- `git status --porcelain` 不会出现 `ui/control-token.json`。

## API 清单

### GET 接口（免 token）

| 路径 | 说明 |
| --- | --- |
| `GET /` | 返回 `ui/pages/dashboard.html` |
| `GET /control-token.json` | 从内存返回控制 token，`Cache-Control: no-store` |
| `GET /colors_and_type.css` | 静态 CSS |
| `GET /pages/*` | 静态 HTML 页面 |
| `GET /partials/*` | 静态 HTML 片段 |
| `GET /vendor/*` | 本地化的 Tailwind / Lucide |
| `GET /api/status` | 聚合状态（容错，永不 500） |
| `GET /api/tasks` | 任务列表（复用 `listTasks`） |
| `GET /api/tasks/:taskId` | 任务详情（status/runtime/result/audit/diff_patch/test_log） |
| `GET /api/logs/core` | Core runtime 日志尾部 100 行（脱敏） |
| `GET /api/logs/direct` | Direct runtime 日志尾部 100 行（脱敏） |
| `GET /api/logs/watcher` | Watcher 日志尾部 100 行（脱敏） |
| `GET /api/workspace` | 轻量工作区信息（workspace_root、directories、agents、config 摘要；**不做 git 扫描**） |
| `GET /api/audit` | 审计历史（扫描 tasks 目录下含 audit.json 的任务，最多 50 条） |
| `GET /api/tunnel-ui-url` | 读取 Core/Direct 的 tunnel-health-url.txt |

### POST 接口（必须校验 token）

| 路径 | 委托命令 | 说明 |
| --- | --- | --- |
| `POST /api/start-all` | `manage-patchwarden.ps1 start all` | 启动全部 |
| `POST /api/stop-all` | `manage-patchwarden.ps1 stop all` | 停止全部 |
| `POST /api/restart-all` | `manage-patchwarden.ps1 restart all` | 重启全部 |
| `POST /api/core/start` | `manage-patchwarden.ps1 start core` | 启动 Core |
| `POST /api/core/stop` | `manage-patchwarden.ps1 stop core` | 停止 Core |
| `POST /api/direct/start` | `manage-patchwarden.ps1 start direct` | 启动 Direct |
| `POST /api/direct/stop` | `manage-patchwarden.ps1 stop direct` | 停止 Direct |
| `POST /api/open-logs-folder` | 系统命令打开 runtime 目录 | 打开日志文件夹 |

### `/api/status` 返回结构（容错）

```json
{
  "core": { "available": false, "reason": "...", "healthz": null, "readyz": null },
  "direct": { "available": false, "reason": "...", "healthz": null, "readyz": null },
  "watcher": { "status": "missing|healthy|stale|unreadable", "available": false, "reason": "..." },
  "tunnel": { "core": { "observed": false }, "direct": { "observed": false } },
  "tools": {
    "core": { "tool_profile": null, "tool_count": null, "schema_epoch": null, "tool_manifest_sha256": null, "tool_names": null },
    "direct": { "tool_profile": null, "tool_count": null, "schema_epoch": null, "tool_manifest_sha256": null, "tool_names": null }
  },
  "agents": [],
  "workspace_root": "string | null",
  "tasks": { "tasks": [], "total": 0, "active": 0, "stale": 0, "reason": null }
}
```

容错保证：
- core/direct health 探测失败 → `{ available: false, reason: "..." }`，接口仍 200
- runtime 文件（tunnel-status.json、tool-manifest.json）缺失 → 返回 null 或 `{ observed: false }`，接口仍 200
- 日志文件缺失 → `{ stdout: "", stderr: "", reason: "..." }`，接口仍 200
- tasks 目录缺失 → `{ tasks: [], total: 0, reason: "..." }`，接口仍 200
- Core/Direct 未启动时 `/api/status` 仍返回 200 JSON，不报 500

## 进程安全

- Control Center **不直接 kill 进程**，所有 start/stop/restart 均委托 `scripts/control/manage-patchwarden.ps1`。
- `manage-patchwarden.ps1` 的 `Test-TunnelProcessForMode` 在 stop/restart 前校验进程命令行属于 `tunnel-client.exe --profile` 模式，仅停止匹配的进程。
- **不根据任意 PID 文件 kill 进程**。
- Control Center 仅在自身服务关闭时退出自己启动的 HTTP server。

## CDN 本地化

- 所有 HTML 无 `https://cdn` 或 `https://unpkg` 引用。
- `ui/vendor/tailwindcss-browser.js`（Tailwind v4.3.1）和 `ui/vendor/lucide.js`（Lucide v1.8.0）为本地副本。
- 断网后页面样式和图标正常渲染。

## 冒烟测试（测试模式）

`scripts/checks/control-center-smoke.js` 严格遵循测试模式：

- 不打开浏览器
- 不真正 start/stop Core 或 Direct
- 不 kill 任何进程（仅关闭自己 spawn 的 controlCenter 子进程）
- 使用测试端口 `18090`（通过 `PATCHWARDEN_CONTROL_PORT`），避免 8090 冲突
- 测试结束关闭 server，释放端口

测试覆盖（10 项）：

1. 静态文件服务（`/`、`/vendor/*`、`/colors_and_type.css` 返回 200 + 正确 Content-Type）
2. `/api/status` 返回有效 JSON 且容错（core/direct 未启动时仍 200）
3. `/api/tasks` 返回有效 JSON
4. `/control-token.json` 返回 token + `Cache-Control: no-store`
5. POST `/api/start-all` 不带 token → 403
6. POST `/api/start-all` 带错误 token → 403
7. POST `/api/open-logs-folder` 不带 token → 403
8. token 不污染 Git（`git status --porcelain` 不含 `ui/control-token.json`）
9. 无 CDN 引用（HTML 文件无 `https://cdn` / `https://unpkg`）
10. 其他 GET API 可达（`/api/workspace`、`/api/audit`、`/api/logs/core`、`/api/tunnel-ui-url`）

## 测试结果

`npm test` 全量通过（`FINAL_EXIT_CODE: 0`）：

| 测试链 | 结果 |
| --- | --- |
| smoke-test | OK |
| unit-tests | 139 total（136 pass，0 fail，1 skipped） |
| lifecycle-smoke | 22 passed, 0 failed |
| doctor-smoke | OK |
| tunnel-supervisor-smoke | OK |
| watcher-supervisor-smoke | OK |
| control-smoke | OK |
| mcp-manifest-check | 17 tools, chatgpt_core profile |
| brand-check | OK: 144 tracked files checked |
| control-center-smoke | 10 passed, 0 failed |

未发布 npm、未打 git tag、未上传 npm。

## 已知限制

1. **`/api/workspace` 轻量版**：第一版只返回 workspace_root、项目列表（一级子目录）、agents、config 摘要。不做 git 扫描，不返回 repo clean 状态。workspace.html 中 "Repo Clean 状态" 显示为"按需接口待实现"占位。
2. **task-detail / workspace / audit 为基础接入**：能加载数据并渲染，但未实现全部高级功能（如 diff 高亮、审计证据深度展示）。diff/test-log 仅做文本预览。
3. **进程控制仅支持 Windows**：`manage-patchwarden.ps1` 为 PowerShell 脚本，POST 控制接口在非 Windows 环境下不可用。`/api/open-logs-folder` 在 macOS/Linux 下会尝试 `open`/`xdg-open`。
4. **Health 探测端口固定**：Core 探测 `127.0.0.1:8080`，Direct 探测 `127.0.0.1:8081`，暂不支持配置覆盖。
5. **Control token 生命周期**：token 在服务进程内存中，服务重启后 token 会变化（前端通过 `/control-token.json` 重新获取）。
6. **日志读取**：仅返回各日志文件尾部 100 行，并对敏感内容脱敏（复用 `redactSensitiveContent`）。
