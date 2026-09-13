// GitKraken 스타일 메인 영역 diff 뷰어. 계약: CONTRACTS.md v0.12 "DiffPanelProps".
// 가상 스크롤(줄 20px) + highlight.js 문법 강조. 상태는 localStorage "gitlanes.diff".
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent, MouseEvent as ReactMouseEvent, ReactNode } from "react";
import type { FileChange, WipArea } from "../types";
import { splitPath } from "./format";
import { withKbd } from "./shortcuts";
import { STATUS_LETTER } from "./FileRow";
import { highlightLines, languageForPath } from "./highlight";
import { buildLinePatch, buildPatch, lineKey, parseUnifiedDiff } from "./hunks";
import "./panels.css";
import "./wip.css";

/**
 * WIP diff에서만 주는 hunk/줄 단위 스테이징 액션.
 * RepoActions.applyPatch를 그대로 받는다 (CONTRACTS.md v0.18).
 */
export interface DiffHunkActions {
  /** 이 diff가 어느 영역의 것인가. 버튼 종류를 정한다 */
  area: WipArea;
  applyPatch(patch: string, cached: boolean, reverse: boolean): Promise<void>;
  busy: boolean;
}

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
  /** 있으면 hunk 헤더에 Stage/Unstage/Discard 버튼이 붙는다. 커밋 diff에서는 주지 않는다 */
  hunkActions?: DiffHunkActions | null;
}

/** 패치 재구성에 쓰는 줄 좌표 (hunk 번호, hunk 안에서의 줄 번호) */
interface LineRef {
  hunk: number;
  line: number;
}

