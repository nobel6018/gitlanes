// 컬럼 폭과 좌표 계산. GraphView(행 DOM)와 canvas.ts(그래프 캔버스)가 공유한다.
// 두 쪽이 같은 상수를 봐야 커밋 점과 텍스트 행이 어긋나지 않는다.
import { LANE_COLORS, LANE_WIDTH } from "../constants";

export const BRANCH_COL_WIDTH = 190;
export const AUTHOR_COL_WIDTH = 150;
export const SHA_COL_WIDTH = 90;
export const DATE_COL_WIDTH = 130;

/** GRAPH 컬럼에 실제로 그리는 최대 레인 수. 초과 레인은 캔버스 밖으로 잘린다 */
export const MAX_DRAWN_LANES = 16;

/** 레인 0의 점이 왼쪽 경계에 붙지 않게 주는 여백 */
export const GRAPH_PAD_X = 8;

/** 커밋 점 x좌표 (캔버스 로컬 좌표계) */
export function laneX(lane: number): number {
  return lane * LANE_WIDTH + LANE_WIDTH / 2 + GRAPH_PAD_X;
}

/** GRAPH 컬럼 폭. laneCount가 0이어도 최소 1레인 폭은 확보한다 */
export function graphColumnWidth(laneCount: number): number {
  const lanes = Math.min(Math.max(laneCount, 1), MAX_DRAWN_LANES);
  return lanes * LANE_WIDTH + GRAPH_PAD_X * 2;
}

/** color 인덱스는 계약상 0..9지만 방어적으로 감싼다 */
export function laneColor(color: number): string {
  const n = LANE_COLORS.length;
  return LANE_COLORS[((color % n) + n) % n];
}

/** "YYYY/MM/DD HH:mm" (로컬 타임존) */
export function formatDate(unixSeconds: number): string {
  const d = new Date(unixSeconds * 1000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}/${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** authorEmail → LANE_COLORS 인덱스. 문자 코드 누적만 하는 가벼운 결정적 해시 */
export function authorColorIndex(email: string): number {
  let hash = 0;
  for (let i = 0; i < email.length; i++) {
    hash = (hash * 31 + email.charCodeAt(i)) | 0;
  }
  const n = LANE_COLORS.length;
  return ((hash % n) + n) % n;
}

const LATIN_HEAD = /^\p{Script=Latin}/u;

/**
 * 아바타 이니셜. 라틴 이름은 앞 두 단어의 첫 글자("Jimin Park" → "JP"),
 * 한글 등 비라틴 이름은 첫 글자 1자("박용진" → "박").
 */
export function authorInitials(name: string): string {
  const trimmed = name.trim();
  if (trimmed.length === 0) {
    return "?";
  }
  const chars = [...trimmed];
  // 라틴 판정은 악센트 문자(Åsa)까지 포함하도록 스크립트 속성으로 본다
  if (!LATIN_HEAD.test(chars[0])) {
    return chars[0];
  }
  const words = trimmed.split(/\s+/).filter((word) => LATIN_HEAD.test(word));
  if (words.length === 0) {
    return chars[0].toUpperCase();
  }
  return words
    .slice(0, 2)
    .map((word) => word[0].toUpperCase())
    .join("");
}

const rgbaCache = new Map<string, string>();

/** LANE_COLORS[color]를 alpha 적용한 rgba 문자열로. 행마다 파싱하지 않게 캐시한다 */
export function laneColorAlpha(color: number, alpha: number): string {
  const key = `${color}:${alpha}`;
  const cached = rgbaCache.get(key);
  if (cached !== undefined) {
    return cached;
  }
  const hex = laneColor(color);
  const value = parseInt(hex.slice(1), 16);
  const rgba = `rgba(${(value >> 16) & 0xff}, ${(value >> 8) & 0xff}, ${value & 0xff}, ${alpha})`;
  rgbaCache.set(key, rgba);
  return rgba;
}
