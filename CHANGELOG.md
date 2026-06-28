# PatchWarden CHANGELOG

## v1.1.0 (2026-06-27)

### Theme: Safe Summaries and Low-Noise Audits

v1.1 adds safe summary tools for Core and Direct profiles so ChatGPT can inspect task or session state without receiving full logs, full diffs, stdout/stderr tails, or long markdown. The legacy result/audit/finalize tools remain compatible.

### New Tools

- Core/full: `safe_result`, `safe_audit`, `safe_test_summary`, `safe_diff_summary`
- Direct/full: `safe_direct_summary`, `safe_finalize_direct_session`, `safe_audit_direct_session`

### Audit and Cleanup

- `unrecorded_command_execution` now expands package scripts and local verifier scripts to classify transitive quality gates as `transitive_verified_command` instead of warning.
- High-risk publication, push, upload, and broad delete commands remain fail-level findings.
- `runTask` now writes `post-task-cleanup.json` and removes only clearly low-risk untracked or ignored artifacts after verification, skipping tracked files and protected directories.

### Tool Count

- full profile: 47 -> 54
- `chatgpt_core` profile: 17 -> 21
- `chatgpt_direct` profile: 10 -> 13
- `chatgpt_search` profile: 5 unchanged
## v1.0.0 (2026-06-27)

### Theme: Release-Grade PatchWarden

v1.0.0 引入发布前五阶段校验（Release Gate）、subgoal 级 Worktree 隔离、以及多 Agent
自动路由。Release Gate 用 `node:https` 只读查询 npm registry / GitHub Release / CI 状态，
不暴露通用远程 shell；Worktree 隔离为每个 subgoal task 创建独立 git worktree，避免并发
任务互相污染；多 Agent 路由根据 goal/scope 关键词推荐最合适的本地 agent，`create_task`
的 `agent` 字段从必填改为推荐（未指定时自动路由并记录原因）。

### Release Gate（Part A）

新增 `src/release/releaseGate.ts`，提供五阶段发布前校验：

```text
local_ready → packed_ready → published_verified → github_release_verified → ci_verified
```

- `checkLocalReady`：运行 `npm build` + `npm test` + `npm run doctor:ci`
- `checkPackedReady`：`npm pack --dry-run --json` + forbidden/required 文件校验 + 生成
  `release-artifact-manifest.json`
- `checkPublishedVerified`：`node:https` GET `registry.npmjs.org/<package>`，校验版本存在
- `checkGitHubReleaseVerified`：`node:https` GET GitHub releases/tags API，支持
  `GITHUB_TOKEN` Bearer auth（token 不入日志，最多记 `token_digest: "sha256:..."`）
- `checkCiVerified`：`node:https` GET GitHub actions/runs API，校验最新 run success
- `runReleaseGateCheck`：聚合函数，target_stage 前任一阶段 failed 则后续为 `not_checked`

网络错误返回 `not_checked`（不是 `failed`），不误阻断。函数名统一使用 `Verified`。

新增 MCP 工具 `check_release_gate`（full profile，risk: release，requiresConfirmation: true）。
Doctor 集成 Release Gate 模块加载自检项（仅校验模块完整性，不执行 local_ready 避免递归）。

### Worktree 隔离（Part B）

新增 `src/goal/worktreeManager.ts`，为每个 subgoal task 提供独立 git worktree：

- `createWorktree(goalId, subgoalId, workspaceRoot)`：在 `_workspacetrees/<worktreeId>/`
  创建 git worktree，原子写 `worktree_status.json`（status="active"）
- `mergeWorktree(worktreeId, workspaceRoot)`：`git merge <branch>` 合并回主工作区，
  状态更新为 `merged`
- `discardWorktree(worktreeId, workspaceRoot)`：`git worktree remove --force` +
  `git branch -D` + 归档到 `.patchwarden/worktree-archive/`

安全约束：所有路径经 `guardWorkspacePath` + `guardSensitivePath`；git 命令通过
`execFileSync` 受控调用，白名单仅 `git worktree add/remove/prune` + `git merge/branch`；
失败时清理半成品目录与临时 branch。branch 名格式 `pw-<goal>-<subgoal>`（用 `-` 分隔，
避免 Windows git worktree 对含 `/` 分支名的兼容性问题）。

`create_subgoal_task` 新增 `isolate_worktree?: boolean`（默认 true），true 时在隔离
worktree 执行，false 时退化为 v0.8.0 行为（主工作区执行）。

新增 MCP 工具 `merge_worktree` / `discard_worktree`（full profile，risk: workspace_write，
requiresConfirmation: true）。

### 多 Agent 路由（Part C）

新增 `src/agents/agentRouter.ts`，根据 goal/scope 关键词推荐最合适的本地 agent：

| 触发条件 | 推荐 Agent |
|---|---|
| scope 文件数 > 10 | opencode |
| scope 文件数 == 1 | patchwarden-direct |
| goal/plan 含"审计/audit/验收" | patchwarden-audit |
| goal/plan 含"重构/refactor/跨模块" | codex |
| goal/plan 含"文档/readme/changelog" | claude（fallback opencode） |
| 无匹配 | configuredAgents[0]（fallback: true） |

