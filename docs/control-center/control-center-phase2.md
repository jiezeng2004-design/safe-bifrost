# PatchWarden Control Center Phase 2

> v0.6.3 在 v0.6.2 MVP 基础上增强任务、工作区、Direct session 和日志体验。
> 不重构架构，不合并 Core/Direct MCP，不改现有 MCP 工具注册逻辑。
> 不发布 npm，不打 git tag。

## 概述

Phase 2 完全在 Control Center HTTP 层增强，未触动 MCP 工具注册、watcher 核心循环或
Direct session 写入逻辑。新增的 API 全部沿用既有 token 校验、路径围栏和脱敏机制。

- **Stale Task 管理**：4 条规则识别僵死任务，reconcile 只标注不删除
- **task-detail 增强**：变更文件、验证摘要、警告/错误、stale 横幅 + 4 个动作按钮
- **工作区按需 git 状态**：仅在用户点击时对单个 repo 执行 `git status --short`
- **Direct Sessions 页面**：浏览 `.patchwarden/direct-sessions` 下的会话产物
- **Logs 页面**：core/direct/watcher/control-center 四类日志，支持 tail 100/300/1000

## 启动方式

启动方式与 MVP 完全一致，无新增入口：

```powershell
.\PatchWarden-Control.cmd
# 或
npm.cmd run build
npm.cmd run start:control
```

启动后访问 `http://127.0.0.1:8090`，左侧导航新增「Direct 会话」和「日志」两项。

## 改动文件

| 文件 | 改动 |
| --- | --- |
| `src/version.ts` | `PATCHWARDEN_VERSION` 0.6.2 → 0.6.3 |
| `package.json` | `version` 0.6.2 → 0.6.3 |
| `src/controlCenter.ts` | 新增 stale/reconcile/task-detail 增强/workspace repo status/direct sessions/logs 分类等 API |
| `ui/pages/dashboard.html` | 侧边栏新增 Direct 会话 + 日志导航 |
| `ui/pages/tasks.html` | 侧边栏新增 Direct 会话 + 日志导航 |
| `ui/pages/task-detail.html` | 新增变更文件卡、验证摘要卡、警告/错误卡、stale 横幅、Refresh/Copy task_id/Open folder/Run audit/Reconcile 按钮 |
| `ui/pages/workspace.html` | 每个 repo 新增「检查」按钮，按需调用 `/api/workspace/:repo/status`，渲染 git 状态面板 |
| `ui/pages/audit.html` | 侧边栏新增 Direct 会话 + 日志导航 |
| `ui/pages/direct-sessions.html` | 新页面：会话列表 + 会话详情（summary.md / audit.md / audit.json / diff.patch / changed-files.json） |
| `ui/pages/logs.html` | 新页面：分类选择 + tail 选择 + 自动刷新开关 |
| `scripts/checks/control-center-smoke.js` | 新增 Test 11–15 覆盖 Phase 2 API |
| `docs/control-center/control-center-phase2.md` | 本文档 |

## 新增 API

### GET 接口（免 token）

| 路径 | 说明 |
| --- | --- |
| `GET /api/tasks/stale` | 返回当前判定为 stale 的任务列表（含 stale_reasons） |
| `GET /api/tasks/:taskId` | 增强详情：新增 `changed_files`、`file_stats`、`verification_summary`、`warnings`、`errors`、`stale`、`reconcile`、`task_dir`、`independent_review`、`verify_log` |
| `GET /api/workspace/:repo/status` | 对单个 repo 执行 `git status --short`，返回 changed_files_count/untracked_count/modified_count/is_clean/short_status |
| `GET /api/direct-sessions` | 列出 `.patchwarden/direct-sessions` 下所有会话摘要 |
| `GET /api/direct-sessions/:sessionId` | 返回会话详情：summary/session/summary_md/diff_patch/audit_json/audit_md/changed_files |
| `GET /api/logs/:category?tail=<100\|300\|1000>` | 四类日志（core/direct/watcher/control-center），支持 tail 行数 |

### POST 接口（必须校验 token）

| 路径 | 说明 |
| --- | --- |
| `POST /api/tasks/:taskId/reconcile` | 标注 stale/archived，写入 `reconcile.json`，不删除任务 |
| `POST /api/tasks/:taskId/audit` | 仅当任务处于终态时委托 `auditTask` 运行独立审计 |
| `POST /api/tasks/:taskId/open-folder` | 通过系统命令打开任务目录 |

## Stale Task 判定规则

`classifyStaleTask` 仅对 `pending` / `running` 状态任务判定（终态任务直接返回非 stale）。
判定使用 `config.watcherStaleSeconds` 作为阈值，4 条规则任一命中即标记 stale：

| 规则 | 字段值 | 说明 |
| --- | --- | --- |
| `heartbeat_stale` | status=running 且 last_heartbeat_at 超过阈值 | 运行中但心跳长时间未更新 |
| `collecting_artifacts_stale` | phase=collecting_artifacts 且心跳超过阈值 | 卡在产物收集阶段 |
| `running_no_command_watcher_healthy` | status=running 且 current_command 为空且 watcher healthy | 运行中无命令但 watcher 在工作，疑似僵死 |
| `heartbeat_far_behind_watcher` | 任务心跳比 watcher 心跳早 2× 阈值以上且 watcher healthy | 任务明显落后于 watcher |

