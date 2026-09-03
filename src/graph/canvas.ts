// GRAPH 컬럼 캔버스 페인터. 순수 그리기 함수만 두고 스크롤/rAF 관리는 GraphView가 한다.
// 계약(CONTRACTS.md): CommitRow.edges는 rust-core가 계산해 내려준다. 여기서는 좌표 변환만 한다.
import { DOT_RADIUS, EDGE_WIDTH, ROW_HEIGHT } from "../constants";
import type { CommitRow, Edge } from "../types";
import { authorColorIndex, authorInitials, laneColor, laneColorAlpha, laneX } from "./layout";
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
  /** 경로 강조 플래그(행 인덱스 기준). null이면 강조 없음(전부 밝게) */
  highlight: Uint8Array | null;
}

/** 화면 밖 한 행씩 여유를 둬서 절단된 곡선이 보이지 않게 한다 */
const EDGE_OVERSCAN_ROWS = 2;

// 분기/합류 곡선의 제어점 거리. 구간 높이와 레인 이동 거리를 함께 본다.
// 고정 비율(높이의 절반)로 두면 두 레인 이상 건너뛰는 곡선이 급하게 꺾인다.
// 아래 계수는 3차 베지어의 최대 곡률을 수치로 최소화해 고른 값이고,
// 자주 나오는 조합(한 레인 이동, 1~2행 구간)에서 최적값과 일치한다.
const BEND_ROW_FACTOR = 0.28;
const BEND_LANE_FACTOR = 0.37;
/** 구간이 길고 레인 이동이 짧을 때 곡선이 대각선처럼 퍼지지 않게 하는 하한 */
const BEND_MIN_FACTOR = 0.38;
/** 넘으면 제어점이 뒤집혀 곡선이 위로 되돌아간다(비단조) */
const BEND_MAX_FACTOR = 0.9;
const PSEUDO_DASH = [3, 3];
/** 경로 밖 요소의 불투명도 */
const DIM_ALPHA = 0.35;
/**
 * 행 배경에 까는 레인 색 띠의 불투명도.
 * 어두운 테마라 GitKraken보다 옅게 잡아야 커밋 점과 곡선이 묻히지 않는다
 */