推荐结果必须在 `configuredAgents` 白名单中。`reason` 字段说明触发条件，决策可解释。

`create_task` 的 `agent` 字段从必填改为推荐：未指定时调用 `routeAgent` 自动路由，
结果写入 `status.json` 的 `agent_selection_reason` 字段；显式指定时不路由。白名单校验
保留（推荐 agent 也必须在 `config.agents` 中）。

### Tool Count

- full profile：44 → 47（新增 `check_release_gate` / `merge_worktree` / `discard_worktree`）
- `chatgpt_core` profile 17 工具不变，manifest hash 不变
- `chatgpt_direct` profile 10 工具不变
- `chatgpt_search` profile 5 工具不变

### Tests

- 新增 `src/test/unit/release-gate.test.ts`：覆盖五阶段 passed/failed/not_checked、
  阻断逻辑、token 不入日志、网络错误处理、函数名拼写
- 新增 `src/test/unit/worktree-manager.test.ts`：覆盖 create/merge/discard、路径逃逸拦截、
  敏感路径拦截、失败清理、原子写+备份
- 新增 `src/test/unit/agent-router.test.ts`：覆盖 6 条路由规则、白名单约束、fallback、
  可解释 reason

### Backward Compatibility

- `create_subgoal_task(isolate_worktree=false)` 退化为 v0.8.0 行为
- `create_task` 显式指定 agent 时不路由，行为与 v0.9.0 一致
- `chatgpt_core` / `chatgpt_direct` / `chatgpt_search` profile 工具清单与 manifest hash 不变
- 未引入第三方 npm 依赖
- 未暴露通用远程 shell（Release Gate 远程查询仅用 `node:https` GET）

## v0.9.0 (2026-06-27)

### Theme: 检索质量增强

v0.9.0 增强 SafeToolSearch 的检索质量，引入历史成功率反馈、混合排序公式、查询意图分类
和 schema drift 检测。v0.7.1 的纯规则打分升级为五维加权混合排序，让搜索结果更准、更
可解释。同时修复 v0.7.1 遗留的 registry 元数据 drift（4 个工具错误标记了 chatgpt_core
profile）。

### 历史成功率反馈（toolUsageStats）

- 新增 `src/tools/toolUsageStats.ts`：从 v0.8.1 的 invocation.log 聚合每个工具的
  `ToolUsageStats`（totalCalls / successRate / avgDurationMs / lastUsedAt）
- `discover_tools` 在搜索时传入 `usageStatsProvider`，用 successRate 计算历史得分
- 历史数据缺失时（新工具或无日志）按中性处理（history_score=0），不惩罚不加分

### 混合排序公式（hybrid scoring）

v0.7.1 的单一总分升级为五维加权公式（roadmap 8.2）：

```text
final_score = rule_score * 0.45 + tag_score * 0.25 + profile_match * 0.15
            + history_score * 0.10 + risk_bonus_or_penalty * 0.05
```

- `rule_score`：name(+10) + title(+8) + summary(+4) + description(+2)
- `tag_score`：tags(+6) + aliases(+6)
- `profile_match`：工具属于请求 profile 时为 1，否则为 0
- `history_score`：successRate * 5，范围 [0, 5]
- `risk_bonus_or_penalty`：readonly(+1) / workspace_read_sensitive(+0.5) /
  workspace_write(0) / command(-0.5) / release(-1) / credential_sensitive(-1)

安全约束：高风险工具不能因历史成功率高而绕过风险过滤（riskCeiling/includeHighRisk
过滤在打分前执行）。无 usageStatsProvider 时退化为规则打分+风险微调，向后兼容 v0.7.1。

### 查询意图分类（intent classification）

新增 `classifyQueryIntent`，将 query 分类为 `read`/`write`/`verify`/`release`/
`diagnose`/`unknown`（roadmap 8.3）：

| 意图 | 触发词 | 优先风险等级 |
|---|---|---|
| `read` | read, 查看, 读取, 看看 | readonly / workspace_read_sensitive |
| `write` | fix, patch, 修改, 修复 | workspace_write |
| `verify` | test, check, 验收, 检查 | readonly / workspace_read_sensitive |
| `release` | release, publish, deploy, 发布 | release（需 includeHighRisk） |
| `diagnose` | 卡住, running, stale, 旧任务 | readonly / workspace_read_sensitive |

`DiscoverToolsOutput` 新增 `intent` 字段。同分工具按意图优先风险等级微调排序（+0.01
微加分，仅打破平局）。release 意图不绕过风险过滤。

### schema drift 检测（doctor 集成）

新增 `src/tools/schemaDriftCheck.ts`，检测三类漂移：

1. registry 中声明的 `inputSchemaDigest` 与实际 ToolDef inputSchema digest 是否一致
2. `chatgpt_core` profile 17 工具是否全部存在（集合比较）
3. registry 中标记 `chatgpt_core` profile 的工具数是否仍为 17

