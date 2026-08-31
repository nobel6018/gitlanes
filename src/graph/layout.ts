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
