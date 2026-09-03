// GitKraken 스타일 커밋 테이블. 가상 스크롤 + 단일 캔버스 그래프.
// 접점 계약: CONTRACTS.md의 "GraphView 컴포넌트" 절. GraphViewProps는 동결이다.
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent, MouseEvent, PointerEvent, ReactNode } from "react";
import { ROW_HEIGHT, WIP_SHA } from "../constants";
import type { CommitRow, GraphData, StashInfo, WipInfo } from "../types";
import { drawGraph } from "./canvas";
import { buildPseudoLayout } from "./pseudo";
import { buildChildrenMap, buildHighlight } from "./highlight";
import {
  COLUMN_FLAG,
  DEFAULT_COLUMNS,
  clampColumnWidth,
  columnStyle,
  fitColumns,
  loadColumns,
  saveColumns,
} from "./columns";
import type { ColumnKey, ColumnWidths } from "./columns";
import {
  authorColorIndex,
  authorInitials,
  formatDate,
  formatRelativeDate,
  graphColumnWidth,
  laneColor,
  laneColorAlpha,
} from "./layout";
import type { DateMode } from "./layout";
import { highlightText } from "./mark";
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
  /** 검색어. 있으면 MESSAGE/AUTHOR/SHA 셀에서 대소문자 무시 매치 구간을 <mark>로 강조 */
  highlightQuery?: string;
  /** 날짜 표시 모드. 기본 "absolute" */
  dateMode?: DateMode;
  /**
   * 미사용. dateMode 토글은 Preferences로 옮겼고 DATE 헤더는 일반 라벨이다.
   * 기존 호출부가 계속 넘겨도 깨지지 않게 시그니처만 남긴다
   */
  onToggleDateMode?: () => void;
  /**
   * WIP 의사 행 선택. 핸들러가 없으면 WIP 행은 예전처럼 클릭 불가로 남는다.
   * shell은 이 콜백에서 selectedSha를 WIP_SHA로 바꾼다
   */
  onSelectWip?: () => void;
  /**
   * hover 시 부모/자식 경로 강조. selectedSha가 null일 때만 동작하고
   * undefined/false면 강조하지 않는다 (선택 강조가 항상 우선)
   */
  hoverHighlight?: boolean;
}

/** 보이는 범위 위아래로 더 그려두는 행 수 */
const OVERSCAN_ROWS = 10;
/** 바닥에서 이 거리 안으로 들어오면 onLoadMore() */
const LOAD_MORE_THRESHOLD_PX = 300;
/** SHA 컬럼에 표시할 자릿수 (shortSha는 10자) */
const SHA_DISPLAY_LENGTH = 8;
const FOOTER_HEIGHT = 24;
/**
 * hover 강조를 적용하기까지 커서가 같은 행에 머물러야 하는 시간(ms).
 * 스쳐 지나가는 행마다 강조가 바뀌는 산만함을 막는 hover intent 지연.
 */
const HOVER_DELAY_MS = 120;
/** theme.css를 못 읽는 환경(단독 테스트 등)에서만 쓰이는 --bg-content 기본값 */
const BG_FALLBACK = "#1C1E23";

/**
 * 드롭된 컬럼의 정보는 항상 보이는 MESSAGE 셀 툴팁으로 흘려준다.
 * hiddenMask가 0이면 subject만 반환해 문자열 조립을 건너뛴다.
 */