集成到 `src/doctor.ts` 作为自检项，drift 为 warn 级别（不阻断 doctor:ci）。不做运行时
阻断：schema drift 只在 doctor 阶段报告，discover_tools/explain_tool 运行时正常工作。

### Registry 元数据 drift 修复

修复 v0.7.1 遗留的 registry 元数据问题：4 个工具（`get_plan`、`get_task_progress`、
`kill_task`、`retry_task`）在 `toolRegistry.ts` 的 `STATIC_TOOL_META` 中错误标记了
`chatgpt_core` profile，但实际不在 `CHATGPT_CORE_TOOL_NAMES` 中。已移除错误的
`chatgpt_core` 标记，使 registry 元数据与实际 profile 一致。

### Tool Count

- 无新增 MCP 工具，full profile 保持 44 工具不变
- `chatgpt_core` profile 17 工具不变，manifest hash 不变
- `chatgpt_direct` profile 10 工具不变
- `chatgpt_search` profile 5 工具不变

### Tests

- 新增 `src/test/unit/tool-usage-stats.test.ts`：12 个测试覆盖空日志、正常聚合、
  损坏行跳过、successRate/avgDurationMs 计算
- 新增 `src/test/unit/schema-drift-check.test.ts`：9 个测试覆盖三类漂移的 pass/warn
- 扩展 `src/test/unit/toolSearch.test.ts`：新增 13 个测试覆盖混合排序公式、意图分类、
  history_score 计算、风险微调、向后兼容

### Backward Compatibility

- 无 usageStatsProvider 时退化为规则打分+风险微调，与 v0.7.1 结果基本一致
- 现有 `INTENT_TERMS` 中文意图映射不变（保留兼容）
- `chatgpt_core` / `chatgpt_direct` / `chatgpt_search` profile 工具清单不变
- 未引入第三方 npm 依赖

## v0.8.1 (2026-06-26)

### Theme: Compact Profile + 受控动态调用

v0.8.1 引入 `chatgpt_search` compact profile（5 工具）和 `invoke_discovered_tool` 受控动态调用链。模型只面对 5 个核心工具，通过 discover → explain → invoke 三步受控链路调用其他工具。`invoke_discovered_tool` 是潜在高风险入口，用 server-side `discoveryToken` store + `toolInvocationGuard`（10 项校验）+ invocation log 三重防护，确保动态调用不可绕过安全守卫。同时补齐 v0.8.0 遗漏的 9 个 goal 工具在 toolRegistry.ts 中的元数据注册。

### New MCP Tool (1 tool, full + chatgpt_search profile)

| 工具 | 作用 |
|---|---|
| `invoke_discovered_tool` | 凭 discoveryToken 受控调用已发现的工具，10 项安全校验 |

### chatgpt_search Profile (5 tools, compact)

```text
health_check → discover_tools → explain_tool → invoke_discovered_tool → safe_status
```

模型只面对这 5 个工具，通过搜索发现其他工具，再通过受控链路调用。不支持 degraded mode。

### discoveryToken Store (server-side)

- `discover_tools` 为每个结果生成 `dst_{YYYYMMDD}_{randomHex12}` 格式 token
- server-side 内存 Map 保存 token 真实信息（toolName/risk/scope/query/schemaDigest/profile）
- 默认 10 分钟过期，单次使用（consume 后删除）
- 客户端只看到 token id，不看到 server-side 保存的完整信息

### toolInvocationGuard (10 项调用前强制校验)

```text
①token 存在且未过期（consumeToken）
②toolName 与 token 记录一致
③profile 允许调用该工具
④风险等级不超 token.risk
⑤workspace_read_sensitive 调用 sensitiveGuard
⑥workspace_write 要求 assessmentId
⑦command 只允许白名单命令（元字符预检）
⑧release 要求 assessmentId（二次确认）
⑨credential_sensitive 默认拒绝
⑩写 invocation log
```

### invocation log

每次 `invoke_discovered_tool` 调用写入 `.patchwarden/logs/invocation.log`，记录 timestamp/toolName/discoveryToken/risk/profile/arguments_digest（sha256，不记原文）/result/error_code/duration_ms。

### v0.8.0 补齐：goal 工具 toolRegistry 元数据

v0.8.0 新增的 9 个 goal 工具（create_goal/list_goals/read_goal/create_subgoal_task/accept_subgoal/reject_subgoal/suggest_next_subgoal/summarize_goal_progress/export_handoff）此前未注册到 `toolRegistry.ts` 的 `STATIC_TOOL_META`，导致 `discover_tools`/`explain_tool` 无法发现它们。v0.8.1 补齐这 9 个工具的元数据。

### Security Boundary

- `chatgpt_core` profile 17 工具不变，manifest hash 不变
- `chatgpt_direct` profile 10 工具不变
- full profile 工具数从 43 更新为 44
- 不引入第三方 npm 依赖
- 不暴露通用远程 shell
- `credential_sensitive` 风险工具默认拒绝调用
- 所有动态调用可审计（invocation log）、可追踪（discoveryToken）、不可绕过守卫

