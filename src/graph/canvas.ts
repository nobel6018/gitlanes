// GRAPH 컬럼 캔버스 페인터. 순수 그리기 함수만 두고 스크롤/rAF 관리는 GraphView가 한다.
// 계약(CONTRACTS.md): CommitRow.edges는 rust-core가 계산해 내려준다. 여기서는 좌표 변환만 한다.
import { DOT_RADIUS, EDGE_WIDTH, ROW_HEIGHT } from "../constants";
import type { CommitRow } from "../types";
import { laneColor, laneX } from "./layout";

/** WIP 의사 행. index는 커밋 행이 아니라 화면 행(display index) 기준이다 */
export interface WipMark {
  /** WIP 행이 삽입된 화면 행 인덱스 */
  index: number;
  lane: number;
  color: number;
  /** HEAD 점까지 점선 수직 엣지를 그릴지. isHead 행이 없으면 false */
  connected: boolean;
}

export interface DrawParams {
  rows: CommitRow[];
  /** WIP 행이 삽입된 커밋 행 인덱스. 없으면 -1 */
  wipInsertAt: number;
  wip: WipMark | null;
  /** 스크롤 컨테이너의 현재 scrollTop */
  scrollTop: number;
  /** CSS px 기준 캔버스 크기 */
  width: number;
  height: number;
  devicePixelRatio: number;
  /** merge 커밋 링의 내부를 채울 색 (var(--bg-content) 해석값) */
  bgColor: string;
}

/** 화면 밖 한 행씩 여유를 둬서 절단된 곡선이 보이지 않게 한다 */
const EDGE_OVERSCAN_ROWS = 2;
const WIP_DASH = [3, 3];

export function drawGraph(canvas: HTMLCanvasElement, p: DrawParams): void {
  const ctx = canvas.getContext("2d");
  if (!ctx || p.width <= 0 || p.height <= 0) {
    return;
  }

  const dpr = p.devicePixelRatio;
  const pxW = Math.round(p.width * dpr);
  const pxH = Math.round(p.height * dpr);
  if (canvas.width !== pxW || canvas.height !== pxH) {
    canvas.width = pxW;
    canvas.height = pxH;
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, p.width, p.height);

  const rows = p.rows;
  const centerY = (displayIndex: number) =>
    displayIndex * ROW_HEIGHT + ROW_HEIGHT / 2 - p.scrollTop;
  // WIP 행이 끼면 그 아래 커밋 행들의 화면 위치가 한 행씩 밀린다
  const toDisplay = (rowIndex: number) =>
    p.wipInsertAt >= 0 && rowIndex >= p.wipInsertAt ? rowIndex + 1 : rowIndex;
  const toRow = (displayIndex: number) =>
    p.wipInsertAt >= 0 && displayIndex > p.wipInsertAt ? displayIndex - 1 : displayIndex;

  const firstDisplay = Math.floor(p.scrollTop / ROW_HEIGHT) - EDGE_OVERSCAN_ROWS;
  const lastDisplay = Math.ceil((p.scrollTop + p.height) / ROW_HEIGHT) + EDGE_OVERSCAN_ROWS;

  if (p.wip && p.wip.index >= firstDisplay && p.wip.index <= lastDisplay) {
    drawWip(ctx, p.wip, centerY);
  }

  if (rows.length === 0) {
    return;
  }

  const first = Math.max(0, toRow(firstDisplay));
  const last = Math.min(rows.length - 1, toRow(lastDisplay));

  // 색상별로 Path2D를 모아 stroke 호출 수를 색 개수(<=10)로 줄인다
  const paths = new Map<number, Path2D>();
  const pathFor = (color: number): Path2D => {
    let path = paths.get(color);
    if (!path) {
      path = new Path2D();
      paths.set(color, path);
    }
    return path;
  };

  for (let i = first; i <= last; i++) {
    const row = rows[i];
    const y0 = centerY(toDisplay(i));
    const y1 = centerY(toDisplay(i + 1));
    for (const edge of row.edges) {
      const x0 = laneX(edge.fromLane);
      const path = pathFor(edge.color);
      if (edge.fromLane === edge.toLane) {
        path.moveTo(x0, y0);
        path.lineTo(x0, y1);
        continue;
      }
      // GitKraken 식 S곡선: 제어점을 수직 방향으로 구간 높이의 절반만큼 띄운다.
      // WIP 행이 끼어 구간이 두 행 높이가 되면 곡선도 그만큼 늘어난다
      const x1 = laneX(edge.toLane);
      const bend = (y1 - y0) * 0.5;
      path.moveTo(x0, y0);
      path.bezierCurveTo(x0, y0 + bend, x1, y1 - bend, x1, y1);
    }
  }

  ctx.lineWidth = EDGE_WIDTH;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  for (const [color, path] of paths) {
    ctx.strokeStyle = laneColor(color);
    ctx.stroke(path);
  }

  // 곡선이 점 위를 지나지 않도록 점은 마지막에 그린다
  for (let i = first; i <= last; i++) {
    const row = rows[i];
    const x = laneX(row.lane);
    const y = centerY(toDisplay(i));
    const color = laneColor(row.color);
    const r = row.isHead ? DOT_RADIUS + 1.5 : DOT_RADIUS;

    if (row.isMerge) {
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fillStyle = p.bgColor;
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = color;
      ctx.stroke();
    } else {
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.fill();
    }

    if (row.isHead) {
      ctx.beginPath();
      ctx.arc(x, y, r + 3, 0, Math.PI * 2);
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = color;
      ctx.stroke();
    }
  }
}

/** WIP 의사 행: 채움 없는 점선 링 + HEAD 점까지 점선 수직 엣지 */
function drawWip(
  ctx: CanvasRenderingContext2D,
  wip: WipMark,
  centerY: (displayIndex: number) => number,
): void {
  const x = laneX(wip.lane);
  const y = centerY(wip.index);
  const color = laneColor(wip.color);

  ctx.save();
  ctx.setLineDash(WIP_DASH);
  ctx.strokeStyle = color;
  ctx.lineCap = "butt";

  if (wip.connected) {
    ctx.lineWidth = EDGE_WIDTH;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x, centerY(wip.index + 1));
    ctx.stroke();
  }

  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.arc(x, y, DOT_RADIUS, 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();
}
