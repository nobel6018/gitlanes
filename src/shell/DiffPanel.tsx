// GitKraken 스타일 메인 영역 diff 뷰어. 계약: CONTRACTS.md v0.12 "DiffPanelProps".
// 가상 스크롤(줄 20px) + highlight.js 문법 강조. 상태는 localStorage "gitlanes.diff".
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent, ReactNode } from "react";
import type { FileChange } from "../types";
import { splitPath } from "./format";
import { withKbd } from "./shortcuts";
import { STATUS_ICON } from "./FileRow";
import { highlightLines, languageForPath } from "./highlight";
import "./panels.css";

export interface DiffPanelProps {
  file: FileChange;
  /** unified diff 원문 (get_file_diff). 로딩 중 null */
  diffText: string | null;
  /** 커밋 시점 파일 전문 (get_file_content). File View/split에서만 필요, 미로드 시 null */
  fileText: string | null;
  /** fileText가 필요할 때 셸에 요청 */
  onRequestFileText: () => void;
  loading: boolean;
  error: string | null;
  onClose: () => void;
  /** 파일명 옆 작은 pill (WIP의 "staged"/"unstaged"/"untracked" 등) */
  badge?: string;
}

/** 줄 높이(px). panels.css의 .dp-line 높이와 반드시 일치 */
const LINE_HEIGHT = 20;
/** 보이는 범위 위아래로 더 그려두는 줄 수 */
const OVERSCAN = 30;
/** 이 줄 수를 넘으면 줄바꿈(wrap) 토글을 막는다 (고정 높이 가상 스크롤을 포기할 수 없다) */
const WRAP_LIMIT = 20000;
const PREFS_KEY = "gitlanes.diff";

type ViewMode = "diff" | "file";
type Layout = "unified" | "split";

interface Prefs {
  view: ViewMode;
  layout: Layout;
  wrap: boolean;
}

const DEFAULT_PREFS: Prefs = { view: "diff", layout: "unified", wrap: false };

function readPrefs(): Prefs {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    if (raw === null) {
      return DEFAULT_PREFS;
    }
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) {
      return DEFAULT_PREFS;
    }
    const value = parsed as Partial<Prefs>;
    return {
      view: value.view === "file" ? "file" : "diff",
      layout: value.layout === "split" ? "split" : "unified",
      wrap: value.wrap === true,
    };
  } catch {
    return DEFAULT_PREFS;
  }
}

function writePrefs(prefs: Prefs) {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch {
    // localStorage 실패는 무시 (설정만 휘발)
  }
}

type RowKind = "hunk" | "add" | "del" | "context" | "meta";

interface DiffRow {
  kind: RowKind;
  /** 접두(+/-/공백)를 떼어낸 내용. hunk/meta는 원문 */
  text: string;
  oldNo: number | null;
  newNo: number | null;
}

interface ParsedDiff {
  rows: DiffRow[];
  /** hunk 헤더 행의 rows 인덱스 */
  hunkIndices: number[];
  /** 각 hunk가 시작하는 new 쪽 줄 번호 (File View 점프용) */
  hunkNewStarts: number[];
  /** 추가/변경된 new 쪽 줄 번호 (File View 배경 강조용) */
  changedNewLines: ReadonlySet<number>;
}

const EMPTY_PARSED: ParsedDiff = {
  rows: [],
  hunkIndices: [],
  hunkNewStarts: [],
  changedNewLines: new Set<number>(),
};