## v0.8.0 (2026-06-26)

### Theme: Goal Session — 大目标统筹与跨会话交接

v0.8.0 引入 Goal Session：把一个版本目标结构化为 `.patchwarden/goals/{goal_id}/`
下的 GOAL.md + GOALS.md + goal_status.json + 子任务关联，提供 9 个 MCP 工具让 agent
能创建目标、管理子目标依赖、验收子目标、推荐下一步、导出交接文档。v0.8.0 依赖 v0.7.2
的 `done_by_agent`/`accepted` 状态机，是 v0.8.1 Compact Profile 和 v1.0 Release Gate
的前置条件。

### New Goal Session Directory Structure

```text
.patchwarden/goals/
  goal_{YYYYMMDD}_{slug}/
    GOAL.md              # 人类可读目标说明
    GOALS.md             # 子目标依赖图（人类可读）
    goal_status.json     # 结构化子目标状态
    handoff.md           # 交接文档（export_handoff 生成）
    tasks/               # 子目标关联任务目录
    artifacts/           # Goal 级 artifact
```

### New MCP Tools (9 tools, full profile only)

| 工具 | 作用 |
|---|---|
| `create_goal` | 创建 Goal Session，生成 goal_id 和目录结构 |
| `list_goals` | 列出所有 Goal Session 及完成度摘要 |
| `read_goal` | 读取 Goal 详情、GOAL.md 内容、子目标状态 |
| `create_subgoal_task` | 在 Goal 下创建子目标并关联一个新任务 |
| `accept_subgoal` | 验收子目标（要求关联任务为 accepted 状态） |
| `reject_subgoal` | 拒绝子目标，记录原因 |
| `suggest_next_subgoal` | 基于依赖图推荐下一个 ready 子目标 |
| `summarize_goal_progress` | 汇总完成度、阻塞点、风险 |
| `export_handoff` | 导出 handoff.md 交接文档 |

### Subgoal State Machine

```text
ready → running → done_by_agent → accepted
                              ├─ rejected
                              └─ needs_fix → running
```

- `ready`：子目标已创建，等待执行（依赖须全部 accepted）
- `running`：关联任务已创建并运行中
- `done_by_agent`：关联任务完成（任务 status 变为 done_by_agent 时自动回写）
- `accepted`：所有关联任务经 audit_task 验收通过，手动调用 accept_subgoal
- `rejected`：子目标被拒绝（可从任何非终态拒绝）
- `needs_fix`：保留状态，对应任务的 needs_fix

### goal_status.json Structure

```json
{
  "goal_id": "goal_20260626_v080",
  "title": "v0.8.0 Goal Session",
  "status": "active",
  "repo_path": "/path/to/repo",
  "created_at": "2026-06-26T10:00:00.000Z",
  "updated_at": "2026-06-26T10:00:00.000Z",
  "subgoals": [
    {
      "id": "subgoal-001",
      "title": "实现 goalStore",
      "status": "accepted",
      "depends_on": [],
      "task_ids": ["task_001"],
      "accepted_at": "2026-06-26T11:00:00.000Z"
    }
  ]
}
```

### Task-Subgoal Integration

- `CreateTaskInput` 新增可选字段 `goal_id` / `subgoal_id`
- 任务 status.json 新增 `goal_id` / `subgoal_id` 字段
- 任务状态变为 `done_by_agent` 时（reconcileTasks safe_fix 路径）自动回写 subgoal 状态
- subgoal 同步失败不阻断任务完成（错误隔离，仅记 stderr）
- 无 goal_id/subgoal_id 的任务不受影响（向后兼容）

### New src/goal/ Modules

- `goalStore.ts` — Goal Session 目录 CRUD、goal_id 生成、GOAL.md 读写、原子写
- `goalStatus.ts` — 子目标状态机、addSubgoal、updateSubgoalStatus、linkTaskToSubgoal
- `goalGraph.ts` — 依赖图、getReadySubgoals、getBlockedSubgoals、suggestNextSubgoal、detectCycle、topologicalSort
- `handoffExport.ts` — 交接文档生成（11 章节 Markdown）
- `goalProgress.ts` — acceptSubgoal、rejectSubgoal、summarizeGoalProgress
- `subgoalSync.ts` — 任务完成时同步 subgoal 状态

### New src/tools/ Modules

- `goalSubgoalTask.ts` — createSubgoalTask 高层函数（原子 addSubgoal → create_task → link → running）

### Profile Changes

- **full profile**：34 → 43 工具（新增 9 个 goal 工具）
- **chatgpt_core profile**：17 工具不变，manifest hash 不变
- **chatgpt_direct profile**：10 工具不变

### Tests

- 新增 `goal-store.test.ts`（22 个）、`goal-status.test.ts`（25 个）、`goal-graph.test.ts`（27 个）、
  `handoff-export.test.ts`（21 个）、`goal-progress.test.ts`（22 个）、`subgoal-sync.test.ts`（17 个）、
  `goal-subgoal-task.test.ts`（3 个）、`goal-tools-registry.test.ts`（16 个）
