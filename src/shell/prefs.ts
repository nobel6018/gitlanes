// Preferences(⌘,) 설정 저장소. 값의 형태는 ui-panels의 PrefValues 계약을 따르고,
// 항목마다 별도 localStorage 키에 저장한다 (기존 키를 그대로 이어 쓰기 위함).
import { AUTO_FETCH_CHOICES } from "./Preferences";
import type { AutoFetchMinutes, PrefValues } from "./Preferences";

const KEYS = {
  showTags: "gitlanes.showTags",
  dateMode: "gitlanes.dateMode",
  hoverHighlight: "gitlanes.hoverHighlight",
  autoUpdateCheck: "gitlanes.autoUpdateCheck",
  zoom: "gitlanes.zoom",
  autoFetchMinutes: "gitlanes.autoFetchMinutes",
} as const;

export const DEFAULT_PREFS: PrefValues = {
  showTags: true,
  dateMode: "absolute",
  hoverHighlight: true,
  autoUpdateCheck: true,
  zoom: 1,
  autoFetchMinutes: 5,
};

/** 웹뷰 줌 범위와 단계 (⌘=/⌘- 와 Preferences 슬라이더가 공유) */
export const ZOOM_MIN = 0.8;
export const ZOOM_MAX = 1.6;
export const ZOOM_STEP = 0.1;

/**
 * 범위를 자르고 소수점 2자리로 정규화한다.
 * 슬라이더(0.05 단계)와 ⌘=/⌘-(0.1 단계)가 같은 값 공간을 쓰게 하고,
 * 1.0500000000000003 같은 부동소수 잔재가 저장되지 않게 막는다.
 */
export function clampZoom(level: number): number {
  if (!Number.isFinite(level)) {
    return DEFAULT_PREFS.zoom;
  }
  const snapped = Math.round(level * 20) / 20;
  const bounded = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, snapped));
  return Math.round(bounded * 100) / 100;
}

/** 저장값이 선택지에 없으면(손으로 고쳤거나 옛 버전) 기본값으로 돌린다 */
function toAutoFetchMinutes(raw: string | null): AutoFetchMinutes {
  const parsed = raw === null ? Number.NaN : Number(raw);
  const hit = AUTO_FETCH_CHOICES.find((choice) => choice === parsed);
  return hit ?? DEFAULT_PREFS.autoFetchMinutes;
}

function readFlag(key: string, fallback: boolean): boolean {
  try {
    const raw = localStorage.getItem(key);
    if (raw === null) {
      return fallback;
    }
    return raw !== "0";
  } catch {
    return fallback;
  }
}

export function readPrefs(): PrefValues {
  let zoom = DEFAULT_PREFS.zoom;
  let dateMode = DEFAULT_PREFS.dateMode;
  let autoFetchMinutes = DEFAULT_PREFS.autoFetchMinutes;
  try {
    const rawZoom = localStorage.getItem(KEYS.zoom);
    if (rawZoom !== null) {
      const parsed = Number.parseFloat(rawZoom);
      zoom = Number.isFinite(parsed) ? clampZoom(parsed) : DEFAULT_PREFS.zoom;
    }
    dateMode = localStorage.getItem(KEYS.dateMode) === "relative" ? "relative" : "absolute";
    autoFetchMinutes = toAutoFetchMinutes(localStorage.getItem(KEYS.autoFetchMinutes));
  } catch {
    // localStorage를 못 읽으면 기본값
  }
  return {
    showTags: readFlag(KEYS.showTags, DEFAULT_PREFS.showTags),
    dateMode,
    hoverHighlight: readFlag(KEYS.hoverHighlight, DEFAULT_PREFS.hoverHighlight),
    autoUpdateCheck: readFlag(KEYS.autoUpdateCheck, DEFAULT_PREFS.autoUpdateCheck),
    zoom,
    autoFetchMinutes,
  };
}

/** 바뀐 항목만 저장한다 */
export function writePrefs(patch: Partial<PrefValues>): void {
  try {
    if (patch.showTags !== undefined) {
      localStorage.setItem(KEYS.showTags, patch.showTags ? "1" : "0");
    }
    if (patch.dateMode !== undefined) {
      localStorage.setItem(KEYS.dateMode, patch.dateMode);
    }
    if (patch.hoverHighlight !== undefined) {
      localStorage.setItem(KEYS.hoverHighlight, patch.hoverHighlight ? "1" : "0");
    }
    if (patch.autoUpdateCheck !== undefined) {
      localStorage.setItem(KEYS.autoUpdateCheck, patch.autoUpdateCheck ? "1" : "0");
    }
    if (patch.zoom !== undefined) {
      localStorage.setItem(KEYS.zoom, String(patch.zoom));
    }
    if (patch.autoFetchMinutes !== undefined) {
      localStorage.setItem(KEYS.autoFetchMinutes, String(patch.autoFetchMinutes));
    }
  } catch {
    // 저장 실패는 무시 (이번 세션에만 적용)
  }
}
