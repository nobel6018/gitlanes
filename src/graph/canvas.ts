// GRAPH 컬럼 캔버스 페인터. 순수 그리기 함수만 두고 스크롤/rAF 관리는 GraphView가 한다.
// 계약(CONTRACTS.md): CommitRow.edges는 rust-core가 계산해 내려준다. 여기서는 좌표 변환만 한다.
import { DOT_RADIUS, EDGE_WIDTH, ROW_HEIGHT } from "../constants";
import type { CommitRow } from "../types";
import { laneColor, laneX } from "./layout";
import type { PseudoLayout, PseudoRow } from "./pseudo";

export interface DrawParams {
  rows: CommitRow[];
  /** 의사 행(WIP, 스태시) 삽입으로 밀린 화면 행 매핑 */
  layout: PseudoLayout;
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
const PSEUDO_DASH = [3, 3];

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
  const { toDisplay, toRowIndex } = p.layout;
  const centerY = (displayIndex: number) =>
    displayIndex * ROW_HEIGHT + ROW_HEIGHT / 2 - p.scrollTop;

  const firstDisplay = Math.floor(p.scrollTop / ROW_HEIGHT) - EDGE_OVERSCAN_ROWS;
  const lastDisplay = Math.ceil((p.scrollTop + p.height) / ROW_HEIGHT) + EDGE_OVERSCAN_ROWS;

  const drawPseudos = () => {
    for (const pseudo of p.layout.pseudos) {
      if (pseudo.displayIndex > lastDisplay) {
        break;
      }
      if (pseudo.displayIndex >= firstDisplay) {
        drawPseudoMark(ctx, pseudo, centerY);
      }
    }
  };

  if (rows.length === 0) {
    drawPseudos();
    return;
  }

  const first = Math.max(0, toRowIndex(firstDisplay));
  const last = Math.min(rows.length - 1, toRowIndex(lastDisplay));

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

  // 의사 행 마크는 통과선 위에, 커밋 점은 그보다도 위에 얹는다
  drawPseudos();

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

/**
 * 의사 행 마크. WIP은 점선 원, 스태시는 점선 다이아몬드로 형태를 구분한다.
 * connected면 바로 아래 행(다음 의사 행 또는 앵커 커밋 점)까지 점선으로 잇는다.
 */
function drawPseudoMark(
  ctx: CanvasRenderingContext2D,
  pseudo: PseudoRow,
  centerY: (displayIndex: number) => number,
): void {
  const x = laneX(pseudo.lane);
  const y = centerY(pseudo.displayIndex);
  const color = laneColor(pseudo.color);

  ctx.save();
  ctx.setLineDash(PSEUDO_DASH);
  ctx.strokeStyle = color;
  ctx.lineCap = "butt";

  if (pseudo.connected) {
    ctx.lineWidth = EDGE_WIDTH;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x, centerY(pseudo.displayIndex + 1));
    ctx.stroke();
  }

  ctx.lineWidth = 1.5;
  ctx.beginPath();
  if (pseudo.kind === "stash") {
    const r = DOT_RADIUS + 1;
    ctx.moveTo(x, y - r);
    ctx.lineTo(x + r, y);
    ctx.lineTo(x, y + r);
    ctx.lineTo(x - r, y);
    ctx.closePath();
  } else {
    ctx.arc(x, y, DOT_RADIUS, 0, Math.PI * 2);
  }
  ctx.stroke();
  ctx.restore();
}
