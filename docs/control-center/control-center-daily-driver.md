# PatchWarden Control Center Daily Driver

> v0.6.4 在 v0.6.2 MVP 与 v0.6.3 Phase 2 基础上，把 Control Center 从「启动页面脚本」
> 升级为日常入口：单实例启动、后台运行、托盘入口、健康修复建议、页面通知和活动时间线。
> 不重构架构，不合并 Core/Direct MCP，不改现有 MCP 工具注册逻辑。
> 不发布 npm，不打 git tag。

## 概述

Daily Driver 完全在 Control Center HTTP 层与启动脚本层增强，未触动 MCP 工具注册、
watcher 核心循环或 Direct session 写入逻辑。新增的 API 沿用既有 token 校验、路径围栏
和脱敏机制；托盘与后台模式仅调用现有 Control Center API，不引入新的进程管理路径。

- **单实例启动**：status 文件 + 端口探测，重复运行只开浏览器，不启第二个服务
- **后台运行**：`-Background`（默认）/ `-Foreground` / `-NoBrowser`，日志写入
  `%LOCALAPPDATA%\patchwarden\control-center\control-center.{stdout,stderr}.log`
- **托盘入口**：基于 .NET NotifyIcon 的轻量 PowerShell 托盘，无需 Electron
- **健康修复建议**：`/api/status` 新增 `suggestions` 字段，dashboard 显示建议卡片
- **页面通知**：dashboard 轮询状态变化时弹出 toast，同一事件只提示一次
- **Activity Timeline**：`runtime/control-center-events.jsonl` 记录关键事件，
  `GET /api/events` 返回最近事件，dashboard 显示时间线区块

## 启动方式

### 1. 日常入口（推荐）

```powershell
.\PatchWarden-Control.cmd
```

默认后台启动 Control Center 并打开浏览器。再次运行时：

- 如果 127.0.0.1:8090 已经是当前 Control Center —— 直接打开浏览器页面，不重复启动
- 如果端口被其他程序占用 —— 给出明确错误提示并退出
- 如果 status 文件指向已死的 PID —— 清理孤儿进程后启动新实例

### 2. 启动参数

```powershell
.\PatchWarden-Control.cmd -NoBrowser       # 启动但不打开浏览器
.\PatchWarden-Control.cmd -Foreground      # 前台运行，日志直接输出到控制台
.\PatchWarden-Control.cmd -Background      # 后台运行（默认），脚本启动后即退出
```

`-Foreground` 与 `-Background` 互斥；都不传时默认 `-Background`。

### 3. 托盘入口

```powershell
.\PatchWarden-Control-Tray.cmd
```

启动 Windows 系统托盘图标（基于 .NET NotifyIcon，无需额外依赖）。如果 Control Center
未运行，托盘脚本会先在后台启动它。托盘菜单：

| 菜单项 | 行为 |
| --- | --- |
| Open Control Center | 在默认浏览器打开 dashboard |
| Start All | `POST /api/start-all`（带 token） |
| Stop All | `POST /api/stop-all`（带 token） |
| Restart All | `POST /api/restart-all`（带 token） |
| Open Workspace | 通过 `GET /api/workspace` 获取 workspaceRoot 后用 explorer 打开 |
| Open Logs Folder | `POST /api/open-logs-folder`（带 token） |
| Exit | 关闭托盘（不停止 Control Center 后台进程） |

双击托盘图标打开 dashboard。所有 API 调用通过 `/control-token.json` 获取 token 后
带 `X-PatchWarden-Control-Token` 头发起请求。

## 改动文件