function parseLineRef(value: string | undefined): LineRef | null {
  if (value === undefined) {
    return null;
  }
  const [hunk, line] = value.split(":");
  return { hunk: Number(hunk), line: Number(line) };
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
  hunkActions,
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

  // 패치 재구성용 파싱. 화면용 parseDiff와 별개로 원문 그대로를 들고 있어야
  // 파일 헤더(diff --git / index / --- / +++)를 패치에 그대로 복사할 수 있다
  const patchSource = useMemo(
    () => parseUnifiedDiff(diffText ?? ""),
    [diffText],
  );

  /** rows 인덱스 → 패치 줄 좌표. hunk 안의 줄 순서가 patchSource와 1:1이라 그대로 센다 */
  const lineRefs = useMemo(() => {
    const refs: (LineRef | null)[] = new Array<LineRef | null>(parsed.rows.length).fill(null);
    let hunk = -1;
    let line = 0;
    parsed.rows.forEach((row, index) => {
      if (row.kind === "hunk") {
        hunk += 1;
        line = 0;
        return;
      }
      if (hunk < 0) {
        return;
      }
      refs[index] = { hunk, line };
      line += 1;
    });
    return refs;
  }, [parsed.rows]);

  const [picked, setPicked] = useState<ReadonlySet<string>>(() => new Set<string>());
  /** 드래그 시작 시점의 선택 상태. 되돌아가며 끌어도 결과가 흔들리지 않게 기준으로 쓴다 */
  const dragRef = useRef<{ mode: "add" | "remove"; from: LineRef; base: ReadonlySet<string> } | null>(
    null,
  );

  // 파일이나 diff가 바뀌면 줄 선택은 의미가 없다
  useEffect(() => {
    setPicked(new Set<string>());
    dragRef.current = null;
  }, [file.path, diffText]);

  useEffect(() => {
    const end = () => {
      dragRef.current = null;
    };
    window.addEventListener("mouseup", end);
    return () => window.removeEventListener("mouseup", end);
  }, []);

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

  const canPatch =
    hunkActions !== undefined &&
    hunkActions !== null &&
    // untracked diff는 git diff --no-index 산물이라 경로 접두가 달라 apply가 먹지 않는다.
    // 이 경우는 파일 단위 스테이징만 지원한다
    hunkActions.area !== "untracked" &&
    patchSource.hunks.length > 0;

  function sendPatch(patch: string, cached: boolean, reverse: boolean) {
    if (patch === "" || hunkActions === undefined || hunkActions === null) {
      return;
    }
    setPicked(new Set<string>());
    void hunkActions.applyPatch(patch, cached, reverse).catch(() => undefined);
  }

  /** 끌고 있는 동안 기준 선택에 범위를 더하거나 뺀다. 범위는 한 hunk 안에서만 잡는다 */
  function applyDrag(to: LineRef) {
    const drag = dragRef.current;
    if (drag === null || drag.from.hunk !== to.hunk) {
      return;
    }
    const hunk = patchSource.hunks[to.hunk];
    if (hunk === undefined) {
      return;
    }
    const [lo, hi] =
      drag.from.line <= to.line ? [drag.from.line, to.line] : [to.line, drag.from.line];
    const next = new Set(drag.base);
    for (let i = lo; i <= hi; i++) {
      const kind = hunk.lines[i]?.kind;
      if (kind !== "add" && kind !== "del") {
        continue;
      }
      const key = lineKey(to.hunk, i);
      if (drag.mode === "add") {
        next.add(key);
      } else {
        next.delete(key);
      }
    }
    setPicked(next);
  }

  function refFromEvent(target: EventTarget | null): LineRef | null {
    if (!(target instanceof HTMLElement)) {
      return null;
    }
    return parseLineRef(target.closest<HTMLElement>("[data-lk]")?.dataset.lk);
  }

  function handleGutterDown(event: ReactMouseEvent<HTMLDivElement>) {
    if (!canPatch || event.button !== 0 || !(event.target instanceof HTMLElement)) {
      return;
    }
    if (event.target.closest(".dp-pick") === null) {
      return;
    }
    const ref = refFromEvent(event.target);
    if (ref === null) {
      return;
    }
    // 드래그 중 텍스트가 잡히면 선택 범위가 보이지 않는다
    event.preventDefault();
    const mode = picked.has(lineKey(ref.hunk, ref.line)) ? "remove" : "add";
    dragRef.current = { mode, from: ref, base: picked };
    applyDrag(ref);
  }

  function handleGutterMove(event: ReactMouseEvent<HTMLDivElement>) {
    if (dragRef.current === null) {
      return;
    }
    const ref = refFromEvent(event.target);
    if (ref !== null) {
      applyDrag(ref);
    }
  }

  /** hunk 헤더 오른쪽 버튼들. area가 스테이지 방향을 정한다 */
  function renderHunkActions(hunkIndex: number): ReactNode {
    if (!canPatch || hunkActions === undefined || hunkActions === null) {
      return null;
    }
    const hunk = patchSource.hunks[hunkIndex];
    if (hunk === undefined) {
      return null;
    }
    const staged = hunkActions.area === "staged";
    const busyNow = hunkActions.busy;
    const forward = () => buildPatch(patchSource, [hunkIndex], false);
    const backward = () => buildPatch(patchSource, [hunkIndex], true);
    return (
      <span className="dp-hunk-acts">
        {staged ? (
          <button
            className="dp-hunk-btn"
            disabled={busyNow}
            onClick={() => sendPatch(backward(), true, true)}
          >
            Unstage hunk
          </button>
        ) : (
          <>
            <button
              className="dp-hunk-btn"
              disabled={busyNow}
              onClick={() => sendPatch(forward(), true, false)}
            >
              Stage hunk
            </button>
            <button
              className="dp-hunk-btn danger"
              disabled={busyNow}
              onClick={() => sendPatch(backward(), false, true)}
              title="워킹 트리에서 이 hunk를 되돌린다"
            >
              Discard hunk
            </button>
          </>
        )}
      </span>
    );
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
          {row.kind === "hunk" && renderHunkActions(parsed.hunkIndices.indexOf(index))}
        </div>
      );
    }
    const ref = lineRefs[index];
    const selectable = canPatch && ref !== null && (row.kind === "add" || row.kind === "del");
    const key = ref === null ? "" : lineKey(ref.hunk, ref.line);
    const on = selectable && picked.has(key);
    const gutter = selectable ? "dp-no dp-pick" : "dp-no";
    return (
      <div
        key={index}
        className={`dp-line ${kindClass(row.kind)}${on ? " dp-picked" : ""}`}
        data-row={index}
        data-lk={selectable ? key : undefined}
      >
        <span className={gutter}>{row.oldNo ?? ""}</span>
        <span className={gutter}>{row.newNo ?? ""}</span>
        <span className={selectable ? "dp-sign dp-pick" : "dp-sign"}>
          {row.kind === "add" ? "+" : row.kind === "del" ? "−" : " "}
        </span>
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
      // toSplitRows는 "\ No newline" 같은 meta도 같은 종류로 넣는다. 진짜 hunk만 버튼을 받는다
      const ordinal = split === null ? -1 : split.hunkIndices.indexOf(index);
      return (
        <div key={index} className="dp-line dp-hunk" data-row={index}>
          <span className="dp-code dp-code-plain">{row.text}</span>
          {ordinal >= 0 && renderHunkActions(ordinal)}
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
        onMouseDown={handleGutterDown}
        onMouseMove={handleGutterMove}
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
          {STATUS_LETTER[file.status]}
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

        {picked.size > 0 && hunkActions !== undefined && hunkActions !== null && (
          <span className="dp-linebar">
            <span className="dp-linecount">{picked.size} lines</span>
            {hunkActions.area === "staged" ? (
              <button
                className="dp-hunk-btn"
                disabled={hunkActions.busy}
                onClick={() => sendPatch(buildLinePatch(patchSource, picked, true), true, true)}
              >
                Unstage lines
              </button>
            ) : (
              <>
                <button
                  className="dp-hunk-btn"
                  disabled={hunkActions.busy}
                  onClick={() => sendPatch(buildLinePatch(patchSource, picked, false), true, false)}
                >
                  Stage lines
                </button>
                <button
                  className="dp-hunk-btn danger"
                  disabled={hunkActions.busy}
                  onClick={() => sendPatch(buildLinePatch(patchSource, picked, true), false, true)}
                >
                  Discard lines
                </button>
              </>
            )}
            <button
              className="dp-icon-btn"
              onClick={() => setPicked(new Set<string>())}
              title="선택 해제"
              aria-label="Clear line selection"
            >
              ×
            </button>
          </span>
        )}

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