function messageTitle(
  subject: string,
  hiddenMask: number,
  parts: { branch?: string; author?: string; sha?: string; date?: string },
): string {
  if (hiddenMask === 0) {
    return subject;
  }
  const lines = [subject];
  if (hiddenMask & COLUMN_FLAG.branch && parts.branch) {
    lines.push(parts.branch);
  }
  if (hiddenMask & COLUMN_FLAG.author && parts.author) {
    lines.push(parts.author);
  }
  if (hiddenMask & COLUMN_FLAG.sha && parts.sha) {
    lines.push(parts.sha);
  }
  if (hiddenMask & COLUMN_FLAG.date && parts.date) {
    lines.push(parts.date);
  }
  return lines.join("\n");
}

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
  /** 폭이 부족해 드롭된 컬럼 비트마스크. 원시값이라 memo가 유지된다 */
  hiddenMask: number;
  /** 검색어. 빈 문자열이면 강조 없이 원본 문자열을 그대로 렌더한다 */
  highlightQuery: string;
  dateMode: DateMode;
  /** 상대 시간 기준 시각(ms). 분 단위로 양자화돼 있어 스크롤 중 memo를 깨지 않는다 */
  nowMs: number;
  onSelect: (sha: string) => void;
  onDoubleClick: (sha: string) => void;
  onContextMenu: (sha: string, event: MouseEvent<HTMLDivElement>) => void;
  /** hover 강조 기준 커밋 보고. 같은 행이면 GraphView가 재계산 없이 버린다 */
  onHover: (sha: string, ancestorsOnly: boolean) => void;
}

const Row = memo(function Row({
  row,
  top,
  selected,
  showTags,
  graphWidth,
  branchWidth,
  dimmed,
  hiddenMask,
  highlightQuery,
  dateMode,
  nowMs,
  onSelect,
  onDoubleClick,
  onContextMenu,
  onHover,
}: RowProps) {
  const className =
    "gl-row" +
    (selected ? " gl-row-selected" : "") +
    (row.isHead ? " gl-row-head" : "") +
    (dimmed ? " gl-row-dim" : "");
  const avatarColor = authorColorIndex(row.authorEmail);
  const refsLabel = refsTitle(row.refs, showTags);
  const shortSha = row.shortSha.slice(0, SHA_DISPLAY_LENGTH);
  const date =
    dateMode === "relative" ? formatRelativeDate(row.timestamp, nowMs) : formatDate(row.timestamp);
  return (
    <div
      className={className}
      style={{ top, height: ROW_HEIGHT }}
      onClick={() => onSelect(row.sha)}
      onDoubleClick={() => onDoubleClick(row.sha)}
      onContextMenu={(event) => onContextMenu(row.sha, event)}
      // enter만으로는 커서가 멈춘 사이 가상 스크롤로 행이 바뀐 경우를 놓친다
      onMouseEnter={() => onHover(row.sha, false)}
      onMouseMove={() => onHover(row.sha, false)}
    >
      <div className="gl-cell gl-col-branch gl-cell-branch" title={refsLabel}>
        {/* 드롭된 컬럼은 display:none이지만 DOM에는 남으므로 pill 실측까지 건너뛴다 */}
        {hiddenMask & COLUMN_FLAG.branch ? null : (
          <RefPills
            refs={row.refs}
            laneColor={laneColor(row.color)}
            showTags={showTags}
            branchWidth={branchWidth}
          />
        )}
      </div>
      <div className="gl-cell gl-cell-graph" style={{ width: graphWidth }} />
      <div
        className="gl-cell gl-cell-message"
        title={messageTitle(row.subject, hiddenMask, {
          branch: refsLabel,
          author: row.author,
          sha: shortSha,
          date,
        })}
      >
        {highlightText(row.subject, highlightQuery)}
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
        <span className="gl-author-name">{highlightText(row.author, highlightQuery)}</span>
      </div>
      <div className="gl-cell gl-col-sha gl-cell-sha">
        {highlightText(shortSha, highlightQuery)}
      </div>
      <div className="gl-cell gl-col-date gl-cell-date">{date}</div>
    </div>
  );
});

/**
 * 커밋이 아닌 의사 행이지만 워킹 트리 변경 상세가 있어 선택할 수 있다.
 * onSelect가 없으면(shell이 배선하지 않으면) 클릭도 hover 강조도 없는 예전 동작이다.
 */