function parseDiff(text: string): ParsedDiff {
  const rows: DiffRow[] = [];
  const hunkIndices: number[] = [];
  const hunkNewStarts: number[] = [];
  const changedNewLines = new Set<number>();
  const raw = text.replace(/\r\n/g, "\n").replace(/\n$/, "");
  if (raw === "") {
    return EMPTY_PARSED;
  }

  let oldNo = 0;
  let newNo = 0;
  let started = false;

  for (const line of raw.split("\n")) {
    if (line.startsWith("@@")) {
      const match = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
      oldNo = match === null ? 1 : Number(match[1]);
      newNo = match === null ? 1 : Number(match[2]);
      started = true;
      hunkIndices.push(rows.length);
      hunkNewStarts.push(newNo);
      rows.push({ kind: "hunk", text: line, oldNo: null, newNo: null });
      continue;
    }
    if (!started) {
      // git 헤더(diff --git / index / --- / +++)는 감춘다. 단, 바이너리 안내는 남긴다
      if (line.startsWith("Binary files")) {
        rows.push({ kind: "meta", text: line, oldNo: null, newNo: null });
      }
      continue;
    }
    if (line.startsWith("+")) {
      rows.push({ kind: "add", text: line.slice(1), oldNo: null, newNo });
      changedNewLines.add(newNo);
      newNo += 1;
      continue;
    }
    if (line.startsWith("-")) {
      rows.push({ kind: "del", text: line.slice(1), oldNo, newNo: null });
      oldNo += 1;
      continue;
    }
    if (line.startsWith("\\")) {
      // "\ No newline at end of file"
      rows.push({ kind: "meta", text: line, oldNo: null, newNo: null });
      continue;
    }
    rows.push({
      kind: "context",
      text: line.startsWith(" ") ? line.slice(1) : line,
      oldNo,
      newNo,
    });
    oldNo += 1;
    newNo += 1;
  }

  return { rows, hunkIndices, hunkNewStarts, changedNewLines };
}

interface SplitSide {
  /** rows 인덱스 (하이라이트 HTML 조회용) */
  srcIndex: number;
  no: number | null;
  kind: RowKind;
}

interface SplitRow {
  kind: "hunk" | "pair";
  text: string;
  left: SplitSide | null;
  right: SplitSide | null;
}

/** unified rows를 좌(old)/우(new) 대응 쌍으로 재배열한다 */
function toSplitRows(rows: DiffRow[]): { rows: SplitRow[]; hunkIndices: number[] } {
  const out: SplitRow[] = [];
  const hunkIndices: number[] = [];
  let dels: number[] = [];
  let adds: number[] = [];

  const flush = () => {
    const count = Math.max(dels.length, adds.length);
    for (let i = 0; i < count; i++) {
      const d = dels[i];
      const a = adds[i];
      out.push({
        kind: "pair",
        text: "",
        left: d === undefined ? null : { srcIndex: d, no: rows[d].oldNo, kind: "del" },
        right: a === undefined ? null : { srcIndex: a, no: rows[a].newNo, kind: "add" },
      });
    }
    dels = [];
    adds = [];
  };

  rows.forEach((row, index) => {
    if (row.kind === "del") {
      dels.push(index);
      return;
    }
    if (row.kind === "add") {
      adds.push(index);
      return;
    }
    flush();
    if (row.kind === "hunk" || row.kind === "meta") {
      if (row.kind === "hunk") {
        hunkIndices.push(out.length);
      }
      out.push({ kind: "hunk", text: row.text, left: null, right: null });
      return;
    }
    out.push({
      kind: "pair",
      text: "",
      left: { srcIndex: index, no: row.oldNo, kind: "context" },
      right: { srcIndex: index, no: row.newNo, kind: "context" },
    });
  });
  flush();

  return { rows: out, hunkIndices };
}

function kindClass(kind: RowKind): string {
  switch (kind) {
    case "add":
      return "dp-add";
    case "del":
      return "dp-del";
    case "hunk":
      return "dp-hunk";
    case "meta":
      return "dp-meta";
    default:
      return "";
  }
}

