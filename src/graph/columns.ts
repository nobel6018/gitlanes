// 리사이즈 가능한 컬럼 폭. 헤더와 행이 같은 값을 봐야 하므로 CSS 변수로 내려보낸다.
// @see CONTRACTS.md "v0.5 확장" - 컬럼 리사이즈
import {
  AUTHOR_COL_WIDTH,
  BRANCH_COL_WIDTH,
  DATE_COL_WIDTH,
  SHA_COL_WIDTH,
} from "./layout";

export type ColumnKey = "branch" | "author" | "sha" | "date";

export type ColumnWidths = Record<ColumnKey, number>;

export const COLUMNS_STORAGE_KEY = "gitlanes.columns";
export const COLUMN_MIN_WIDTH = 60;
export const COLUMN_MAX_WIDTH = 500;

export const DEFAULT_COLUMNS: ColumnWidths = {
  branch: BRANCH_COL_WIDTH,
  author: AUTHOR_COL_WIDTH,
  sha: SHA_COL_WIDTH,
  date: DATE_COL_WIDTH,
};

const COLUMN_KEYS: ColumnKey[] = ["branch", "author", "sha", "date"];

export function clampColumnWidth(width: number): number {
  return Math.round(Math.min(COLUMN_MAX_WIDTH, Math.max(COLUMN_MIN_WIDTH, width)));
}

/** 저장값이 깨졌거나 범위를 벗어나면 그 컬럼만 기본값으로 되돌린다 */
export function loadColumns(): ColumnWidths {
  const result = { ...DEFAULT_COLUMNS };
  if (typeof localStorage === "undefined") {
    return result;
  }
  let parsed: unknown;
  try {
    const raw = localStorage.getItem(COLUMNS_STORAGE_KEY);
    if (raw === null) {
      return result;
    }
    parsed = JSON.parse(raw);
  } catch {
    return result;
  }
  if (typeof parsed !== "object" || parsed === null) {
    return result;
  }
  const record = parsed as Record<string, unknown>;
  for (const key of COLUMN_KEYS) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      result[key] = clampColumnWidth(value);
    }
  }
  return result;
}

export function saveColumns(columns: ColumnWidths): void {
  if (typeof localStorage === "undefined") {
    return;
  }
  try {
    localStorage.setItem(COLUMNS_STORAGE_KEY, JSON.stringify(columns));
  } catch {
    // 저장 실패(프라이빗 모드, 용량 초과)는 무시한다. 폭은 이번 세션에만 유지된다
  }
}

/**
 * .gl-root에 인라인으로 붙이는 CSS 변수. 드래그 중에는 이 값만 바뀐다.
 * bodyHeight는 헤더의 리사이즈 핸들이 가이드 선을 커밋 목록 높이만큼 늘리는 데 쓴다.
 */
export function columnStyle(columns: ColumnWidths, bodyHeight = 0): Record<string, string> {
  return {
    "--col-branch": `${columns.branch}px`,
    "--col-author": `${columns.author}px`,
    "--col-sha": `${columns.sha}px`,
    "--col-date": `${columns.date}px`,
    "--gl-body-h": `${Math.max(0, Math.round(bodyHeight))}px`,
  };
}

/** MESSAGE는 가장 중요한 컬럼이라 이 폭은 항상 확보한다 */
export const MESSAGE_MIN_WIDTH = 240;
/** GRAPH 컬럼이 컨테이너에서 차지할 수 있는 최대 비율 */
export const GRAPH_MAX_RATIO = 0.35;
/** 컨테이너가 이 폭 미만이면 BRANCH/TAG도 숨김 후보에 들어간다 */
export const BRANCH_DROP_WIDTH = 560;

/** 공간이 부족할 때 드롭하는 순서 (오른쪽부터) */
const DROP_ORDER: ColumnKey[] = ["date", "sha", "author", "branch"];

/** 숨김 상태를 비트마스크로 나른다. 원시값이라 Row의 memo를 깨지 않는다 */
export const COLUMN_FLAG: Record<ColumnKey, number> = {
  branch: 1,
  author: 2,
  sha: 4,
  date: 8,
};

export interface ColumnFit {
  /** 실제 적용 폭. 숨긴 컬럼은 값이 남아 있어도 렌더되지 않는다 */
  widths: ColumnWidths;
  /** 숨긴 컬럼 비트마스크 */
  hiddenMask: number;
  graphWidth: number;
}

/**
 * 컨테이너 폭에 컬럼을 맞춘다. 순서는 GRAPH 상한 → 오른쪽 컬럼 드롭 → 남은 컬럼 축소.
 * 사용자가 드래그한 폭도 MESSAGE 최소 폭을 침범하면 축소 대상이 된다.
 */
export function fitColumns(
  layoutWidth: number,
  columns: ColumnWidths,
  graphDesired: number,
  minGraphWidth: number,
): ColumnFit {
  // 아직 측정 전이면 제약 없이 그린다
  if (layoutWidth <= 0) {
    return { widths: { ...columns }, hiddenMask: 0, graphWidth: graphDesired };
  }

  const graphWidth = Math.min(
    graphDesired,
    Math.max(minGraphWidth, Math.floor(layoutWidth * GRAPH_MAX_RATIO)),
  );
  const widths = { ...columns };
  let hiddenMask = 0;

  const fixedTotal = () =>
    DROP_ORDER.reduce(
      (sum, key) => sum + ((hiddenMask & COLUMN_FLAG[key]) !== 0 ? 0 : widths[key]),
      graphWidth,
    );

  for (const key of DROP_ORDER) {
    if (fixedTotal() + MESSAGE_MIN_WIDTH <= layoutWidth) {
      break;
    }
    // BRANCH는 아주 좁을 때만 포기한다
    if (key === "branch" && layoutWidth >= BRANCH_DROP_WIDTH) {
      break;
    }
    hiddenMask |= COLUMN_FLAG[key];
  }

  // 전부 드롭해도 부족하면 남은 컬럼을 최소 폭까지 비례 축소한다
  let deficit = fixedTotal() + MESSAGE_MIN_WIDTH - layoutWidth;
  if (deficit > 0) {
    const visible = DROP_ORDER.filter((key) => (hiddenMask & COLUMN_FLAG[key]) === 0);
    let headroom = visible.reduce(
      (sum, key) => sum + Math.max(0, widths[key] - COLUMN_MIN_WIDTH),
      0,
    );
    for (const key of visible) {
      if (deficit <= 0 || headroom <= 0) {
        break;
      }
      const room = Math.max(0, widths[key] - COLUMN_MIN_WIDTH);
      const cut = Math.min(room, Math.ceil((deficit * room) / headroom));
      widths[key] -= cut;
      deficit -= cut;
      headroom -= room;
    }
  }

  return { widths, hiddenMask, graphWidth };
}