function WipRow({
  wip,
  top,
  selected,
  graphWidth,
  dimmed,
  onSelect,
  onHover,
}: {
  wip: WipInfo;
  top: number;
  selected: boolean;
  graphWidth: number;
  dimmed: boolean;
  onSelect?: () => void;
  onHover: () => void;
}) {
  return (
    <div
      className={
        "gl-row gl-row-pseudo gl-row-wip" +
        (onSelect ? " gl-row-wip-clickable" : "") +
        (selected ? " gl-row-selected" : "") +
        (dimmed ? " gl-row-dim" : "")
      }
      style={{ top, height: ROW_HEIGHT }}
      onClick={onSelect}
      onMouseEnter={onHover}
      onMouseMove={onHover}
    >
      <div className="gl-cell gl-col-branch" />
      <div className="gl-cell gl-cell-graph" style={{ width: graphWidth }} />
      <div className="gl-cell gl-cell-message gl-wip-message">
        <span className="gl-wip-label">// WIP</span>
        <span className="gl-wip-badge">
          {`${wip.changedFiles} changed file${wip.changedFiles === 1 ? "" : "s"}`}
        </span>
        {wip.stagedFiles > 0 ? (
          <span className="gl-wip-staged">{`${wip.stagedFiles} staged`}</span>
        ) : null}
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
  hiddenMask,
  highlightQuery,
  dateMode,
  nowMs,
  onSelect,
  onDoubleClick,
  onContextMenu,
  onHover,
}: {
  stash: StashInfo;
  top: number;
  selected: boolean;
  graphWidth: number;
  dimmed: boolean;
  hiddenMask: number;
  highlightQuery: string;
  dateMode: DateMode;
  nowMs: number;
  onSelect: (sha: string) => void;
  onDoubleClick: (sha: string) => void;
  onContextMenu: (sha: string, event: MouseEvent<HTMLDivElement>) => void;
  onHover: () => void;
}) {
  const shortSha = stash.shortSha.slice(0, SHA_DISPLAY_LENGTH);
  const date =
    dateMode === "relative"
      ? formatRelativeDate(stash.timestamp, nowMs)
      : formatDate(stash.timestamp);
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
      onMouseEnter={onHover}
      onMouseMove={onHover}
    >
      <div className="gl-cell gl-col-branch" />
      <div className="gl-cell gl-cell-graph" style={{ width: graphWidth }} />
      <div
        className="gl-cell gl-cell-message"
        title={messageTitle(stash.message, hiddenMask, {
          sha: shortSha,
          date,
        })}
      >
        {"\u2261 "}
        {highlightText(stash.message, highlightQuery)}
      </div>
      <div className="gl-cell gl-col-author" />
      <div className="gl-cell gl-col-sha gl-cell-sha">
        {highlightText(shortSha, highlightQuery)}
      </div>
      <div className="gl-cell gl-col-date gl-cell-date">{date}</div>
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
    >
      {/* 가이드 선. 헤더를 넘어 커밋 목록 높이까지 내려가고 포인터는 받지 않는다 */}
      <span className="gl-resizer-line" />
    </div>
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
  highlightQuery = "",
  dateMode = "absolute",
  onSelectWip,
  hoverHighlight,
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
  /** 화면에 실제로 적용된 폭. 드래그는 보이는 값에서 시작해야 손이 튀지 않는다 */
  const effectiveRef = useRef(columns);

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
        startWidth: effectiveRef.current[column],
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

  // 상대 시간 기준 시각. 렌더당 Date.now()를 1회만 읽되 분 단위로 잘라 Row에 내려보낸다.
  // 원시값을 그대로 흘리면 스크롤 리렌더마다 값이 달라져 보이는 행 전부의 memo가 깨진다
  const nowMs = Math.floor(Date.now() / 60_000) * 60_000;

  // 컨테이너에 컬럼을 맞춘다. 행이 놓이는 실제 폭은 스크롤바를 뺀 값이고,
  // 헤더는 같은 만큼 오른쪽 패딩을 받으므로 둘의 컬럼 위치가 일치한다
  const layoutWidth = Math.max(0, size.width - scrollbarWidth);
  const fit = useMemo(
    () =>
      fitColumns(
        layoutWidth,
        columns,
        graphColumnWidth(data.laneCount),
        graphColumnWidth(1),
      ),
    [layoutWidth, columns, data.laneCount],
  );
  const graphWidth = fit.graphWidth;
  const hiddenMask = fit.hiddenMask;
  const hideClass =
    (hiddenMask & COLUMN_FLAG.branch ? " gl-hide-branch" : "") +
    (hiddenMask & COLUMN_FLAG.author ? " gl-hide-author" : "") +
    (hiddenMask & COLUMN_FLAG.sha ? " gl-hide-sha" : "") +
    (hiddenMask & COLUMN_FLAG.date ? " gl-hide-date" : "");

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

  /** WIP 의사 행의 화면 행 인덱스. 없으면 -1 */
  const wipDisplayIndex = useMemo(() => {
    const wipPseudo = layout.pseudos.find((item) => item.kind === "wip");
    return wipPseudo ? wipPseudo.displayIndex : -1;
  }, [layout]);
  const wipSelected = selectedSha === WIP_SHA && wipDisplayIndex >= 0;

  /**
   * hover 강조 기준. ancestorsOnly는 의사 행(WIP, 스태시) hover 때 켜진다.
   * 앵커 커밋의 자손은 스태시/WIP의 자손이 아니라 밝히면 거짓 경로가 된다
   */
  const [hovered, setHovered] = useState<{ sha: string; ancestorsOnly: boolean } | null>(null);
  // 같은 행 위에서 mousemove가 계속 들어오므로 setState 이전에 ref로 먼저 걸러낸다
  const hoveredRef = useRef(hovered);

  /** 타이머 만료를 기다리는 행. 아직 강조에 반영되지 않았다 */
  const hoverPendingRef = useRef<{ sha: string; ancestorsOnly: boolean } | null>(null);
  const hoverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const cancelHoverTimer = useCallback(() => {
    if (hoverTimerRef.current !== null) {
      clearTimeout(hoverTimerRef.current);
      hoverTimerRef.current = null;
    }
    hoverPendingRef.current = null;
  }, []);

  // hover 강조는 선택이 없을 때만 쓴다. 선택이 생기면 그 즉시 hover 기준을 버린다
  const hoverActive = hoverHighlight === true && selectedSha === null;
  const hoverActiveRef = useRef(hoverActive);
  useEffect(() => {
    hoverActiveRef.current = hoverActive;
    if (!hoverActive) {
      cancelHoverTimer();
      hoveredRef.current = null;
      setHovered(null);
    }
  }, [hoverActive, cancelHoverTimer]);

  // 언마운트 시 대기 중인 타이머가 남아 setState를 부르지 않게 정리한다
  useEffect(() => cancelHoverTimer, [cancelHoverTimer]);

  /**
   * hover intent: 행에 들어와도 바로 강조하지 않고 HOVER_DELAY_MS 뒤에 반영한다.
   * 기다리는 동안 이전 강조는 그대로 두고(깜빡임 방지), 다른 행으로 넘어가면 타이머를 다시 건다.
   */
  const handleHover = useCallback(
    (sha: string, ancestorsOnly: boolean) => {
      if (!hoverActiveRef.current) {
        return;
      }
      const applied = hoveredRef.current;
      if (applied !== null && applied.sha === sha && applied.ancestorsOnly === ancestorsOnly) {
        // 이미 강조된 행으로 되돌아왔다. 다른 행으로 넘어가려던 예약은 취소한다
        cancelHoverTimer();
        return;
      }
      const pending = hoverPendingRef.current;
      // 같은 행 위의 mousemove로 타이머를 리셋하면 커서가 미세하게 흔들리는 동안 영원히 만료되지 않는다
      if (pending !== null && pending.sha === sha && pending.ancestorsOnly === ancestorsOnly) {
        return;
      }
      cancelHoverTimer();
      const next = { sha, ancestorsOnly };
      hoverPendingRef.current = next;
      hoverTimerRef.current = setTimeout(() => {
        hoverTimerRef.current = null;
        hoverPendingRef.current = null;
        if (!hoverActiveRef.current) {
          return;
        }
        hoveredRef.current = next;
        setHovered(next);
      }, HOVER_DELAY_MS);
    },
    [cancelHoverTimer],
  );

  const clearHover = useCallback(() => {
    cancelHoverTimer();
    if (hoveredRef.current === null) {
      return;
    }
    hoveredRef.current = null;
    setHovered(null);
  }, [cancelHoverTimer]);

  // 경로 강조. 자식 맵은 rows에서 1회만 만들고, 집합은 기준 커밋이 바뀔 때만 다시 판다.
  // WIP은 HEAD의 (아직 없는) 자식이라 HEAD를 기준 삼되 자손 방향은 켜지 않는다
  const childrenMap = useMemo(() => buildChildrenMap(rows), [rows]);
  const headSha = useMemo(() => rows.find((row) => row.isHead)?.sha ?? null, [rows]);
  const hoverSource = hoverActive ? hovered : null;
  const highlightSha =
    selectedSha === WIP_SHA ? headSha : (selectedSha ?? hoverSource?.sha ?? null);
  const ancestorsOnly =
    selectedSha === WIP_SHA || (selectedSha === null && hoverSource?.ancestorsOnly === true);
  const highlight = useMemo(
    () => buildHighlight(rows, shaToRow, childrenMap, highlightSha, !ancestorsOnly),
    [rows, shaToRow, childrenMap, highlightSha, ancestorsOnly],
  );
  const isDimmed = useCallback(
    (rowIndex: number) => highlight !== null && highlight[rowIndex] !== 1,
    [highlight],
  );
  const totalHeight = displayCount * ROW_HEIGHT;

  // 실제 적용 폭을 ref에 남긴다. 드래그 시작값과 pill 재계산이 이 값을 본다
  useEffect(() => {
    effectiveRef.current = fit.widths;
  }, [fit]);

  // pill 넘침 재계산은 드래그가 끝난 뒤에만 한다. 드래그 중 갱신하면 매 프레임
  // 보이는 행 전부가 리렌더된다
  useEffect(() => {
    if (resizing !== null) {
      return;
    }
    setPillBranchWidth(fit.widths.branch);
  }, [resizing, fit.widths.branch]);

  // 부모 콜백이 매 렌더 새로 만들어져도 Row의 memo가 깨지지 않게 고정 참조로 감싼다
  const onSelectRef = useRef(onSelect);
  useEffect(() => {
    onSelectRef.current = onSelect;
  }, [onSelect]);
  const handleSelect = useCallback((sha: string) => onSelectRef.current(sha), []);

  const onSelectWipRef = useRef(onSelectWip);
  useEffect(() => {
    onSelectWipRef.current = onSelectWip;
  }, [onSelectWip]);
  const handleSelectWip = useCallback(() => onSelectWipRef.current?.(), []);

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

  /**
   * 화면 행 하나가 보이도록 스크롤.
   * center는 뷰포트 중앙, top/bottom은 목록 맨 위/맨 아래(Home/End), nearest는 최소 이동.
   */
  const scrollToDisplayIndex = useCallback(
    (displayIndex: number, mode: "center" | "nearest" | "top" | "bottom") => {
      const el = scrollRef.current;
      if (!el) {
        return;
      }
      const top = displayIndex * ROW_HEIGHT;
      const viewH = el.clientHeight;
      let next = el.scrollTop;
      if (mode === "center") {
        next = top - (viewH - ROW_HEIGHT) / 2;
      } else if (mode === "top") {
        next = 0;
      } else if (mode === "bottom") {
        next = el.scrollHeight;
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
    // WIP은 실제 sha가 아니라 목록 맨 위의 의사 행이다
    if (scrollTarget.sha === WIP_SHA) {
      scrollToDisplayIndex(0, "top");
      return;
    }
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

  /** 현재 선택의 화면 행 인덱스. 스태시/WIP가 선택돼 있으면 그 의사 행, 선택이 없으면 -1 */
  const selectedDisplayIndex = useCallback((): number => {
    if (selectedSha === null) {
      return -1;
    }
    if (selectedSha === WIP_SHA) {
      return wipDisplayIndex;
    }
    const rowIndex = shaToRow.get(selectedSha);
    if (rowIndex !== undefined) {
      return toDisplay(rowIndex);
    }
    const pseudo = layout.pseudos.find(
      (item) => item.kind === "stash" && item.stash.sha === selectedSha,
    );
    return pseudo ? pseudo.displayIndex : -1;
  }, [selectedSha, wipDisplayIndex, shaToRow, layout, toDisplay]);

  /** start에서 dir 방향으로 처음 만나는 커밋 행. 의사 행(WIP, 스태시)은 건너뛴다 */
  const findCommitDisplay = useCallback(
    (start: number, dir: number): number => {
      for (let i = start; i >= 0 && i < displayCount; i += dir) {
        if (!pseudoAt(i)) {
          return i;
        }
      }
      return -1;
    },
    [displayCount, pseudoAt],
  );

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      const key = event.key;
      // ⌘↑/⌘↓는 Home/End와 같은 동작이라 화살표 이동보다 먼저 가른다
      const toFirst = key === "Home" || (event.metaKey && key === "ArrowUp");
      const toLast = key === "End" || (event.metaKey && key === "ArrowDown");
      const byPage = key === "PageUp" || key === "PageDown";
      const byStep = !event.metaKey && (key === "ArrowUp" || key === "ArrowDown");
      if (!toFirst && !toLast && !byPage && !byStep) {
        return;
      }
      // 스크롤 컨테이너의 기본 스크롤과 겹치지 않게 항상 막는다
      event.preventDefault();
      if (rowCount === 0) {
        return;
      }

      // WIP 행은 목록 맨 위 커밋보다 위에 있으니 Home의 도착지도 WIP가 우선이다
      const wipSelectable = wipDisplayIndex >= 0 && onSelectWipRef.current !== undefined;
      if (toFirst) {
        if (wipSelectable) {
          onSelectWipRef.current?.();
          // 보통 WIP가 0번 행이라 결과는 맨 위 스크롤과 같다.
          // HEAD가 첫 행이 아닌 레포에서도 선택 행이 화면에 남도록 nearest를 쓴다
          scrollToDisplayIndex(wipDisplayIndex, "nearest");
        } else {
          onSelectRef.current(rows[0].sha);
          scrollToDisplayIndex(toDisplay(0), "top");
        }
        return;
      }
      if (toLast) {
        const last = rowCount - 1;
        onSelectRef.current(rows[last].sha);
        scrollToDisplayIndex(toDisplay(last), "bottom");
        return;
      }

      const step = key === "ArrowDown" || key === "PageDown" ? 1 : -1;
      const from = selectedDisplayIndex();
      if (from < 0) {
        onSelectRef.current(rows[0].sha);
        scrollToDisplayIndex(toDisplay(0), "nearest");
        return;
      }

      // 한 화면은 "뷰포트에 보이는 행 수 - 1"만큼 움직여 앞뒤 문맥이 한 줄 남게 한다
      const perPage = Math.max(1, Math.floor(size.height / ROW_HEIGHT) - 1);
      const target =
        byPage
          ? Math.max(0, Math.min(displayCount - 1, from + step * perPage))
          : from + step;

      // 첫 커밋에서 한 칸 위는 WIP 행이다. 다른 의사 행과 달리 여기서 멈춘다
      if (step === -1 && target === wipDisplayIndex && wipSelectable) {
        onSelectWipRef.current?.();
        scrollToDisplayIndex(wipDisplayIndex, "nearest");
        return;
      }

      let next = findCommitDisplay(target, step);
      // 페이지 이동이 목록 끝의 의사 행 구간에 떨어지면 반대 방향에서 가장 가까운 커밋을 잡는다
      if (next < 0 && byPage) {
        next = findCommitDisplay(target, -step);
      }
      if (next < 0 || next === from) {
        return;
      }
      onSelectRef.current(rows[toRowIndex(next)].sha);
      scrollToDisplayIndex(next, "nearest");
    },
    [
      rows,
      rowCount,
      displayCount,
      size.height,
      wipDisplayIndex,
      toDisplay,
      toRowIndex,
      selectedDisplayIndex,
      findCommitDisplay,
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
            hiddenMask={hiddenMask}
            highlightQuery={highlightQuery}
            dateMode={dateMode}
            nowMs={nowMs}
            onSelect={handleSelect}
            onDoubleClick={handleDoubleClick}
            onContextMenu={handleContextMenu}
            // 스태시 커밋은 로드된 rows에 없으니 앵커 커밋을 기준 삼는다
            onHover={() => handleHover(rows[pseudo.anchorRow].sha, true)}
          />
        ) : (
          <WipRow
            key={pseudo.key}
            wip={pseudo.wip}
            top={top}
            selected={wipSelected}
            graphWidth={graphWidth}
            dimmed={rowCount > 0 && isDimmed(pseudo.anchorRow)}
            onSelect={onSelectWip ? handleSelectWip : undefined}
            // WIP은 HEAD의 자식이라 HEAD(= 앵커 커밋) 조상만 밝힌다
            onHover={() => {
              // 커밋이 하나도 없으면 앵커 커밋이 없어 기준을 잡을 수 없다
              if (rowCount > 0) {
                handleHover(rows[pseudo.anchorRow].sha, true);
              }
            }}
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
        hiddenMask={hiddenMask}
        highlightQuery={highlightQuery}
        dateMode={dateMode}
        nowMs={nowMs}
        onSelect={handleSelect}
        onDoubleClick={handleDoubleClick}
        onContextMenu={handleContextMenu}
        onHover={handleHover}
      />,
    );
  }

  const showFooter = loading || data.hasMore;

  return (
    <div
      className={"gl-root" + (resizing !== null ? " gl-root-resizing" : "") + hideClass}
      style={columnStyle(fit.widths, size.height)}
    >
      <div className="gl-header" style={{ paddingRight: scrollbarWidth }}>
        <div className="gl-cell gl-col-branch">
          <span className="gl-header-label">Branch / Tag</span>
          <Resizer column="branch" side="right" active={resizing === "branch"} onStart={startResize} onReset={resetColumn} />
        </div>
        <div className="gl-cell gl-cell-graph" style={{ width: graphWidth }} />
        <div className="gl-cell gl-cell-message">
          <span className="gl-header-label">Message</span>
        </div>
        <div className="gl-cell gl-col-author">
          <Resizer column="author" side="left" active={resizing === "author"} onStart={startResize} onReset={resetColumn} />
          <span className="gl-header-label">Author</span>
        </div>
        <div className="gl-cell gl-col-sha">
          <Resizer column="sha" side="left" active={resizing === "sha"} onStart={startResize} onReset={resetColumn} />
          <span className="gl-header-label">Sha</span>
        </div>
        <div className="gl-cell gl-col-date">
          <Resizer column="date" side="left" active={resizing === "date"} onStart={startResize} onReset={resetColumn} />
          <span className="gl-header-label">Date</span>
        </div>
      </div>

      <div className="gl-body" ref={bodyRef}>
        <canvas
          ref={canvasRef}
          className="gl-canvas"
          style={{
            left: hiddenMask & COLUMN_FLAG.branch ? 0 : fit.widths.branch,
            width: graphWidth,
            height: size.height,
          }}
        />
        <div
          className="gl-scroll"
          ref={scrollRef}
          tabIndex={0}
          onScroll={handleScroll}
          onKeyDown={handleKeyDown}
          // 그래프 영역을 벗어나면 hover 강조를 즉시 해제한다
          onMouseLeave={clearHover}
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