const LANE_TINT_ALPHA = 0.06;
/** GRAPH 컬럼 오른쪽 끝에 세우는 소속 표시 바 폭(px) */
const LANE_BAR_WIDTH = 3;
/** 커밋 노드를 작성자 이니셜 아바타로 그린다. 반지름(px) */
const AVATAR_R = 8;
/** 아바타 이니셜 폰트. AUTHOR 컬럼 .gl-avatar(9px/700)와 눈금을 맞춘다 */
const AVATAR_FONT = '700 9px -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif';

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

  const marked = p.highlight;
  const inSet = (index: number): boolean =>
    marked !== null && index >= 0 && index < marked.length && marked[index] === 1;
  /** 행 강조 여부. 강조가 꺼져 있으면 전부 밝다 */
  const isLit = (index: number): boolean => marked === null || inSet(index);
  /**
   * 엣지는 자기가 속한 링크의 양끝으로 판정한다. band 양끝 행 기준이 아니다.
   * @see CONTRACTS.md "Edge 링크 귀속"
   */
  const isEdgeLit = (edge: Edge): boolean =>
    marked === null ||
    (inSet(edge.childRow) && (edge.parentRow === -1 ? inSet(edge.childRow) : inSet(edge.parentRow)));

  /**
   * 행이 속한 레인 색을 배경 띠 + 오른쪽 바로 깐다. 커밋 점 x에서 시작해
   * 컬럼 오른쪽 끝까지 채우므로 그 행이 어느 줄기에 속하는지 한눈에 읽힌다.
   * 곡선과 점보다 먼저 그려 배경 레이어가 된다.
   */
  const drawLaneTint = (lane: number, color: number, displayIndex: number, lit: boolean) => {
    const top = displayIndex * ROW_HEIGHT - p.scrollTop;
    const startX = laneX(lane);
    ctx.fillStyle = laneColor(color);
    // 레인이 컬럼 밖으로 밀린 행은 띠 없이 바만 남는다
    if (startX < p.width) {
      ctx.globalAlpha = lit ? LANE_TINT_ALPHA : LANE_TINT_ALPHA * DIM_ALPHA;
      ctx.fillRect(startX, top, p.width - startX, ROW_HEIGHT);
    }
    ctx.globalAlpha = lit ? 1 : DIM_ALPHA;
    ctx.fillRect(p.width - LANE_BAR_WIDTH, top, LANE_BAR_WIDTH, ROW_HEIGHT);
  };

  // 의사 행도 앵커 커밋의 레인/색을 그대로 쓴다(pseudo.lane/color가 앵커 값).
  // 여기만 비우면 색 바가 한 행 끊겨 렌더 오류처럼 보인다
  const drawPseudoTints = () => {
    for (const pseudo of p.layout.pseudos) {
      if (pseudo.displayIndex > lastDisplay) {
        break;
      }
      if (pseudo.displayIndex >= firstDisplay) {
        drawLaneTint(pseudo.lane, pseudo.color, pseudo.displayIndex, isLit(pseudo.anchorRow));
      }
    }
    ctx.globalAlpha = 1;
  };

  const drawPseudos = () => {
    for (const pseudo of p.layout.pseudos) {
      if (pseudo.displayIndex > lastDisplay) {
        break;
      }
      if (pseudo.displayIndex >= firstDisplay) {
        drawPseudoMark(ctx, pseudo, centerY, isLit(pseudo.anchorRow));
      }
    }
  };

  if (rows.length === 0) {
    drawPseudoTints();
    drawPseudos();
    return;
  }

  const first = Math.max(0, toRowIndex(firstDisplay));
  const last = Math.min(rows.length - 1, toRowIndex(lastDisplay));

  // 배경 레이어: 보이는 행마다 fillRect 2개. 30행 남짓이라 스크롤 비용은 무시할 수준이다
  for (let i = first; i <= last; i++) {
    const row = rows[i];
    drawLaneTint(row.lane, row.color, toDisplay(i), isLit(i));
  }
  drawPseudoTints();
  ctx.globalAlpha = 1;

  // 색상별로 Path2D를 모아 stroke 호출 수를 색 개수(<=10)로 줄인다.
  // 강조가 켜지면 밝은 벌과 어두운 벌로 나눠 담아 alpha를 두 번만 바꾼다
  const brightPaths = new Map<number, Path2D>();
  const dimPaths = new Map<number, Path2D>();
  const pathFor = (color: number, dim: boolean): Path2D => {
    const bucket = dim ? dimPaths : brightPaths;
    let path = bucket.get(color);
    if (!path) {
      path = new Path2D();
      bucket.set(color, path);
    }
    return path;
  };

  for (let i = first; i <= last; i++) {
    const row = rows[i];
    const y0 = centerY(toDisplay(i));
    const y1 = centerY(toDisplay(i + 1));
    for (const edge of row.edges) {
      const x0 = laneX(edge.fromLane);
      const path = pathFor(edge.color, !isEdgeLit(edge));
      if (edge.fromLane === edge.toLane) {
        path.moveTo(x0, y0);
        path.lineTo(x0, y1);
        continue;
      }
      // GitKraken 식 S곡선. 제어점은 수직 방향으로만 띄우므로 곡선이 위아래
      // 수직선과 접선이 이어진다. 의사 행이 끼어 구간이 늘어나면 곡선도 늘어난다
      const x1 = laneX(edge.toLane);
      const height = y1 - y0;
      const bend = Math.min(
        height * BEND_MAX_FACTOR,
        Math.max(
          height * BEND_MIN_FACTOR,
          height * BEND_ROW_FACTOR + Math.abs(x1 - x0) * BEND_LANE_FACTOR,
        ),
      );
      path.moveTo(x0, y0);
      path.bezierCurveTo(x0, y0 + bend, x1, y1 - bend, x1, y1);
    }
  }

  ctx.lineWidth = EDGE_WIDTH;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  if (dimPaths.size > 0) {
    ctx.globalAlpha = DIM_ALPHA;
    for (const [color, path] of dimPaths) {
      ctx.strokeStyle = laneColor(color);
      ctx.stroke(path);
    }
    ctx.globalAlpha = 1;
  }
  for (const [color, path] of brightPaths) {
    ctx.strokeStyle = laneColor(color);
    ctx.stroke(path);
  }

  // 의사 행 마크는 통과선 위에, 커밋 점은 그보다도 위에 얹는다
  drawPseudos();

  // 커밋 노드를 작성자 이니셜 아바타로 그린다. 링 = 레인 색(브랜치 정체성),
  // 안쪽 = 작성자 색 이니셜이라 그래프만 훑어도 누가 이 줄기를 밀었는지 읽힌다.
  // 곡선이 아바타 위를 지나지 않도록 마지막에 얹는다.
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.font = AVATAR_FONT;
  for (let i = first; i <= last; i++) {
    const row = rows[i];
    const x = laneX(row.lane);
    const y = centerY(toDisplay(i));
    const ring = laneColor(row.color);
    ctx.globalAlpha = isLit(i) ? 1 : DIM_ALPHA;

    // 배경을 불투명하게 채워 레인 배경 띠를 덮어야 이니셜이 묻히지 않는다.
    // merge는 레인 색 옅은 채움을 덧대 일반 커밋과 구분한다.
    ctx.beginPath();
    ctx.arc(x, y, AVATAR_R, 0, Math.PI * 2);
    ctx.fillStyle = p.bgColor;
    ctx.fill();
    if (row.isMerge) {
      ctx.fillStyle = laneColorAlpha(row.color, 0.22);
      ctx.fill();
    }

    ctx.lineWidth = row.isMerge ? 2.5 : 1.75;
    ctx.strokeStyle = ring;
    ctx.stroke();

    ctx.fillStyle = laneColor(authorColorIndex(row.authorEmail));
    ctx.fillText(authorInitials(row.author), x, y + 0.5);

    // HEAD는 바깥에 얇은 링을 하나 더 둘러 현재 위치를 표시한다
    if (row.isHead) {
      ctx.beginPath();
      ctx.arc(x, y, AVATAR_R + 3, 0, Math.PI * 2);
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = ring;
      ctx.stroke();
    }
  }
  ctx.globalAlpha = 1;
}

/**
 * 의사 행 마크. WIP은 점선 원, 스태시는 점선 다이아몬드로 형태를 구분한다.
 * connected면 바로 아래 행(다음 의사 행 또는 앵커 커밋 점)까지 점선으로 잇는다.
 */
function drawPseudoMark(
  ctx: CanvasRenderingContext2D,
  pseudo: PseudoRow,
  centerY: (displayIndex: number) => number,
  lit: boolean,
): void {
  const x = laneX(pseudo.lane);
  const y = centerY(pseudo.displayIndex);
  const color = laneColor(pseudo.color);

  ctx.save();
  ctx.globalAlpha = lit ? 1 : DIM_ALPHA;
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
