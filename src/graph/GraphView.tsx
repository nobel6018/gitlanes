// GitKraken 스타일 커밋 테이블. 가상 스크롤 + 단일 캔버스 그래프.
// 접점 계약: CONTRACTS.md의 "GraphView 컴포넌트" 절. GraphViewProps는 동결이다.
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent, MouseEvent, PointerEvent, ReactNode } from "react";
import { ROW_HEIGHT } from "../constants";
import type { CommitRow, GraphData, StashInfo, WipInfo } from "../types";
import { drawGraph } from "./canvas";
import { buildPseudoLayout } from "./pseudo";
import { buildChildrenMap, buildHighlight } from "./highlight";
import {
  DEFAULT_COLUMNS,
  clampColumnWidth,
  columnStyle,
  loadColumns,
  saveColumns,
} from "./columns";
import type { ColumnKey, ColumnWidths } from "./columns";
import {
  authorColorIndex,
  authorInitials,
  formatDate,
  graphColumnWidth,
  laneColor,
  laneColorAlpha,
} from "./layout";
import { RefPills, refsTitle } from "./RefPills";
import "./graph.css";

export interface GraphViewProps {
  data: GraphData;
  selectedSha: string | null;
  onSelect: (sha: string) => void;
  /** hasMore이고 스크롤이 바닥 근처면 호출 */
  onLoadMore: () => void;
  loading: boolean;
  showTags: boolean;
  /** nonce가 바뀔 때마다 해당 sha 행을 뷰포트 중앙으로 스크롤. 목록에 없으면 무시 */
  scrollTarget: { sha: string; nonce: number } | null;
  /**
   * 커밋 행과 스태시 행 더블클릭 시 sha를 그대로 넘긴다(WIP 행 제외).
   * 의미(체크아웃, 복사 등)는 shell이 정한다. onSelect 2회와 함께 발생한다
   */
  onRowDoubleClick?: (sha: string) => void;
  /** 커밋/스태시 행 우클릭. 브라우저 기본 메뉴는 GraphView가 preventDefault */
  onRowContextMenu?: (sha: string, clientX: number, clientY: number) => void;
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
  /** pill 넘침 판정용. 드래그가 끝난 뒤에만 갱신돼서 드래그 중 memo가 유지된다 */
  branchWidth: number;
  /** 경로 강조 집합 밖이면 true */
  dimmed: boolean;
  onSelect: (sha: string) => void;
  onDoubleClick: (sha: string) => void;
  onContextMenu: (sha: string, event: MouseEvent<HTMLDivElement>) => void;
}

const Row = memo(function Row({
  row,
  top,
  selected,
  showTags,
  graphWidth,
  branchWidth,
  dimmed,
  onSelect,
  onDoubleClick,
  onContextMenu,
}: RowProps) {
  const className =
    "gl-row" +
    (selected ? " gl-row-selected" : "") +
    (row.isHead ? " gl-row-head" : "") +
    (dimmed ? " gl-row-dim" : "");
  const avatarColor = authorColorIndex(row.authorEmail);
  return (
    <div
      className={className}
      style={{ top, height: ROW_HEIGHT }}
      onClick={() => onSelect(row.sha)}
      onDoubleClick={() => onDoubleClick(row.sha)}
      onContextMenu={(event) => onContextMenu(row.sha, event)}
    >
      <div className="gl-cell gl-col-branch gl-cell-branch" title={refsTitle(row.refs, showTags)}>
        <RefPills
          refs={row.refs}
          laneColor={laneColor(row.color)}
          showTags={showTags}
          branchWidth={branchWidth}
        />
      </div>
      <div className="gl-cell gl-cell-graph" style={{ width: graphWidth }} />
      <div className="gl-cell gl-cell-message" title={row.subject}>
        {row.subject}
      </div>
      <div className="gl-cell gl-col-author gl-cell-author" title={row.author}>
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
      <div className="gl-cell gl-col-sha gl-cell-sha">
        {row.shortSha.slice(0, SHA_DISPLAY_LENGTH)}
      </div>
      <div className="gl-cell gl-col-date gl-cell-date">
        {formatDate(row.timestamp)}
      </div>
    </div>
  );
});