export function DiffPanel({
  file,
  diffText,
  fileText,
  onRequestFileText,
  loading,
  error,
  onClose,
  badge,
}: DiffPanelProps) {
  const [prefs, setPrefs] = useState<Prefs>(readPrefs);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(0);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const requestedRef = useRef<string | null>(null);

  const lang = useMemo(() => languageForPath(file.path), [file.path]);
  const parsed = useMemo(
    () => (diffText === null ? EMPTY_PARSED : parseDiff(diffText)),
    [diffText],
  );
  const split = useMemo(
    () => (prefs.layout === "split" ? toSplitRows(parsed.rows) : null),
    [prefs.layout, parsed.rows],
  );

  // diff 내용 줄을 한 번에 하이라이트해 rows와 1:1로 맞춘다 (hunk/meta 줄은 빈 문자열)
  const diffHtml = useMemo(() => {
    if (parsed.rows.length === 0) {
      return [];
    }
    const source = parsed.rows
      .map((row) => (row.kind === "hunk" || row.kind === "meta" ? "" : row.text))
      .join("\n");
    return highlightLines(source, lang);
  }, [parsed.rows, lang]);

  const fileHtml = useMemo(
    () => (fileText === null ? [] : highlightLines(fileText, lang)),
    [fileText, lang],
  );

  // File View는 파일 전문이 필요하다. 파일이 바뀌면 요청 기록을 초기화한다
  useEffect(() => {
    requestedRef.current = null;
  }, [file.path]);

  useEffect(() => {
    if (
      prefs.view !== "file" ||
      fileText !== null ||
      error !== null ||
      requestedRef.current === file.path
    ) {
      return;
    }
    requestedRef.current = file.path;
    onRequestFileText();
  }, [prefs.view, fileText, error, file.path, onRequestFileText]);

  const onScroll = useCallback(() => {
    const el = scrollRef.current;
    if (el !== null) {
      setScrollTop(el.scrollTop);
    }
  }, []);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el === null) {
      return;
    }
    setViewportHeight(el.clientHeight);
    setScrollTop(el.scrollTop);
  }, []);

  useEffect(() => {
    const el = scrollRef.current;
    if (el === null || typeof ResizeObserver === "undefined") {
      return;
    }
    const observer = new ResizeObserver(() => setViewportHeight(el.clientHeight));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // 파일이나 뷰가 바뀌면 맨 위로
  useEffect(() => {
    const el = scrollRef.current;
    if (el !== null) {
      el.scrollTop = 0;
    }
    setScrollTop(0);
  }, [file.path, prefs.view, prefs.layout]);

  function update(next: Partial<Prefs>) {
    setPrefs((prev) => {
      const merged = { ...prev, ...next };
      writePrefs(merged);
      return merged;
    });
  }

  const isFileView = prefs.view === "file";
  const isSplit = !isFileView && prefs.layout === "split";
  const count = isFileView
    ? fileHtml.length
    : isSplit
      ? (split?.rows.length ?? 0)
      : parsed.rows.length;

  const wrapAllowed = count <= WRAP_LIMIT;
  const wrap = prefs.wrap && wrapAllowed;
  const virtual = !wrap;

  /** 현재 뷰에서 hunk가 놓인 행 인덱스 목록 */
  const hunkRows = useMemo(() => {
    if (isFileView) {
      return parsed.hunkNewStarts.map((start) => Math.max(0, start - 1));
    }
    if (isSplit) {
      return split?.hunkIndices ?? [];
    }
    return parsed.hunkIndices;
  }, [isFileView, isSplit, parsed.hunkIndices, parsed.hunkNewStarts, split]);

  const currentHunk = useMemo(() => {
    if (hunkRows.length === 0) {
      return 0;
    }
    const line = Math.floor((scrollTop + 4) / LINE_HEIGHT);
    let index = 0;
    for (let i = 0; i < hunkRows.length; i++) {
      if (hunkRows[i] <= line) {
        index = i;
      }
    }
    return index;
  }, [hunkRows, scrollTop]);

  const scrollToRow = useCallback(
    (rowIndex: number) => {
      const el = scrollRef.current;
      if (el === null) {
        return;
      }
      if (virtual) {
        el.scrollTop = Math.max(0, rowIndex * LINE_HEIGHT - LINE_HEIGHT);
        setScrollTop(el.scrollTop);
        return;
      }
      el.querySelector<HTMLElement>(`[data-row="${rowIndex}"]`)?.scrollIntoView({ block: "start" });
    },
    [virtual],
  );

  const gotoHunk = useCallback(
    (delta: number) => {
      if (hunkRows.length === 0) {
        return;
      }
      const next = Math.max(0, Math.min(hunkRows.length - 1, currentHunk + delta));
      scrollToRow(hunkRows[next]);
    },
    [hunkRows, currentHunk, scrollToRow],
  );

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.metaKey || event.ctrlKey || event.altKey) {
      return;
    }
    if (event.key === "[") {
      event.preventDefault();
      gotoHunk(-1);
      return;
    }
    if (event.key === "]") {
      event.preventDefault();
      gotoHunk(1);
      return;
    }
    const el = scrollRef.current;
    if (el === null) {
      return;
    }
    const page = Math.max(80, el.clientHeight - 2 * LINE_HEIGHT);
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        el.scrollTop += LINE_HEIGHT * 3;
        break;
      case "ArrowUp":
        event.preventDefault();
        el.scrollTop -= LINE_HEIGHT * 3;
        break;
      case "PageDown":
        event.preventDefault();
        el.scrollTop += page;
        break;
      case "PageUp":
        event.preventDefault();
        el.scrollTop -= page;
        break;
      case "Home":
        event.preventDefault();
        el.scrollTop = 0;
        break;
      case "End":
        event.preventDefault();
        el.scrollTop = el.scrollHeight;
        break;
      default:
        return;
    }
    setScrollTop(el.scrollTop);
  }

  const height = viewportHeight > 0 ? viewportHeight : 600;
  const first = virtual ? Math.max(0, Math.floor(scrollTop / LINE_HEIGHT) - OVERSCAN) : 0;
  const last = virtual
    ? Math.min(count, Math.ceil((scrollTop + height) / LINE_HEIGHT) + OVERSCAN)
    : count;

  function renderUnifiedRow(index: number): ReactNode {
    const row = parsed.rows[index];
    if (row.kind === "hunk" || row.kind === "meta") {
      return (
        <div key={index} className={`dp-line ${kindClass(row.kind)}`} data-row={index}>
          <span className="dp-code dp-code-plain">{row.text}</span>
        </div>
      );
    }
    return (
      <div key={index} className={`dp-line ${kindClass(row.kind)}`} data-row={index}>
        <span className="dp-no">{row.oldNo ?? ""}</span>
        <span className="dp-no">{row.newNo ?? ""}</span>
        <span className="dp-sign">{row.kind === "add" ? "+" : row.kind === "del" ? "−" : " "}</span>
        <span className="dp-code" dangerouslySetInnerHTML={{ __html: diffHtml[index] ?? "" }} />
      </div>
    );
  }

  function renderSplitSide(side: SplitSide | null, position: "left" | "right"): ReactNode {
    if (side === null) {
      return <div className={`dp-half dp-half-${position} dp-empty`} />;
    }
    return (
      <div className={`dp-half dp-half-${position} ${kindClass(side.kind)}`}>
        <span className="dp-no">{side.no ?? ""}</span>
        <span
          className="dp-code"
          dangerouslySetInnerHTML={{ __html: diffHtml[side.srcIndex] ?? "" }}
        />
      </div>
    );
  }

  function renderSplitRow(index: number): ReactNode {
    const row = split?.rows[index];
    if (row === undefined) {
      return null;
    }
    if (row.kind === "hunk") {
      return (
        <div key={index} className="dp-line dp-hunk" data-row={index}>
          <span className="dp-code dp-code-plain">{row.text}</span>
        </div>
      );
    }
    return (
      <div key={index} className="dp-srow" data-row={index}>
        {renderSplitSide(row.left, "left")}
        {renderSplitSide(row.right, "right")}
      </div>
    );
  }

  function renderFileRow(index: number): ReactNode {
    const changed = parsed.changedNewLines.has(index + 1);
    return (
      <div
        key={index}
        className={changed ? "dp-line dp-add" : "dp-line"}
        data-row={index}
      >
        <span className="dp-no">{index + 1}</span>
        <span className="dp-code" dangerouslySetInnerHTML={{ __html: fileHtml[index] ?? "" }} />
      </div>
    );
  }

  const rows: ReactNode[] = [];
  for (let i = first; i < last; i++) {
    rows.push(isFileView ? renderFileRow(i) : isSplit ? renderSplitRow(i) : renderUnifiedRow(i));
  }

  const { dir, base } = splitPath(file.path);
  const binary = error !== null && /binary/i.test(error);
  const tooLarge = error !== null && /too large/i.test(error);

  let body: ReactNode;
  if (binary) {
    body = <div className="dp-message">Binary file — no text preview.</div>;
  } else if (tooLarge) {
    body = <div className="dp-message">File is too large to display.</div>;
  } else if (error !== null) {
    body = <div className="dp-message">{error}</div>;
  } else if (isFileView && fileText === null) {
    body = <div className="dp-message">Loading file…</div>;
  } else if (!isFileView && diffText === null) {
    body = <div className="dp-message">Loading diff…</div>;
  } else if (count === 0) {
    body = (
      <div className="dp-message">
        {isFileView ? "Empty file." : "No textual changes in this file."}
      </div>
    );
  } else {
    body = (
      <div
        className={wrap ? "dp-body dp-wrap" : "dp-body"}
        ref={scrollRef}
        onScroll={onScroll}
        onKeyDown={handleKeyDown}
        tabIndex={0}
        aria-label="Diff contents"
      >
        {virtual ? (
          <div className="dp-spacer" style={{ height: count * LINE_HEIGHT }}>
            {/* 보이는 줄만 담은 창을 오프셋만큼 내린다 (줄은 static이라 가로 폭에 기여한다) */}
            <div className="dp-window" style={{ top: first * LINE_HEIGHT }}>
              {rows}
            </div>
          </div>
        ) : (
          <div className="dp-flow">{rows}</div>
        )}
      </div>
    );
  }

  return (
    <div className="dp-root">
      <div className="dp-head">
        <span className={`file-icon st-${file.status}`} aria-hidden="true">
          {STATUS_ICON[file.status]}
        </span>
        <span className="dp-path" title={file.oldPath === null ? file.path : `${file.oldPath} → ${file.path}`}>
          <span className="path-dir">{dir}</span>
          <span className="path-base">{base}</span>
        </span>
        {badge !== undefined && badge !== "" && <span className="dp-badge">{badge}</span>}
        <span className="dp-stat">
          {file.additions > 0 && <span className="stat-add">+{file.additions}</span>}
          {file.deletions > 0 && <span className="stat-del">-{file.deletions}</span>}
        </span>
        {loading && <span className="dp-loading">loading…</span>}
        <button
          className="dp-close"
          onClick={onClose}
          title={withKbd("Close", "Esc")}
          aria-label="Close diff"
        >
          ×
        </button>
      </div>

      <div className="dp-toolbar">
        <span className="view-toggle" role="group" aria-label="Content mode">
          <button
            className={isFileView ? "view-btn on" : "view-btn"}
            onClick={() => update({ view: "file" })}
            aria-pressed={isFileView}
          >
            File View
          </button>
          <button
            className={isFileView ? "view-btn" : "view-btn on"}
            onClick={() => update({ view: "diff" })}
            aria-pressed={!isFileView}
          >
            Diff View
          </button>
        </span>

        <span className="dp-hunks">
          <button
            className="dp-icon-btn"
            onClick={() => gotoHunk(-1)}
            disabled={hunkRows.length === 0}
            title={withKbd("Previous hunk", "[")}
            aria-label="Previous hunk"
          >
            ↑
          </button>
          <span className="dp-hunk-count">
            {hunkRows.length === 0 ? "0/0" : `${currentHunk + 1}/${hunkRows.length}`}
          </span>
          <button
            className="dp-icon-btn"
            onClick={() => gotoHunk(1)}
            disabled={hunkRows.length === 0}
            title={withKbd("Next hunk", "]")}
            aria-label="Next hunk"
          >
            ↓
          </button>
        </span>

        <span className="view-toggle" role="group" aria-label="Diff layout">
          <button
            className={!isFileView && prefs.layout === "unified" ? "view-btn on" : "view-btn"}
            onClick={() => update({ layout: "unified" })}
            disabled={isFileView}
            aria-pressed={prefs.layout === "unified"}
          >
            Unified
          </button>
          <button
            className={isSplit ? "view-btn on" : "view-btn"}
            onClick={() => update({ layout: "split" })}
            disabled={isFileView}
            aria-pressed={prefs.layout === "split"}
          >
            Split
          </button>
        </span>

        <button
          className={wrap ? "dp-toggle on" : "dp-toggle"}
          onClick={() => update({ wrap: !prefs.wrap })}
          disabled={!wrapAllowed}
          aria-pressed={wrap}
          title={wrapAllowed ? "Wrap long lines" : "Too many lines to wrap"}
        >
          ⏎ Wrap
        </button>
      </div>

      {body}
    </div>
  );
}
