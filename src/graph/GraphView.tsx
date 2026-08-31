// GitKraken 스타일 커밋 테이블. 가상 스크롤 + 단일 캔버스 그래프.
// 접점 계약: CONTRACTS.md의 "GraphView 컴포넌트" 절. GraphViewProps는 동결이다.
import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { ROW_HEIGHT } from "../constants";
import type { CommitRow, GraphData } from "../types";
import { drawGraph } from "./canvas";
import {
  AUTHOR_COL_WIDTH,
  BRANCH_COL_WIDTH,
  DATE_COL_WIDTH,
  SHA_COL_WIDTH,
  authorColorIndex,
  authorInitials,
  formatDate,
  graphColumnWidth,
  laneColor,
  laneColorAlpha,
} from "./layout";
import { RefPills } from "./RefPills";
import "./graph.css";

export interface GraphViewProps {
  data: GraphData;
  selectedSha: string | null;
  onSelect: (sha: string) => void;
  /** hasMore이고 스크롤이 바닥 근처면 호출 */
  onLoadMore: () => void;
  loading: boolean;
  showTags: boolean;
}

/** 보이는 범위 위아래로 더 그려두는 행 수 */
const OVERSCAN_ROWS = 10;
/** 바닥에서 이 거리 안으로 들어오면 onLoadMore() */
const LOAD_MORE_THRESHOLD_PX = 300;
/** SHA 컬럼에 표시할 자릿수 (shortSha는 10자) */
const SHA_DISPLAY_LENGTH = 8;
const FOOTER_HEIGHT = 24;
/** theme.css를 못 읽는 환경(단독 테스트 등)에서만 쓰이는 --bg-content 기본값 */
const BG_FALLBACK = "#1C1E23";

interface RowProps {
  row: CommitRow;
  top: number;
  selected: boolean;
  showTags: boolean;
  graphWidth: number;
  onSelect: (sha: string) => void;
}

const Row = memo(function Row({
  row,
  top,
  selected,
  showTags,
  graphWidth,
  onSelect,
}: RowProps) {
  const className =
    "gl-row" + (selected ? " gl-row-selected" : "") + (row.isHead ? " gl-row-head" : "");
  const avatarColor = authorColorIndex(row.authorEmail);
  return (
    <div
      className={className}
      style={{ top, height: ROW_HEIGHT }}
      onClick={() => onSelect(row.sha)}
    >
      <div className="gl-cell gl-cell-branch" style={{ width: BRANCH_COL_WIDTH }}>
        <RefPills refs={row.refs} laneColor={laneColor(row.color)} showTags={showTags} />
      </div>
      <div className="gl-cell gl-cell-graph" style={{ width: graphWidth }} />
      <div className="gl-cell gl-cell-message" title={row.subject}>
        {row.subject}
      </div>
      <div className="gl-cell gl-cell-author" style={{ width: AUTHOR_COL_WIDTH }} title={row.author}>
        <span
          className="gl-avatar"
          style={{
            background: laneColorAlpha(avatarColor, 0.25),
            color: laneColor(avatarColor),
          }}
        >
          {authorInitials(row.author)}
        </span>
        <span className="gl-author-name">{row.author}</span>
      </div>
      <div className="gl-cell gl-cell-sha" style={{ width: SHA_COL_WIDTH }}>
        {row.shortSha.slice(0, SHA_DISPLAY_LENGTH)}
      </div>
      <div className="gl-cell gl-cell-date" style={{ width: DATE_COL_WIDTH }}>
        {formatDate(row.timestamp)}
      </div>
    </div>
  );
});