/** 커밋이 아닌 의사 행이라 선택/클릭이 없다. 가상 스크롤 인덱스에는 포함된다 */
function WipRow({
  wip,
  top,
  graphWidth,
  dimmed,
}: {
  wip: WipInfo;
  top: number;
  graphWidth: number;
  dimmed: boolean;
}) {
  return (
    <div
      className={"gl-row gl-row-pseudo gl-row-wip" + (dimmed ? " gl-row-dim" : "")}
      style={{ top, height: ROW_HEIGHT }}
    >
      <div className="gl-cell gl-col-branch" />
      <div className="gl-cell gl-cell-graph" style={{ width: graphWidth }} />
      <div className="gl-cell gl-cell-message">
        {`// WIP \u2014 ${wip.changedFiles} changed files (${wip.stagedFiles} staged)`}
      </div>
      <div className="gl-cell gl-col-author" />
      <div className="gl-cell gl-col-sha" />
      <div className="gl-cell gl-col-date" />
    </div>
  );
}

/** 스태시 의사 행. 실존 커밋이라 클릭해서 상세를 볼 수 있다 */
function StashRow({
  stash,
  top,
  selected,
  graphWidth,
  dimmed,
  onSelect,
  onDoubleClick,
  onContextMenu,
}: {
  stash: StashInfo;
  top: number;
  selected: boolean;
  graphWidth: number;
  dimmed: boolean;
  onSelect: (sha: string) => void;
  onDoubleClick: (sha: string) => void;
  onContextMenu: (sha: string, event: MouseEvent<HTMLDivElement>) => void;
}) {
  return (
    <div
      className={
        "gl-row gl-row-pseudo" +
        (selected ? " gl-row-selected" : "") +
        (dimmed ? " gl-row-dim" : "")
      }
      style={{ top, height: ROW_HEIGHT }}
      onClick={() => onSelect(stash.sha)}
      onDoubleClick={() => onDoubleClick(stash.sha)}
      onContextMenu={(event) => onContextMenu(stash.sha, event)}
    >
      <div className="gl-cell gl-col-branch" />
      <div className="gl-cell gl-cell-graph" style={{ width: graphWidth }} />
      <div className="gl-cell gl-cell-message" title={stash.message}>
        {`\u2261 ${stash.message}`}
      </div>
      <div className="gl-cell gl-col-author" />
      <div className="gl-cell gl-col-sha gl-cell-sha">
        {stash.shortSha.slice(0, SHA_DISPLAY_LENGTH)}
      </div>
      <div className="gl-cell gl-col-date gl-cell-date">
        {formatDate(stash.timestamp)}
      </div>
    </div>
  );
}

/**
 * 컬럼 경계 드래그 핸들. MESSAGE가 flex라 BRANCH는 오른쪽 경계를,
 * AUTHOR/SHA/DATE는 왼쪽 경계를 잡는다. 어느 쪽이든 MESSAGE 반대 방향으로 끌면 넓어진다.
 */
function Resizer({
  column,
  side,
  active,
  onStart,
  onReset,
}: {
  column: ColumnKey;
  side: "left" | "right";
  active: boolean;
  onStart: (column: ColumnKey, side: "left" | "right", event: PointerEvent<HTMLDivElement>) => void;
  onReset: (column: ColumnKey) => void;
}) {
  return (
    <div
      className={
        `gl-resizer gl-resizer-${side}` + (active ? " gl-resizer-active" : "")
      }
      onPointerDown={(event) => onStart(column, side, event)}
      onDoubleClick={() => onReset(column)}
    />
  );
}

