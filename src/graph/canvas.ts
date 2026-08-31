// GRAPH 컬럼 캔버스 페인터. 순수 그리기 함수만 두고 스크롤/rAF 관리는 GraphView가 한다.
// 계약(CONTRACTS.md): CommitRow.edges는 rust-core가 계산해 내려준다. 여기서는 좌표 변환만 한다.
import { DOT_RADIUS, EDGE_WIDTH, ROW_HEIGHT } from "../constants";
import type { CommitRow } from "../types";
import { laneColor, laneX } from "./layout";

export interface DrawParams {
  rows: CommitRow[];
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
  if (rows.length === 0) {
    return;
  }

  const first = Math.max(0, Math.floor(p.scrollTop / ROW_HEIGHT) - EDGE_OVERSCAN_ROWS);
  const last = Math.min(
    rows.length - 1,
    Math.ceil((p.scrollTop + p.height) / ROW_HEIGHT) + EDGE_OVERSCAN_ROWS,
  );
  const centerY = (index: number) => index * ROW_HEIGHT + ROW_HEIGHT / 2 - p.scrollTop;

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
    const y0 = centerY(i);
    const y1 = centerY(i + 1);
    for (const edge of row.edges) {
      const x0 = laneX(edge.fromLane);
      const path = pathFor(edge.color);
      if (edge.fromLane === edge.toLane) {
        path.moveTo(x0, y0);
        path.lineTo(x0, y1);
        continue;
      }
      // GitKraken 식 S곡선: 제어점을 수직 방향으로 rowHeight*0.5 만큼 띄운다
      const x1 = laneX(edge.toLane);
      const bend = ROW_HEIGHT * 0.5;
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
    const y = centerY(i);
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