- 共新增 153 个单元测试

### Backward Compatibility

- 无 goal_id/subgoal_id 的任务完全不受影响
- chatgpt_core / chatgpt_direct profile 工具清单不变
- 未引入第三方 npm 依赖
- 未新增敏感路径访问，所有 Goal 目录经 guardWorkspacePath 校验

## v0.7.2 (2026-06-26)

### Theme: 验收状态与 audit_task 升级

v0.7.2 引入完整的验收工作流。单任务闭环从 `create_task → running → done_by_agent →
audit_task → accepted / needs_fix / rejected / blocked` 打通。agent 自报完成不再等于
验收通过；验收结论必须由 acceptanceEngine 基于证据推导。

### New Task Status

- `done_by_agent`：v0.7.0 类型层已定义，v0.7.2 正式激活 — runTask 成功路径从 `"done"`
  改为 `"done_by_agent"`，并写入 `acceptance_status: "pending"`。
- `accepted`：audit_task 确认所有检查通过。
- `rejected`：audit_task 发现 fail 级检查项。
- `needs_fix`：audit_task 发现 warn 级检查项，需修复后重新验收。
- `blocked`：audit_task 发现发布声明但无法验证远端状态。

### AcceptanceEngine

- 新增 `src/goal/acceptanceEngine.ts`：核心验收引擎。
- 4 级 verdict：`ACCEPTED` / `NEEDS_FIX` / `REJECTED` / `BLOCKED_BY_APPROVAL`。
- 决策规则：fail → REJECTED；release claims → BLOCKED；warn → NEEDS_FIX；全通过 → ACCEPTED。
- 输出包含 `reasons`（可追溯的 `[FAIL]/[WARN]/[BLOCKED]` 前缀）、`required_evidence`、
  `next_suggested_task`。
- 新增 `src/goal/acceptanceTemplate.ts`：渲染 ACCEPTANCE.md 人类可读验收报告。

### audit_task 升级为验收器

- 集成 acceptanceEngine：输出新增 `acceptance` 字段（verdict、status、reason、reasons、
  required_evidence、next_suggested_task、fail_checks、warn_checks）。
- 回写 status.json：对 `done_by_agent` 任务，将 `acceptance_status` 从 `"pending"`
  推进到 `accepted`/`rejected`/`needs_fix`/`blocked`。
- 导出 ACCEPTANCE.md：人类可读的验收报告，包含 verdict、证据摘要、验收标准、
  fail/warn 检查项、reasons、required_evidence。
- task_status 检查同时识别 `done` 和 `done_by_agent` 为 pass。

### 结构化验收标准

- `create_task` 新增可选字段：`goal`、`scope`、`forbidden`、`verification`、`done_evidence`。
- 这些字段写入 status.json，audit_task 读取后传递给 acceptanceEngine 作为验收依据。
- ACCEPTANCE.md 导出时展示这些验收标准。

### 展示层增强

- `safe_status`：透传实际 acceptance_status 值（不再硬编码为 "pending"）。
- `list_tasks`：TaskEntry 新增 `acceptance_status` 字段；ListTasksInput 新增
  `acceptance_status` 过滤参数（例如 `acceptance_status=pending` 可筛选等待验收的
  `done_by_agent` 任务）。`active_only` 仍只返回 `pending`/`running` 任务。

### done_by_agent 全链路激活

`done_by_agent` 在 v0.7.0 类型层定义但从未写入，v0.7.2 正式激活后需同步更新所有
终态判断逻辑：

- `waitForTask`：`TERMINAL_STATUSES` 新增 `done_by_agent`，避免无限轮询。
- `getTaskSummary`：`TERMINAL_STATUSES` 新增 `done_by_agent`；acceptance_status
  计算同时识别 `done` 和 `done_by_agent` 为成功完成。
- `controlCenter`：`TERMINAL_TASK_STATUSES` 新增 `done_by_agent`。
- `cancelTask`：终态检查新增 `done_by_agent`，防止取消已完成的任务。
- lifecycle-smoke / mcp-smoke：断言更新为同时接受 `done` 和 `done_by_agent`。

### Tool Count

- 无新增 MCP 工具。full profile 保持 34 工具。
- `chatgpt_core` profile 保持 17 工具不变，manifest hash 不变。
- `chatgpt_direct` profile 保持 10 工具不变。

### Tests

- 新增 `src/test/unit/acceptance-engine.test.ts`：25 个测试覆盖 6 种验收场景
  （ACCEPTED/REJECTED/NEEDS_FIX/BLOCKED + 优先级 + 多 fail）、verdictToStatus 映射、
  next_suggested_task、reasons 可追溯性、renderAcceptanceMarkdown 渲染。

### Audit Checks 补齐（roadmap 5.2 新增检查项）

v0.7.2 首发只实现了 release_claims_unverified 检查项。本次补齐 roadmap 5.2 节要求的
其余 6 项 audit 检查项，使 acceptanceEngine 能基于完整证据推导验收结论：

