/**
 * v0.8.0: Goal Session 依赖图 — 就绪/阻塞判定、下一子目标建议、环检测、拓扑排序。
 *
 * 所有函数均为纯函数，不修改传入的 goalStatus 对象。
 * 依赖语义：subgoal.depends_on 引用其他 subgoal 的 id，被引用者 status 必须为
 * "accepted" 才算依赖满足。引用不存在的 id 视为数据不一致，按阻塞处理。
 */

import type { GoalStatus, Subgoal } from "./goalStatus.js";
import { PatchWardenError } from "../errors.js";

// ── 内部工具 ──────────────────────────────────────────────────────

/**
 * 构建 subgoal_id → Subgoal 的查找表。
 */
function buildSubgoalMap(goalStatus: GoalStatus): Map<string, Subgoal> {
  const map = new Map<string, Subgoal>();
  for (const s of goalStatus.subgoals) {
    map.set(s.id, s);
  }
  return map;
}

/**
 * 判断单个 subgoal 的依赖是否全部满足（所有 depends_on 引用存在且 status 为 accepted）。
 * depends_on 为空视为依赖满足。引用不存在的 id 视为未满足。
 */
function areDependenciesMet(subgoal: Subgoal, subgoalMap: Map<string, Subgoal>): boolean {
  for (const depId of subgoal.depends_on) {
    const dep = subgoalMap.get(depId);
    if (!dep) return false;
    if (dep.status !== "accepted") return false;
  }
  return true;
}

// ── 公共 API ──────────────────────────────────────────────────────

/**
 * 返回所有 status 为 "ready" 且依赖全部满足的子目标。
 * 依赖满足 = depends_on 中所有 id 都存在且对应 subgoal status 为 "accepted"。
 * depends_on 为空数组视为依赖满足。
 * depends_on 引用不存在的 subgoal 时，该子目标不算 ready（跳过）。
 */
export function getReadySubgoals(goalStatus: GoalStatus): Subgoal[] {
  const subgoalMap = buildSubgoalMap(goalStatus);
  return goalStatus.subgoals.filter(
    (s) => s.status === "ready" && areDependenciesMet(s, subgoalMap)
  );
}

/**
 * 返回所有 status 为 "ready" 但依赖未全部满足的子目标，附带阻塞它的依赖 id 列表。
 * blocked_by 包含 depends_on 中 status 不为 "accepted" 的 subgoal_id，
 * 以及引用不存在的 id。
 */
export function getBlockedSubgoals(
  goalStatus: GoalStatus
): Array<{ subgoal: Subgoal; blocked_by: string[] }> {
  const subgoalMap = buildSubgoalMap(goalStatus);
  const result: Array<{ subgoal: Subgoal; blocked_by: string[] }> = [];

  for (const s of goalStatus.subgoals) {
    if (s.status !== "ready") continue;
    const blockedBy: string[] = [];
    for (const depId of s.depends_on) {
      const dep = subgoalMap.get(depId);
      if (!dep) {
        blockedBy.push(depId);
      } else if (dep.status !== "accepted") {
        blockedBy.push(depId);
      }
    }
    if (blockedBy.length > 0) {
      result.push({ subgoal: s, blocked_by: blockedBy });
    }
  }

  return result;
}

/**
 * 建议下一个可执行的子目标。
 *
 * 优先级：
 *   1. 有 ready 子目标 → 返回第一个（按 subgoal 添加顺序）的 { subgoal_id, title, depends_on }
 *   2. 无 ready 但有 blocked → 返回 { subgoal_id: null, reason: "dependencies_not_met", blocked_by: [...] }
 *   3. 无 ready 无 blocked → 返回 { subgoal_id: null, reason: "no_ready_subgoal" }
 */
export function suggestNextSubgoal(goalStatus: GoalStatus): {
  subgoal_id: string | null;
  title?: string;
  depends_on?: string[];
  reason?: string;
  blocked_by?: string[];
} {
  const ready = getReadySubgoals(goalStatus);
  if (ready.length > 0) {
    const first = ready[0];
    return {
      subgoal_id: first.id,
      title: first.title,
      depends_on: [...first.depends_on],
    };
  }

  const blocked = getBlockedSubgoals(goalStatus);
  if (blocked.length > 0) {
    return {
      subgoal_id: null,
      reason: "dependencies_not_met",
      blocked_by: blocked.map((b) => b.subgoal.id),
    };
  }

  return {
    subgoal_id: null,
    reason: "no_ready_subgoal",
  };
}

/**
 * 检测 subgoal 依赖图是否有环（DFS 三色标记法）。
 *
 * 沿 depends_on 深度优先遍历，遇到当前路径上正在访问的节点即为环。
 * depends_on 引用不存在的 subgoal 不算环（忽略）。
 *
 * @returns 有环时返回环上的 subgoal_id 数组（任一环即可）；无环返回 null。
 */
export function detectCycle(goalStatus: GoalStatus): string[] | null {
  const subgoalMap = buildSubgoalMap(goalStatus);

  const WHITE = 0;
  const GRAY = 1;
  const BLACK = 2;
  const color = new Map<string, number>();
  for (const s of goalStatus.subgoals) {
    color.set(s.id, WHITE);
  }

  let cycle: string[] | null = null;

  const dfs = (id: string, path: string[]): boolean => {
    color.set(id, GRAY);
    path.push(id);

    const node = subgoalMap.get(id);
    if (node) {
      for (const depId of node.depends_on) {
        if (!subgoalMap.has(depId)) continue; // 引用不存在，忽略
        const depColor = color.get(depId);
        if (depColor === GRAY) {
          // 发现环：截取从依赖节点到当前节点的路径
          const cycleStart = path.indexOf(depId);
          cycle = path.slice(cycleStart);
          return true;
        }
        if (depColor === WHITE) {
          if (dfs(depId, path)) return true;
        }
      }
    }

    path.pop();
    color.set(id, BLACK);
    return false;
  };

  for (const s of goalStatus.subgoals) {
    if (color.get(s.id) === WHITE) {
      if (dfs(s.id, [])) return cycle;
    }
  }

  return null;
}

/**
 * 对 subgoal 做拓扑排序（依赖在前）。
 *
 * 如果 B depends_on A，则 A 排在 B 之前。
 * depends_on 引用不存在的 id 会被忽略（不影响排序）。
 *
 * @throws {PatchWardenError} reason="dependency_cycle" 当依赖图存在环时。
 * @returns subgoal_id 数组，依赖项在前。
 */
export function topologicalSort(goalStatus: GoalStatus): string[] {
  const cycle = detectCycle(goalStatus);
  if (cycle) {
    throw new PatchWardenError(
      "dependency_cycle",
      `Dependency cycle detected among subgoals: ${cycle.join(" -> ")}`,
      "Remove the circular dependency among subgoals before performing topological sort.",
      true,
      { cycle }
    );
  }

  const subgoalMap = buildSubgoalMap(goalStatus);
  const visited = new Set<string>();
  const result: string[] = [];

  const visit = (id: string): void => {
    if (visited.has(id)) return;
    visited.add(id);

    const node = subgoalMap.get(id);
    if (node) {
      for (const depId of node.depends_on) {
        if (subgoalMap.has(depId)) {
          visit(depId);
        }
      }
    }

    result.push(id);
  };

  for (const s of goalStatus.subgoals) {
    visit(s.id);
  }

  return result;
}