| 文件 | 改动 |
| --- | --- |
| `src/version.ts` | `PATCHWARDEN_VERSION` 0.6.3 → 0.6.4 |
| `package.json` | `version` 0.6.3 → 0.6.4 |
| `src/controlCenter.ts` | 新增 status 文件、events JSONL、suggestions 引擎、`/api/events`、`/api/control-center-status`；`getControlCenterLogDir` 支持 `PATCHWARDEN_CONTROL_LOG_DIR` 覆盖 |
| `scripts/control/start-control-center.ps1` | 重写：单实例检测、`-NoBrowser`/`-Foreground`/`-Background`、孤儿清理、端口冲突检测 |
| `scripts/control/control-center-tray.ps1` | 新文件：.NET NotifyIcon 托盘，菜单驱动 Control Center API |
| `PatchWarden-Control-Tray.cmd` | 新文件：托盘启动入口 |
| `ui/pages/dashboard.html` | 新增 Health Suggestions 卡片、toast 通知、Activity Timeline 区块 |
| `scripts/checks/control-center-smoke.js` | 新增 Test 16–20 覆盖 Daily Driver API；`PATCHWARDEN_CONTROL_LOG_DIR` 重定向到项目内临时目录 |
| `scripts/release/pack-clean.js` | forbidden 列表新增 `.tmp/` |
| `.gitignore` | 新增 `.tmp/` |
| `docs/control-center/control-center-daily-driver.md` | 本文档 |

## 新增 API

### GET 接口（免 token）

| 路径 | 说明 |
| --- | --- |
| `GET /api/events?limit=<N>` | 返回最近 N 条活动事件（最大 1000），结构 `{events, total, limit}` |
| `GET /api/control-center-status` | 读取 status 文件，返回 `{running, pid, port, started_at, url, version}` 或 `{running: false}` |

### /api/status 增强字段

`GET /api/status` 响应新增 `suggestions` 数组，每条建议包含：

```json
{
  "code": "core_stopped",
  "severity": "warning",
  "message": "Core 未运行，建议启动 Core profile",
  "action": "/api/core/start",
  "link": null
}
```

| code | severity | 触发条件 | action |
| --- | --- | --- | --- |
| `core_stopped` | warning | Core 探测不可用 | `/api/core/start` |
| `direct_stopped` | warning | Direct 探测不可用 | `/api/direct/start` |
| `watcher_stale` | error | watcher 状态为 stale/unreadable | `/api/restart-all` |
| `stale_task` | warning | 存在 stale 任务 | 无 action，`link` 指向 tasks 页面 |
| `tunnel_not_ready` | warning | Core 或 Direct tunnel 未就绪 | `/api/restart-all` |
| `agent_missing` | info | 配置的 agent 不可用 | 无 action，提示检查路径 |

## 活动事件

事件写入 `%LOCALAPPDATA%\patchwarden\control-center\control-center-events.jsonl`，
每行一个 JSON 对象 `{timestamp, type, payload?}`。文件超过 512KB 时惰性裁剪到
2000 行。

### 事件类型

| type | 触发时机 |
| --- | --- |
| `control_center.started` | 服务 listen 成功 |
| `control_center.stopped` | 服务收到 SIGTERM/SIGINT 关闭 |
| `manage.start.all` / `manage.stop.all` / `manage.restart.all` | 用户请求 start/stop/restart all |
| `manage.<mode>.<action>.failed` | manage-patchwarden.ps1 执行失败 |
| `core.status_changed` | Core 可用性发生变化（diff 自上次 /api/status 轮询） |
| `direct.status_changed` | Direct 可用性发生变化 |
| `watcher.status_changed` | watcher 状态发生变化 |
| `task.status_changed` | 任务状态从 running → done/failed 等 |
| `task.reconciled` | 用户对 stale 任务执行 reconcile |
| `task.audited` | 用户对任务执行 audit |

> Control Center 是无状态、拉取驱动的服务。`core/direct/watcher/task.status_changed`
> 事件在 `/api/status` 轮询时通过 digest diff 检测，因此事件时间戳反映的是「被观察到」
> 的时间，不保证是状态变化的精确时刻。

## 页面通知（toast）

dashboard.html 轮询 `/api/status`（30s）和 `/api/audit`（90s）时检测以下状态变化并
弹出 toast 通知：

