/** 패널 가로 폭. 드래그로 조절하고 localStorage에 저장한다 */
export interface LayoutWidths {
  sidebar: number;
  detail: number;
}

const LAYOUT_KEY = "gitlanes.layout";

export const DEFAULT_LAYOUT: LayoutWidths = { sidebar: 220, detail: 360 };

export const SIDEBAR_MIN = 160;
export const SIDEBAR_MAX = 480;
export const DETAIL_MIN = 280;

/** 상세 패널은 창 폭의 60%를 넘지 않는다 */
export function detailMax(): number {
  return Math.max(DETAIL_MIN, Math.round(window.innerWidth * 0.6));
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

export function readLayout(): LayoutWidths {
  try {
    const raw = localStorage.getItem(LAYOUT_KEY);
    if (raw === null) {
      return DEFAULT_LAYOUT;
    }
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object") {
      return DEFAULT_LAYOUT;
    }
    const record = parsed as { sidebar?: unknown; detail?: unknown };
    return {
      sidebar:
        typeof record.sidebar === "number"
          ? clamp(record.sidebar, SIDEBAR_MIN, SIDEBAR_MAX)
          : DEFAULT_LAYOUT.sidebar,
      detail:
        typeof record.detail === "number"
          ? Math.max(DETAIL_MIN, record.detail)
          : DEFAULT_LAYOUT.detail,
    };
  } catch {
    return DEFAULT_LAYOUT;
  }
}

export function writeLayout(layout: LayoutWidths): void {
  try {
    localStorage.setItem(LAYOUT_KEY, JSON.stringify(layout));
  } catch {
    // localStorage 실패는 무시 (다음 실행에서 기본값)
  }
}