export function GraphView({
  data,
  selectedSha,
  onSelect,
  onLoadMore,
  loading,
  showTags,
}: GraphViewProps) {
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  // 스크롤 위치는 ref로만 들고 다닌다. 상태로 두면 60fps마다 전체 트리가 리렌더된다
  const scrollTopRef = useRef(0);
  const rafRef = useRef(0);
  const bgColorRef = useRef(BG_FALLBACK);
  const loadMoreFiredAtRef = useRef(-1);

  const [size, setSize] = useState({ width: 0, height: 0 });
  const [range, setRange] = useState({ start: 0, end: 0 });

  const rows = data.rows;
  const rowCount = rows.length;
  const graphWidth = graphColumnWidth(data.laneCount);
  const totalHeight = rowCount * ROW_HEIGHT;

  // 부모 콜백이 매 렌더 새로 만들어져도 Row의 memo가 깨지지 않게 고정 참조로 감싼다
  const onSelectRef = useRef(onSelect);
  useEffect(() => {
    onSelectRef.current = onSelect;
  }, [onSelect]);
  const handleSelect = useCallback((sha: string) => onSelectRef.current(sha), []);

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) {
      return;
    }
    drawGraph(canvas, {
      rows,
      scrollTop: scrollTopRef.current,
      width: graphWidth,
      height: size.height,
      devicePixelRatio: window.devicePixelRatio || 1,
      bgColor: bgColorRef.current,
    });
  }, [rows, graphWidth, size.height]);

  const syncRange = useCallback(() => {
    if (size.height <= 0) {
      return;
    }
    const first = Math.max(0, Math.floor(scrollTopRef.current / ROW_HEIGHT) - OVERSCAN_ROWS);
    const visible = Math.ceil(size.height / ROW_HEIGHT);
    const last = Math.min(rowCount, first + visible + OVERSCAN_ROWS * 2);
    setRange((prev) => (prev.start === first && prev.end === last ? prev : { start: first, end: last }));
  }, [size.height, rowCount]);

  // 뷰포트 크기 추적 + --bg-content 해석값 캐시 (merge 점 내부를 채울 색)
  useLayoutEffect(() => {
    const body = bodyRef.current;
    if (!body) {
      return;
    }
    const readBg = () => {
      const value = getComputedStyle(body).getPropertyValue("--bg-content").trim();
      bgColorRef.current = value || BG_FALLBACK;
    };
    readBg();
    const measure = () => {
      const rect = body.getBoundingClientRect();
      setSize((prev) =>
        Math.abs(prev.width - rect.width) < 0.5 && Math.abs(prev.height - rect.height) < 0.5
          ? prev
          : { width: rect.width, height: rect.height },
      );
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(body);
    return () => observer.disconnect();
  }, []);

  // data 교체(다른 레포 열기 등)로 브라우저가 scrollTop을 클램프했을 수 있으니 실제 값을 다시 읽는다.
  // 스크롤 핸들러 경로에서는 강제 리플로우를 피하려고 ref 값을 그대로 쓴다
  useEffect(() => {
    scrollTopRef.current = scrollRef.current?.scrollTop ?? 0;
    syncRange();
    draw();
  }, [syncRange, draw]);

  useEffect(() => {
    return () => {
      if (rafRef.current) {
        cancelAnimationFrame(rafRef.current);
      }
    };
  }, []);

  // rows가 늘어나면 다음 onLoadMore를 허용한다 (같은 길이에서 중복 호출 금지)
  useEffect(() => {
    if (loadMoreFiredAtRef.current !== rowCount) {
      loadMoreFiredAtRef.current = -1;
    }
  }, [rowCount]);

  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) {
      return;
    }
    scrollTopRef.current = el.scrollTop;
    if (!rafRef.current) {
      rafRef.current = requestAnimationFrame(() => {
        rafRef.current = 0;
        draw();
        syncRange();
      });
    }
    const distanceToBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    if (
      data.hasMore &&
      !loading &&
      distanceToBottom < LOAD_MORE_THRESHOLD_PX &&
      loadMoreFiredAtRef.current !== rowCount
    ) {
      loadMoreFiredAtRef.current = rowCount;
      onLoadMore();
    }
  }, [draw, syncRange, data.hasMore, loading, rowCount, onLoadMore]);

  const visibleRows: ReactNode[] = [];
  for (let i = range.start; i < range.end && i < rowCount; i++) {
    const row = rows[i];
    visibleRows.push(
      <Row
        key={row.sha}
        row={row}
        top={i * ROW_HEIGHT}
        selected={row.sha === selectedSha}
        showTags={showTags}
        graphWidth={graphWidth}
        onSelect={handleSelect}
      />,
    );
  }

  const showFooter = loading || data.hasMore;

  return (
    <div className="gl-root">
      <div className="gl-header">
        <div className="gl-cell" style={{ width: BRANCH_COL_WIDTH }}>
          Branch / Tag
        </div>
        <div className="gl-cell gl-cell-graph" style={{ width: graphWidth }} />
        <div className="gl-cell gl-cell-message">Message</div>
        <div className="gl-cell" style={{ width: AUTHOR_COL_WIDTH }}>
          Author
        </div>
        <div className="gl-cell" style={{ width: SHA_COL_WIDTH }}>
          Sha
        </div>
        <div className="gl-cell" style={{ width: DATE_COL_WIDTH }}>
          Date
        </div>
      </div>

      <div className="gl-body" ref={bodyRef}>
        <canvas
          ref={canvasRef}
          className="gl-canvas"
          style={{ left: BRANCH_COL_WIDTH, width: graphWidth, height: size.height }}
        />
        <div className="gl-scroll" ref={scrollRef} onScroll={handleScroll}>
          {rowCount === 0 ? (
            <div className="gl-empty">{loading ? "Loading…" : "No commits"}</div>
          ) : (
            <div
              className="gl-spacer"
              style={{ height: totalHeight + (showFooter ? FOOTER_HEIGHT : 0) }}
            >
              {visibleRows}
              {showFooter ? (
                <div className="gl-footer" style={{ top: totalHeight, height: FOOTER_HEIGHT }}>
                  {loading ? "Loading more commits…" : "Scroll for more"}
                </div>
              ) : null}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