- **`forbidden_scope_violation`**（fail 级）：比对 changed-files 与任务的 `forbidden`
  数组，支持 glob 通配符（`**` 匹配任意层级，`*` 匹配单层）。命中 forbidden 路径时
  触发 REJECTED。
- **`done_evidence_missing`**（warn 级）：校验 `done_evidence` 中声明的证据文件是否
  存在于任务目录，缺失时触发 NEEDS_FIX。无 `done_evidence` 声明时跳过。
- **`readme_changelog_sync`**（warn 级）：当变更涉及代码文件（.ts/.js/.py/.go 等）时，
  检查 README.md / CHANGELOG.md 是否在 changed-files 中。代码变更但文档未同步时触发
  NEEDS_FIX。
- **`package_manifest_consistency`**（warn 级）：若 package.json 被修改，校验 name/version
  字段存在且格式合法。解析失败时触发 NEEDS_FIX。
- **`sensitive_path_access`**（fail 级）：扫描 changed-files 是否命中 sensitiveGuard 的
  敏感路径规则（.env、id_rsa、credentials、*.pem、*.key 等）。命中时触发 REJECTED。
  复用 `isSensitivePath`，不重复定义敏感路径规则。
- **`unrecorded_command_execution`**（warn 级）：从 test.log / result.md 提取命令行
  （npm run / npm / node / npx），与 verify_commands / test_command 白名单比对。
  发现未记录命令时触发 NEEDS_FIX。

每项检查在无对应数据源时跳过（不输出 pass/warn/fail），避免误判。所有检查结果通过
`checks` 数组进入 acceptanceEngine 的 evidence，按 fail→REJECTED、warn→NEEDS_FIX、
release claims→BLOCKED、全通过→ACCEPTED 的规则推导四级验收结论。

### Tests（audit checks 补齐）

- 新增 `src/test/unit/audit-checks.test.ts`：49 个测试覆盖 6 项检查的 pass/warn/fail/skip
  场景，包括 glob 匹配、existsSync 校验、代码扩展名检测、package.json 解析、敏感路径
  匹配、命令提取与白名单比对。

### Backward Compatibility

- `done` 状态仍被识别（legacy 兼容）。
- 缺少 `acceptance_status` 字段的旧任务默认 `"pending"`。
- 未引入第三方 npm 依赖。
- 未新增 MCP 工具，chatgpt_core manifest hash 完全不变。
- 新增检查项在无对应数据源时跳过，不影响旧任务的验收结论。

## v0.7.1 (2026-06-26)

### Theme: SafeToolSearch 只读发现层

v0.7.1 引入统一工具注册表和只读发现层。工具数量增长后，模型面临上下文浪费、
选错工具、安全边界模糊等问题。本次更新通过 `discover_tools` 和 `explain_tool`
两个只读工具，让模型先搜索再调用，而不是面对全部工具清单。

### New Tools

- **`discover_tools`**: 自然语言搜索候选工具，返回压缩摘要（name、title、summary、
  risk、schema_digest、why）。支持中英文查询和意图映射（验收/改文件/发布/状态/
  差异/卡住/旧任务/搜索/工具/诊断等）。按 profile/mode/riskCeiling 过滤，
  高风险工具（command/release/credential_sensitive）默认隐藏，通过 `hidden_results`
  分组返回。仅添加到 `full` profile，不加入 `chatgpt_core`。
- **`explain_tool`**: 展开单个工具详情，包含 title、summary、description、risk、
  risk_rank、profiles、modes、tags、aliases、requires_confirmation、schema_digest、
  related_tools，可选包含完整 inputSchema（`includeSchema=true`）。支持通过别名查找。
  仅添加到 `full` profile，不加入 `chatgpt_core`。

### Unified Tool Registry

- 新增 `src/tools/toolRegistry.ts`：统一工具注册表，为每个工具补全元数据
  （risk、profiles、modes、tags、aliases、requiresConfirmation、relatedTools）。
- 六级风险分级：`readonly`(0) / `workspace_read_sensitive`(1) /
  `workspace_write`(2) / `command`(3) / `release`(4) / `credential_sensitive`(5)。
- `computeSchemaDigest`：使用稳定字段顺序 canonical JSON → sha256 计算 schema
  digest，用于检测 schema 漂移、release check 校验、discover_tools 返回。
- 中文意图映射 `INTENT_TERMS`：21 个中文意图词映射到英文工具关键词。

### Search Engine

- 新增 `src/tools/toolSearch.ts`：搜索引擎实现。
- 打分权重：name(+10) > title(+8) > tag/alias(+6) > summary(+4) > description(+2)。
- 搜索流程：tokenize → 中文意图展开 → profile/mode 过滤 → riskCeiling/includeHighRisk
  过滤 → 加权打分 → topK 排序 → hidden_results 分组统计。

### Tool Count

- full profile 工具数：32 → 34（新增 `discover_tools` 和 `explain_tool`）。
- `chatgpt_core` profile 保持 17 个工具不变，顺序不变，manifest hash 不变。
- `chatgpt_direct` profile 保持 10 个工具不变。