- core/direct: available → unavailable（error）/ unavailable → available（success）
- watcher: healthy → stale/unreadable（error）/ stale → healthy（success）
- task: running → done（success）/ running → failed*（error）
- audit: 新出现的 pass（success）/ warn（warning）/ fail（error）

同一事件通过 dedup key 只提示一次；toast 8 秒后自动消失，也可手动关闭。首次加载时
audit 列表会 seed 到 `seenAuditKeys`，不会对已有审计记录弹通知。

## 运行时文件

| 文件 | 路径 | 说明 |
| --- | --- | --- |
| status 文件 | `%LOCALAPPDATA%\patchwarden\control-center\control-center-status.json` | pid/port/started_at/url/version，服务启动时写入，关闭时删除 |
| events 文件 | `%LOCALAPPDATA%\patchwarden\control-center\control-center-events.jsonl` | 活动事件 JSONL |
| stdout 日志 | `%LOCALAPPDATA%\patchwarden\control-center\control-center.stdout.log` | 后台模式 stdout |
| stderr 日志 | `%LOCALAPPDATA%\patchwarden\control-center\control-center.stderr.log` | 后台模式 stderr |

> `PATCHWARDEN_CONTROL_LOG_DIR` 环境变量可覆盖上述目录（必须为绝对路径），
> 主要用于 smoke test 将其重定向到项目内临时目录。

## 测试

```powershell
npm.cmd test
```

### control-center-smoke.js（21 项）

| # | 测试 | 覆盖 |
| --- | --- | --- |
| 1–1b | 静态文件 + 页面路由 | 基础服务 |
| 2 | `/api/status` JSON + 容错 | 结构校验 |
| 3–4 | tasks JSON + control-token | token 机制 |
| 5–7 | POST 无 token / 错 token → 403 | 安全门 |
| 8–9 | token 不污染 git + 无 CDN | 发布卫生 |
| 10 | 其他 GET API 可达 | workspace/audit/logs/tunnel |
| 11–15 | Phase 2 API | stale/reconcile/workspace/direct-sessions/logs |
| **16** | `/api/status` 包含 `suggestions` 数组 | Daily Driver |
| **17** | `/api/events` 返回 JSON | Daily Driver |
| **18** | `/api/logs/control-center` 返回 JSON | Daily Driver |
| **19** | POST `/api/restart-all` 无 token → 403 | Daily Driver |
| **20** | `/api/control-center-status` 报告 running 实例 | Daily Driver（单实例检测） |

### 全量测试结果

```
security tests:    139 passed, 0 failed
unit tests:        136 passed, 0 failed (1 skipped: Windows symlink)
lifecycle tests:    22 passed, 0 failed
control-center:     21 passed, 0 failed
```

## 已知限制

1. **托盘为 PowerShell 实现**：基于 .NET NotifyIcon，不提供跨平台支持；在非 Windows
   环境下不可用。如需跨平台托盘，需引入 Electron 或类似框架（本阶段刻意避免）。
2. **事件时间为观测时间**：Control Center 无状态，`status_changed` 事件在轮询时通过
   diff 检测，时间戳是「被观察到」的时间，不保证是状态变化的精确时刻。
3. **status 文件依赖可写目录**：如果 `%LOCALAPPDATA%` 不可写（如沙箱环境），
   status 文件不会生成，单实例检测会退化为端口探测模式。可通过
   `PATCHWARDEN_CONTROL_LOG_DIR` 覆盖到可写目录。
4. **toast 为页面内通知**：不要求系统级通知；仅当 dashboard 页面打开时才会弹出。
5. **托盘 Exit 不停止后台进程**：Exit 仅关闭托盘，Control Center 后台 node 进程继续
   运行。需通过 Stop All 或 `Stop-Process -Id <pid>` 停止。
6. **事件文件不轮转**：超过 512KB 时惰性裁剪到 2000 行，不按日期轮转。