export function GraphView({
  data,
  selectedSha,
  onSelect,
  onLoadMore,
  loading,
  showTags,
  scrollTarget,
  onRowDoubleClick,
  onRowContextMenu,
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
  /** 스크롤바가 차지하는 실제 폭. macOS 오버레이 스크롤바면 0이라 헤더가 그대로다 */
  const [scrollbarWidth, setScrollbarWidth] = useState(0);

  const [columns, setColumns] = useState<ColumnWidths>(loadColumns);
  const [resizing, setResizing] = useState<ColumnKey | null>(null);
  /**
   * pill 넘침 판정에 쓰는 BRANCH 폭. 드래그가 끝날 때만 갱신한다.
   * 매 프레임 갱신하면 Row prop이 바뀌어 memo가 깨지고 보이는 행 전부가 리렌더된다
   */
  const [pillBranchWidth, setPillBranchWidth] = useState(columns.branch);
  const dragRef = useRef<{ column: ColumnKey; startX: number; startWidth: number; sign: number } | null>(
    null,
  );
  // 포인터 이벤트에서 동기적으로 읽고 쓰는 최신 폭. setColumns의 커밋을 기다리지 않는다
  const columnsRef = useRef(columns);

  const applyColumns = useCallback((next: ColumnWidths) => {
    columnsRef.current = next;
    setColumns(next);
  }, []);

  const startResize = useCallback(
    (column: ColumnKey, side: "left" | "right", event: PointerEvent<HTMLDivElement>) => {
      event.preventDefault();
      event.stopPropagation();
      dragRef.current = {
        column,
        startX: event.clientX,
        startWidth: columnsRef.current[column],
        // 왼쪽 경계는 끌수록 폭이 늘어야 하므로 부호를 뒤집는다
        sign: side === "right" ? 1 : -1,
      };
      event.currentTarget.setPointerCapture(event.pointerId);
      setResizing(column);
    },
    [],
  );

  const resetColumn = useCallback(
    (column: ColumnKey) => {
      dragRef.current = null;
      setResizing(null);
      const next = { ...columnsRef.current, [column]: DEFAULT_COLUMNS[column] };
      applyColumns(next);
      saveColumns(next);
      setPillBranchWidth(next.branch);
    },
    [applyColumns],
  );

  // 포인터가 헤더 밖으로 나가도 드래그가 이어지도록 window에서 받는다
  useEffect(() => {
    if (resizing === null) {
      return;
    }
    const onMove = (event: globalThis.PointerEvent) => {
      const drag = dragRef.current;
      if (!drag) {
        return;
      }
      const width = clampColumnWidth(drag.startWidth + drag.sign * (event.clientX - drag.startX));
      if (columnsRef.current[drag.column] !== width) {
        applyColumns({ ...columnsRef.current, [drag.column]: width });
      }
    };
    const onUp = () => {
      dragRef.current = null;
      setResizing(null);
      saveColumns(columnsRef.current);
      setPillBranchWidth(columnsRef.current.branch);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
  }, [resizing, applyColumns]);

  const measure = useCallback(() => {
    const body = bodyRef.current;
    if (body) {
      const rect = body.getBoundingClientRect();
      setSize((prev) =>
        Math.abs(prev.width - rect.width) < 0.5 && Math.abs(prev.height - rect.height) < 0.5
          ? prev
          : { width: rect.width, height: rect.height },
      );
    }
    const scroller = scrollRef.current;
    if (scroller) {
      const bar = scroller.offsetWidth - scroller.clientWidth;
      setScrollbarWidth((prev) => (prev === bar ? prev : bar));
    }
  }, []);
  const [range, setRange] = useState({ start: 0, end: 0 });

  const rows = data.rows;
  const rowCount = rows.length;
  const graphWidth = graphColumnWidth(data.laneCount);

  // 의사 행(WIP, 스태시)이 끼면 아래 커밋 행들의 화면 위치가 그만큼 밀린다.
  // 좌표 계산은 전부 화면 행 인덱스(display index) 기준이고 매핑은 pseudo.ts가 쥔다
  const shaToRow = useMemo(() => {
    const map = new Map<string, number>();
    for (let i = 0; i < rows.length; i++) {
      map.set(rows[i].sha, i);
    }
    return map;
  }, [rows]);

  const layout = useMemo(
    () => buildPseudoLayout(rows, data.wip, data.stashes, shaToRow),
    [rows, data.wip, data.stashes, shaToRow],
  );
  const { displayCount, toDisplay, toRowIndex, pseudoAt } = layout;

  // 경로 강조. 자식 맵은 rows에서 1회만 만들고, 집합은 선택이 바뀔 때만 다시 판다
  const childrenMap = useMemo(() => buildChildrenMap(rows), [rows]);
  const highlight = useMemo(
    () => buildHighlight(rows, shaToRow, childrenMap, selectedSha),
    [rows, shaToRow, childrenMap, selectedSha],
  );
  const isDimmed = useCallback(
    (rowIndex: number) => highlight !== null && highlight[rowIndex] !== 1,
    [highlight],
  );
  const totalHeight = displayCount * ROW_HEIGHT;

  // 부모 콜백이 매 렌더 새로 만들어져도 Row의 memo가 깨지지 않게 고정 참조로 감싼다
  const onSelectRef = useRef(onSelect);
  useEffect(() => {
    onSelectRef.current = onSelect;
  }, [onSelect]);
  const handleSelect = useCallback((sha: string) => onSelectRef.current(sha), []);

  const onDoubleClickRef = useRef(onRowDoubleClick);
  useEffect(() => {
    onDoubleClickRef.current = onRowDoubleClick;
  }, [onRowDoubleClick]);
  const handleDoubleClick = useCallback((sha: string) => {
    onDoubleClickRef.current?.(sha);
  }, []);

  const onContextMenuRef = useRef(onRowContextMenu);
  useEffect(() => {
    onContextMenuRef.current = onRowContextMenu;
  }, [onRowContextMenu]);
  // 핸들러가 없으면 기본 메뉴를 막지 않는다
  const handleContextMenu = useCallback((sha: string, event: MouseEvent<HTMLDivElement>) => {
    const handler = onContextMenuRef.current;
    if (!handler) {
      return;
    }
    event.preventDefault();
    onSelectRef.current(sha);
    handler(sha, event.clientX, event.clientY);
  }, []);

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) {
      return;
    }
    drawGraph(canvas, {
      rows,
      layout,
      highlight,
      scrollTop: scrollTopRef.current,
      width: graphWidth,
      height: size.height,
      devicePixelRatio: window.devicePixelRatio || 1,
      bgColor: bgColorRef.current,
    });
  }, [rows, layout, highlight, graphWidth, size.height]);

  const syncRange = useCallback(() => {
    if (size.height <= 0) {
      return;
    }
    const first = Math.max(0, Math.floor(scrollTopRef.current / ROW_HEIGHT) - OVERSCAN_ROWS);
    const visible = Math.ceil(size.height / ROW_HEIGHT);
    const last = Math.min(displayCount, first + visible + OVERSCAN_ROWS * 2);
    setRange((prev) => (prev.start === first && prev.end === last ? prev : { start: first, end: last }));
  }, [size.height, displayCount]);

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
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(body);
    return () => observer.disconnect();
  }, [measure]);

  // 행 수가 변하면 스크롤바가 생기거나 사라진다. 헤더 패딩을 다시 맞춘다
  useEffect(() => {
    measure();
  }, [measure, displayCount]);

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

  /** 화면 행 하나가 보이도록 스크롤. mode="center"면 뷰포트 중앙에 놓는다 */
  const scrollToDisplayIndex = useCallback(
    (displayIndex: number, mode: "center" | "nearest") => {
      const el = scrollRef.current;
      if (!el) {
        return;
      }
      const top = displayIndex * ROW_HEIGHT;
      const viewH = el.clientHeight;
      let next = el.scrollTop;
      if (mode === "center") {
        next = top - (viewH - ROW_HEIGHT) / 2;
      } else if (top < el.scrollTop) {
        next = top;
      } else if (top + ROW_HEIGHT > el.scrollTop + viewH) {
        next = top + ROW_HEIGHT - viewH;
      } else {
        return;
      }
      const max = Math.max(0, el.scrollHeight - viewH);
      el.scrollTop = Math.max(0, Math.min(next, max));
      // 프로그램 스크롤도 scroll 이벤트를 내지만, 같은 프레임에 캔버스를 맞춰둔다
      scrollTopRef.current = el.scrollTop;
      draw();
      syncRange();
    },
    [draw, syncRange],
  );

  // scrollTarget: nonce가 바뀐 순간에만 반응한다. 같은 nonce로 rows만 갱신되면 무시
  const lastNonceRef = useRef<number | null>(null);
  useEffect(() => {
    if (!scrollTarget || scrollTarget.nonce === lastNonceRef.current) {
      return;
    }
    lastNonceRef.current = scrollTarget.nonce;
    const index = shaToRow.get(scrollTarget.sha);
    if (index !== undefined) {
      scrollToDisplayIndex(toDisplay(index), "center");
      return;
    }
    // 커밋 행에 없으면 스태시 의사 행을 찾아본다
    const pseudo = layout.pseudos.find(
      (item) => item.kind === "stash" && item.stash.sha === scrollTarget.sha,
    );
    if (pseudo) {
      scrollToDisplayIndex(pseudo.displayIndex, "center");
    }
  }, [scrollTarget, shaToRow, layout, toDisplay, scrollToDisplayIndex]);

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      if (event.key !== "ArrowDown" && event.key !== "ArrowUp") {
        return;
      }
      event.preventDefault();
      if (rowCount === 0) {
        return;
      }
      const step = event.key === "ArrowDown" ? 1 : -1;

      // 현재 선택 위치를 화면 행 인덱스로 옮긴다. 스태시가 선택돼 있으면 그 의사 행에서 출발
      let from = -1;
      if (selectedSha !== null) {
        const rowIndex = shaToRow.get(selectedSha);
        if (rowIndex !== undefined) {
          from = toDisplay(rowIndex);
        } else {
          const pseudo = layout.pseudos.find(
            (item) => item.kind === "stash" && item.stash.sha === selectedSha,
          );
          from = pseudo ? pseudo.displayIndex : -1;
        }
      }
      if (from < 0) {
        onSelectRef.current(rows[0].sha);
        scrollToDisplayIndex(toDisplay(0), "nearest");
        return;
      }

      // 의사 행(WIP, 스태시)은 건너뛰고 다음 커밋 행으로 간다
      for (let next = from + step; next >= 0 && next < displayCount; next += step) {
        if (pseudoAt(next)) {
          continue;
        }
        onSelectRef.current(rows[toRowIndex(next)].sha);
        scrollToDisplayIndex(next, "nearest");
        return;
      }
    },
    [
      rows,
      rowCount,
      selectedSha,
      shaToRow,
      layout,
      displayCount,
      toDisplay,
      toRowIndex,
      pseudoAt,
      scrollToDisplayIndex,
    ],
  );

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
  for (let d = range.start; d < range.end && d < displayCount; d++) {
    const pseudo = pseudoAt(d);
    if (pseudo) {
      const top = d * ROW_HEIGHT;
      visibleRows.push(
        pseudo.kind === "stash" ? (
          <StashRow
            key={pseudo.key}
            stash={pseudo.stash}
            top={top}
            selected={pseudo.stash.sha === selectedSha}
            graphWidth={graphWidth}
            dimmed={isDimmed(pseudo.anchorRow)}
            onSelect={handleSelect}
            onDoubleClick={handleDoubleClick}
            onContextMenu={handleContextMenu}
          />
        ) : (
          <WipRow
            key={pseudo.key}
            wip={pseudo.wip}
            top={top}
            graphWidth={graphWidth}
            dimmed={rowCount > 0 && isDimmed(pseudo.anchorRow)}
          />
        ),
      );
      continue;
    }
    const rowIndex = toRowIndex(d);
    const row = rows[rowIndex];
    visibleRows.push(
      <Row
        key={row.sha}
        row={row}
        top={d * ROW_HEIGHT}
        selected={row.sha === selectedSha}
        showTags={showTags}
        graphWidth={graphWidth}
        branchWidth={pillBranchWidth}
        dimmed={isDimmed(rowIndex)}
        onSelect={handleSelect}
        onDoubleClick={handleDoubleClick}
        onContextMenu={handleContextMenu}
      />,
    );
  }

  const showFooter = loading || data.hasMore;

  return (
    <div
      className={"gl-root" + (resizing !== null ? " gl-root-resizing" : "")}
      style={columnStyle(columns)}
    >
      <div className="gl-header" style={{ paddingRight: scrollbarWidth }}>
        <div className="gl-cell gl-col-branch">
          Branch / Tag
          <Resizer column="branch" side="right" active={resizing === "branch"} onStart={startResize} onReset={resetColumn} />
        </div>
        <div className="gl-cell gl-cell-graph" style={{ width: graphWidth }} />
        <div className="gl-cell gl-cell-message">Message</div>
        <div className="gl-cell gl-col-author">
          <Resizer column="author" side="left" active={resizing === "author"} onStart={startResize} onReset={resetColumn} />
          Author
        </div>
        <div className="gl-cell gl-col-sha">
          <Resizer column="sha" side="left" active={resizing === "sha"} onStart={startResize} onReset={resetColumn} />
          Sha
        </div>
        <div className="gl-cell gl-col-date">
          <Resizer column="date" side="left" active={resizing === "date"} onStart={startResize} onReset={resetColumn} />
          Date
        </div>
      </div>

      <div className="gl-body" ref={bodyRef}>
        <canvas
          ref={canvasRef}
          className="gl-canvas"
          style={{ left: columns.branch, width: graphWidth, height: size.height }}
        />
        <div
          className="gl-scroll"
          ref={scrollRef}
          tabIndex={0}
          onScroll={handleScroll}
          onKeyDown={handleKeyDown}
        >
          {displayCount === 0 ? (
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