### Tests

- 新增 `src/test/unit/toolSearch.test.ts`：34 个测试覆盖中文意图搜索、英文搜索、
  riskCeiling 过滤、hidden_results、maxResults、profile 过滤、explainTool、
  schema_digest 稳定性、buildToolRegistry 完整性。

### Backward Compatibility

- 所有现有工具的 name / description / inputSchema / 顺序完全不变。
- `chatgpt_core` 和 `chatgpt_direct` profile 工具清单不变。
- 未引入第三方 npm 依赖。

## v0.7.0 (2026-06-26)

### Theme: 旧 running 任务收敛/诊断（状态可信化地基）

v0.7.0 引入任务状态可信化的基础设施。当 Watcher 重启、PID 被操作系统复用、或
Artifact 收集卡住时，旧的 running 任务会停留在不真实的状态。本次更新通过多信号
诊断和安全的自动收敛来解决这个问题，同时绝不触碰仍由活跃 Watcher 拥有的任务。

### New Tools

- **`diagnose_task`**: 多信号诊断工具，结合心跳年龄、日志新鲜度、子进程 PID 存活
  状态、Watcher 所有权和 Artifact 存在性，返回保守的诊断结果
  （`active_running` / `stale_running` / `possibly_stale_running` / `orphaned_running` /
  `artifact_collection_stuck` / `done_candidate` / `unknown` / `terminal`）及置信度。
  从不依赖单一信号；PID 存活但其他信号全部过时时拒绝判定为 active（PID 复用保护）。
  只读工具，不修改任务状态。仅添加到 `full` profile。
- **`reconcile_tasks`**: 任务收敛工具，支持 `report_only`（默认，只读）和
  `safe_fix` 两种模式。`safe_fix` 仅对高置信度诊断应用状态转换
  （`failed_stale` / `orphaned` / `done_by_agent`），写入前备份
  `status.json.bak`，使用 tmp + rename 原子写入，并追加 `reconcile.log` 审计日志。
  硬性规则：绝不触碰仍由活跃 Watcher 拥有的任务。仅添加到 `full` profile。

### Task Status Extensions

- 新增 `done_by_agent` 状态：Agent 自报完成或收敛工具标记完成，`acceptance_status`
  默认为 `pending`，`legacy_status` 回显 `done` 以保持向后兼容。
- 新增 `failed_stale` 状态：进程已死/心跳过期。
- 新增 `orphaned` 状态：Watcher 不再拥有该任务。
- `AcceptanceStatus` 类型：`"pending" | null`（v0.7.2 将扩展为已接受/已拒绝）。

### safe_status Enhancement

- 新增 `legacy_status` 字段：`done_by_agent` 时回显 `"done"`。
- 新增 `acceptance_status` 字段：`done_by_agent` 时为 `"pending"`。
- 新增 `stale_seconds` 字段：距离上次心跳的秒数。
- 新增 `diagnosis` 字段：非终态任务的轻量级诊断快照 `{type, confidence}`，
  诊断失败时为 `null`（不阻塞 safe_status）。

### Watcher Ownership & PID Reuse Protection

- `runTask` 在任务启动时记录 `task_started_at` 和 `watcher_instance_id`（来自
  `PATCHWARDEN_WATCHER_INSTANCE_ID` 环境变量），spawn 后记录 `child_pid` 和
  `child_started_at`。
- `watcherStatus.ts` 新增 `readWatcherInstanceId` 和 `isWatcherOwningTask` 函数，
  通过比较任务 runtime 中的 `watcher_instance_id` 与当前活跃 Watcher 心跳中的
  `instance_id` 来确定所有权。返回 `{owned, reason, ...}`，reason ∈
  `{"owned", "no_runtime_record", "watcher_missing", "instance_mismatch",
  "watcher_unhealthy"}`。
- PID 复用启发式：当 PID 存活但心跳和日志全部过时时，标记为
  `possibly_stale_running`（中置信度），拒绝判定为 `active_running`。

### Conservative Thresholds

- 心跳过时阈值：300 秒（5 分钟）
- 心跳可能过时阈值：120 秒（2 分钟）
- 日志过时阈值：300 秒（5 分钟）
- 默认收敛年龄：30 分钟

### safe_fix Safety Contract

1. 仅当 `mode === "safe_fix"` 且 `confidence === "high"` 时应用。
2. 绝不触碰仍由活跃 Watcher 拥有的任务。
3. 写入前创建 `status.json.bak` 备份。
4. 使用 `status.json.tmp` + `renameSync` 原子写入。
5. 追加 `reconcile.log`（位于 `.patchwarden/` 根目录）。
6. 新状态记录包含完整审计字段：`previous_status`、
   `diagnosis.{type, confidence, applied_by, applied_at, reasons, evidence}`。
7. `done_by_agent` 额外设置 `acceptance_status="pending"` 和 `legacy_status="done"`。

### Tests