`/api/status` 和 `/api/tasks` 返回的任务对象均带 `is_stale: boolean` 和
`stale_reasons: string[]`。`/api/status.tasks` 还聚合了 `stale` 计数和
`stale_task_ids` 列表。

## Reconcile 行为

`POST /api/tasks/:taskId/reconcile` 的安全契约：

- **不删除任务**，不修改 `status` 枚举值
- 读取 `status.json` / `runtime.json` 重建 `TaskEntry`，重新调用 `classifyStaleTask`
- 决策（`decision` 字段）：
  - `marked_archived`：任务已处于终态 → 标注归档
  - `marked_stale`：stale 且 watcher 未在驱动（无 current_command 或 watcher 非 healthy）→ 标注僵死
  - `no_action`：不满足上述条件 → 仅记录，不标注
- 写入 `tasks/<taskId>/reconcile.json`（完整决策记录）
- 仅当 `safe=true` 时，在 `status.json` 追加 `reconcile_state`（`"stale"` 或 `"archived"`）和 `reconciled_at`，**原 status 字段保持不变**
- 返回 reconcile 记录 JSON

## 路径围栏（workspace repo status）

`GET /api/workspace/:repo/status` 的安全约束：

- `repo` 参数经 `decodeURIComponent` 后若包含 `..` 或 `\0` → 直接 400
- 通过 `guardWorkspacePath(repo, workspaceRoot)` 解析为绝对路径，任何逃逸 `workspaceRoot` 的路径 → 400
- 仅对解析后的目录执行 `git status --short`，超时 8 秒，maxBuffer 1MB
- 非 git 仓库或 git 不可用时返回 200 + `is_git_repo: false` + error 字段，不返回 500
- smoke test 用 `encodeURIComponent("../secret")` 验证穿越被拒（400）

## Direct Sessions 数据来源

- 会话目录：`getDirectSessionsDir(config)` → `<runtime>/.patchwarden/direct-sessions/`
- 每个会话子目录读取：`session.json`、`summary.json`、`audit.json`、`summary.md`、`diff.patch`、`audit.md`、`changed-files.json`
- `DirectSessionSummary` 字段：`session_id`、`repo_path`、`resolved_repo_path`、`created_at`、`expires_at`、`finalized`、`finalized_at`、`audited`、`changed_files_total`、`verification_summary`、`audit_decision`、`audit_checked_at`、`title`
- 目录不存在时返回 `{ sessions: [], total: 0, reason: null }`，**不返回 500**
- 会话按 `created_at` 降序排列

## 日志脱敏

- 所有 `/api/logs/:category` 响应均经 `redactSensitiveContent` 脱敏
- tail 行数限制在 `ALLOWED_LOG_TAILS = {100, 300, 1000}`，非法值回退到 100
- 日志文件缺失时返回 `{ stdout: "", stderr: "", reason: "log file not found" }`

## 冒烟测试

`scripts/checks/control-center-smoke.js` 在原 10 项基础上新增 5 项（共 16 项）：

| # | 测试 |
| --- | --- |
| 11 | `GET /api/tasks/stale` 返回有效 JSON（`stale_tasks` 数组、`total` 数字、`stale_threshold_seconds` 数字） |
| 12 | `GET /api/workspace/<traversal>/status` 被拒绝（400，error 含 "traversal"） |
| 13 | `POST /api/tasks/:taskId/reconcile` 无 token → 403 |
| 14 | `GET /api/direct-sessions` 目录缺失时返回空列表（200，非 500） |
| 15 | `GET /api/logs/core?tail=300` 响应包含 `tail: 300` |

## 测试结果

```
npm.cmd run build         # tsc 编译通过
node scripts/checks/control-center-smoke.js
  # Summary: 16 passed, 0 failed
```

全量 `npm test` 链路（security 139 + unit 136 + lifecycle 22 + control-center 16）
全部通过，0 失败。

> 注：在 TRAE IDE 沙盒内运行 `npm test` 时，control-center-smoke spawn 的子进程退出
> 后 Windows 会尝试更新 jump list 临时文件，被沙盒拒绝并打印
> "TRAE Sandbox Error: hit restricted …CustomDestinations…"。该错误与测试逻辑无关，
> 所有测试用例均报告 PASS。直接运行 `node scripts/checks/control-center-smoke.js` 退出码为 0。

## 已知限制

- `/api/workspace/:repo/status` 仅运行 `git status --short`，不返回 diff 或 stash 信息
- reconcile 不会清理任务文件，需人工后续处理或由 watcher 在下个周期自然覆盖
- `/api/tasks/:taskId/audit` 仅在任务处于终态（done/failed/failed_verification/
  failed_scope_violation/failed_policy_violation/canceled/timeout）时才执行，否则返回 409
- Direct Sessions 页面只读，不提供 finalize 或 audit 触发入口（这些操作仍需通过 MCP 工具完成）
- Logs 页面的自动刷新间隔固定为 5 秒，不读取 watcher 实时事件
- task-detail 的「Open task folder」按钮通过 `explorer.exe` / `open` / `xdg-open` 打开，需要本地图形环境
