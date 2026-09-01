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

/** .gl-root에 인라인으로 붙이는 CSS 변수. 드래그 중에는 이 값만 바뀐다 */
export function columnStyle(columns: ColumnWidths): Record<string, string> {
  return {
    "--col-branch": `${columns.branch}px`,
    "--col-author": `${columns.author}px`,
    "--col-sha": `${columns.sha}px`,
    "--col-date": `${columns.date}px`,
  };
}
