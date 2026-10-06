/**
 * Git Graph - 分支图谱数据结构和算法
 *
 * 实现类似 Fork/GitHub 的 Git 提交历史图谱可视化。
 * 每个提交被分配到一条垂直的"车道"（lane），车道按需分配并在提交消费后立即回收，
 * 因此车道始终紧凑地靠左排列（不会出现空洞的保留列）。
 *
 * 渲染模型：每行产出"车道线段"（穿过本行的垂直线）与"合并曲线"（从本行底部汇入本行节点），
 * 避免旧实现中"无条件画上一行到本行垂直线"产生的悬空线段。
 *
 * 车道颜色不写死在这里：调色板来自 shared/appearance.ts（与设置页同一份），
 * 渲染时统一走 laneColor() 返回的 CSS 变量表达式，用户才能在「主题配色 → 高级 → Git 配色」改色。
 */

import { GIT_BRANCH_LANES } from '../../../../shared/plugins/git-colors';

export interface RawCommit {
  hash: string;
  parents: string[];
  message: string;
  author: string;
  date: string;
  refs: string[];
}

export interface CommitNode extends RawCommit {
  /** 该提交在图谱中的列位置（从 0 开始） */
  column: number;
  /** 该提交所属分支的颜色索引 */
  color: number;
  /** 行索引（第几行，从 0 开始） */
  row: number;
}

/** 本行内某条车道的垂直线段：top=从行顶进入，bottom=从行底离开 */
export interface GraphLaneSegment {
  col: number;
  color: number;
  top: boolean;
  bottom: boolean;
}

/** 本行内的合并曲线：从 (fromCol, 行底) 贝塞尔汇入本行节点中心 */
export interface GraphMergeCurve {
  fromCol: number;
  color: number;
}

/** 单行渲染数据 */
export interface GraphRow {
  node: CommitNode;
  lanes: GraphLaneSegment[];
  merges: GraphMergeCurve[];
}

/** Include passing lanes and merge endpoints, not just the current commit dot. */
export function graphRowColumns(row: GraphRow): number {
  return 1 + Math.max(row.node.column,
    ...row.lanes.filter(lane => lane.top || lane.bottom).map(lane => lane.col),
    ...row.merges.map(merge => merge.fromCol));
}

/**
 * 分支颜色调色板：主题 token 的内置默认值（shared/appearance.ts 单一来源）。
 */
export const BRANCH_COLORS: ReadonlyArray<string> = GIT_BRANCH_LANES;

/** 车道总数（= 调色板长度，超出后循环取色）。 */
export const BRANCH_LANE_COUNT = GIT_BRANCH_LANES.length;

/**
 * 第 index 条车道的颜色表达式：--git-lane-N（用户覆盖）→ 内置默认兜底。
 * 只能用在 CSS/style 里：SVG 表现属性不吃 var()（Chromium 会整条作废退回默认色）。
 */
export function laneColor(index: number): string {
  const i = ((index % BRANCH_LANE_COUNT) + BRANCH_LANE_COUNT) % BRANCH_LANE_COUNT;
  return `var(--git-lane-${i}, ${GIT_BRANCH_LANES[i]})`;
}

/**
 * 图谱构建结果
 */
export interface GraphResult {
  rows: GraphRow[];
  /** 总列数（用于确定 SVG 宽度） */
  totalColumns: number;
}

/**
 * 构建分支图谱
 *
 * 算法思路：
 * 1. 维护"预约表" laneOf：尚未渲染到的提交 -> 其车道（由子提交在处理时预约）
 * 2. 从上到下（从新到旧）遍历每个提交：
 *    - 若已被预约：消费该车道（立即从预约表删除，车道随之可被复用 → 紧凑）
 *    - 否则分配最小空闲车道
 * 3. 第一个父提交继承当前车道（主线垂直延续）；若第一父提交已被其他子提交预约，
 *    则改为画合并曲线（criss-cross 场景）
 * 4. 其余父提交：已预约 → 从该车道画合并曲线；未预约 → 预约空闲车道并画合并曲线
 * 5. 每行的垂直线段由"穿过本行的预约车道 + 本行节点车道的上下衔接"组成
 */
export function buildGraph(commits: RawCommit[]): GraphResult {
  const rows: GraphRow[] = [];
  // 尚未渲染到的提交 -> 预约车道 / 颜色
  const laneOf = new Map<string, number>();
  const colorOf = new Map<string, number>();
  let nextColor = 0;
  let maxCol = -1;

  for (let row = 0; row < commits.length; row++) {
    const commit = commits[row];
    // 快照本行开始前已预约的车道（它们都会"穿过"本行向下延续）
    const passing = new Map(laneOf);
    const passingColor = new Map(colorOf);

    let column: number;
    let color: number;
    const wasReserved = laneOf.has(commit.hash);
    if (wasReserved) {
      column = laneOf.get(commit.hash)!;
      color = colorOf.get(commit.hash)!;
      // 消费后立即回收，车道可被后续提交复用 → 图谱紧凑靠左
      laneOf.delete(commit.hash);
      colorOf.delete(commit.hash);
    } else {
      column = findFreeColumn(laneOf);
      color = nextColor++;
    }
    if (column > maxCol) maxCol = column;

    const lanes: GraphLaneSegment[] = [];
    const merges: GraphMergeCurve[] = [];

    // 穿过本行的车道（不含本行节点自身）
    for (const [hash, col] of passing) {
      if (hash === commit.hash) continue;
      lanes.push({ col, color: passingColor.get(hash) ?? 0, top: true, bottom: true });
    }

    // 第一个父提交：继承当前车道（垂直延续）；若已被预约则画合并曲线
    let nodeBottom = false;
    const firstParent = commit.parents[0];
    if (firstParent) {
      if (laneOf.has(firstParent)) {
        merges.push({ fromCol: laneOf.get(firstParent)!, color: colorOf.get(firstParent) ?? color });
      } else {
        laneOf.set(firstParent, column);
        colorOf.set(firstParent, color);
        nodeBottom = true;
      }
    }
    lanes.push({ col: column, color, top: wasReserved, bottom: nodeBottom });

    // 其余父提交（merge 场景）：从各自车道画合并曲线汇入本行节点
    for (let i = 1; i < commit.parents.length; i++) {
      const parent = commit.parents[i];
      if (laneOf.has(parent)) {
        merges.push({ fromCol: laneOf.get(parent)!, color: colorOf.get(parent) ?? nextColor++ });
      } else {
        const parentCol = findFreeColumn(laneOf);
        if (parentCol > maxCol) maxCol = parentCol;
        const parentColor = nextColor++;
        laneOf.set(parent, parentCol);
        colorOf.set(parent, parentColor);
        merges.push({ fromCol: parentCol, color: parentColor });
      }
    }

    rows.push({ node: { ...commit, column, color, row }, lanes, merges });
  }

  return { rows, totalColumns: maxCol + 1 };
}

/** 找最小空闲车道（不在预约表中的最小非负整数） */
function findFreeColumn(laneOf: Map<string, number>): number {
  const used = new Set(laneOf.values());
  let col = 0;
  while (used.has(col)) col++;
  return col;
}