- 新增 `src/test/unit/diagnose-task.test.ts`：16 个测试覆盖全部 7 种诊断类型、
  PID 复用保护、终态诊断、include_logs 脱敏、错误处理。
- 新增 `src/test/unit/reconcile-tasks.test.ts`：13 个测试覆盖 report_only 不修改
  状态、safe_fix 仅处理高置信度、backup/原子写入/reconcile.log、跳过活跃 Watcher
  拥有的任务、done_by_agent 设置、orphaned 标记、年龄过滤、空目录等。

### Tool Count

- Full profile: 32 tools (was 30)
- `chatgpt_core` profile: 17 tools (unchanged — new tools are full-profile only)
- `chatgpt_direct` profile: 10 tools (unchanged)

### Backward Compatibility

- `chatgpt_core` 工具清单和顺序完全不变（manifest hash 不变）。
- `done_by_agent` 通过 `legacy_status="done"` 保持旧客户端兼容。
- 新增字段均为可选，不影响现有 API 消费者。

## v0.6.4 (2026-06-26)

### Desktop Experience

- Added `PatchWarden-Desktop.cmd` as the daily desktop entry. It starts the tray and ensures Control Center is available without opening extra browser windows.
- Updated `PatchWarden-Control-Tray.cmd` so normal launches hide the PowerShell host, while `--foreground` remains available for debugging.
- Refined the WinForms tray layer with a PatchWarden-styled shield icon, single-instance protection, clearer startup/status balloons, and quick actions for Open Dashboard, Start All, Stop All, Restart All, Open Logs, and Quit Tray.

### Control Center Lifecycle

- Control Center lifecycle actions now call the Windows manager with `-Background` and `windowsHide: true`, so Start All and Restart All launch Core/Direct supervisors without long-lived visible terminal windows.
- Added `-NoTunnelWebUi` to the tunnel launcher and use it from desktop/background flows so tunnel-client does not open extra browser windows unless a user explicitly opens the dashboard.
- Clarified Stop All versus Quit Tray: Stop All stops Core/Direct while keeping tray/dashboard available; `Stop-PatchWarden.cmd` is the one-click shutdown for Core/Direct, Control Center, and tray.

### Verification

- Extended control and Control Center smoke coverage for the new desktop entry, tray contract, background lifecycle, and package manifest.
- Added the desktop entry to npm/package and release archive verification.

## v0.6.1 (2026-06-25)

### Stability & Correctness

- **Watcher stale fix**: `readWatcherStatus` now falls back to checking running task heartbeats when the watcher heartbeat is stale or missing. Long-running tasks no longer cause false "stale watcher" alerts.
- **Chinese path fix**: Verified all `readFileSync`/`writeFileSync` calls use UTF-8 encoding. Added `path_encoding` self-check to `health_check` tool.

### New Tools

- **`safe_status`**: Minimal task lifecycle status tool that returns task state without exposing diff, log content, or file contents. Added to `chatgpt_core` profile.
- **`sync_file`**: Copy a file from source to target within a Direct session repo. Supports sha256 verification. Added to `chatgpt_direct` profile.

### Security

- Added comprehensive unit test suite for all security guards using Node's built-in `node:test`:
  - `path-guard.test.ts`: path traversal, symlink escape, Windows separators, drive letter boundaries
  - `sensitive-guard.test.ts`: case insensitivity, null bytes, Unicode lookalikes, `.patchwarden` safe prefix
  - `command-guard.test.ts`: allowlist enforcement, whitespace handling, prompt sanitization
  - `direct-guards.test.ts`: workspace containment, blocked directories, binary file detection

### Observability

- **Structured logging**: New `src/logging.ts` module with JSON-formatted logs to stderr. Tool call audit logs with duration tracking. Global unhandled error handlers.
- **Tool call audit**: All tool invocations now logged with tool name, success/failure, duration, and optional task ID.

### Change Capture Enhancements

- **External dirty file baseline**: `extractExternalDirtyFiles` and `findNewExternalDirtyFiles` functions to distinguish pre-existing dirty files from new out-of-scope changes.
- **Artifact manifest**: `buildArtifactManifest` function generates `artifact_manifest.json` with sha256, size, and type classification for release artifacts.
- **Changed file grouping**: `groupChangedFiles` classifies changes into source, docs, config, test, release artifacts, and runtime-generated categories.

### Android Build Diagnostics

- New `src/tools/androidDoctor.ts` module that diagnoses Android build environment (Java, SDK, Gradle, APK output) when `android_app` directory exists.

### Tool Count

- Full profile: 30 tools (was 28)
- `chatgpt_core` profile: 17 tools (was 16)
- `chatgpt_direct` profile: 10 tools (was 9)

### Documentation

- Added `docs/performance-notes.md` with future optimization roadmap
- Added `docs/release-v0.6.1.md` release notes

## v0.6.0

- Direct session editing profile
- `apply_patch` tool with sha256 verification
- `run_verification` tool
- `finalize_direct_session` and `audit_session` tools
- Tool profile system (`full`, `chatgpt_core`, `chatgpt_direct`)
