// 줄 단위 blame 뷰. 계약: CONTRACTS.md v0.18 "BlameViewProps".
// 왼쪽 거터에 구간(같은 커밋이 이어지는 줄 묶음)별 커밋 정보, 오른쪽에 문법 강조된 코드.
// 1,000줄을 넘으면 DiffPanel과 같은 고정 높이(20px) 가상 스크롤로 보이는 줄만 그린다.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { MouseEvent as ReactMouseEvent, ReactNode } from "react";
import type { BlameHunk, BlameResult } from "../types";
import { formatDate, formatRelativeDate } from "../graph/layout";
import { splitPath } from "./format";
import { escapeHtml, highlightLines, languageForPath } from "./highlight";
import { hunkAgeLevels, isHunkStart, lineHunkIndex, visibleRange } from "./historyModel";
import "./panels.css";
import "./history.css";

export interface BlameViewProps {
  file: string;
  blame: BlameResult | null; // null이면 로딩
  error: string | null;
  dateMode: "absolute" | "relative";
  onJumpToCommit(sha: string): void; // uncommitted 구간은 부르지 않는다
  onClose(): void;
}

/** 줄 높이(px). history.css의 .bl-line 높이와 반드시 일치 */
const LINE_HEIGHT = 20;
const OVERSCAN = 30;
/** 이 줄 수를 넘으면 가상 스크롤로 그린다 */
const VIRTUAL_THRESHOLD = 1000;

const EMPTY_OWNER = new Int32Array(0);

function hunkDate(hunk: BlameHunk, dateMode: "absolute" | "relative", nowMs: number): string {
  if (dateMode === "relative") {
    return formatRelativeDate(hunk.timestamp, nowMs);
  }
  // 거터 폭이 좁아 시각은 빼고 날짜만 ("YYYY/MM/DD")
  return formatDate(hunk.timestamp).slice(0, 10);
}

export function BlameView({ file, blame, error, dateMode, onJumpToCommit, onClose }: BlameViewProps) {
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(0);
  const [hovered, setHovered] = useState(-1);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  const lang = useMemo(() => languageForPath(file), [file]);
  const owner = useMemo(() => (blame === null ? EMPTY_OWNER : lineHunkIndex(blame)), [blame]);
  const ages = useMemo(() => (blame === null ? [] : hunkAgeLevels(blame.hunks)), [blame]);
  const codeHtml = useMemo(() => {
    if (blame === null) {
      return [];
    }
    const html = highlightLines(blame.lines.join("\n"), lang);
    // highlightLines는 끝 빈 줄을 떼고 CRLF를 접는다. 줄 수가 어긋나면 plain으로 맞춘다
    return html.length === blame.lines.length ? html : blame.lines.map(escapeHtml);
  }, [blame, lang]);

  const count = blame?.lines.length ?? 0;
  const virtual = count > VIRTUAL_THRESHOLD;
  // 렌더당 한 번만 시계를 읽는다
  const nowMs = Date.now();

  const onScroll = useCallback(() => {
    const el = scrollRef.current;
    if (el !== null) {
      setScrollTop(el.scrollTop);
    }
  }, []);

  // 본문은 로딩이 끝나야 생기므로 blame이 바뀔 때마다 다시 잰다
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el === null) {
      return;
    }
    setViewportHeight(el.clientHeight);
    setScrollTop(el.scrollTop);
  }, [blame]);

  useEffect(() => {
    const el = scrollRef.current;
    if (el === null || typeof ResizeObserver === "undefined") {
      return;
    }
    const observer = new ResizeObserver(() => setViewportHeight(el.clientHeight));
    observer.observe(el);
    return () => observer.disconnect();
  }, [blame]);

  // 파일이 바뀌면 맨 위로
  useEffect(() => {
    const el = scrollRef.current;
    if (el !== null) {
      el.scrollTop = 0;
    }
    setScrollTop(0);
    setHovered(-1);
  }, [file]);

  function hunkFromEvent(target: EventTarget | null): number {
    if (!(target instanceof HTMLElement)) {
      return -1;
    }
    const raw = target.closest<HTMLElement>("[data-hunk]")?.dataset.hunk;
    return raw === undefined ? -1 : Number(raw);
  }

  function handleGutterMove(event: ReactMouseEvent<HTMLDivElement>) {
    const index = hunkFromEvent(event.target);
    if (index !== hovered) {
      setHovered(index);
    }
  }

  function handleGutterClick(event: ReactMouseEvent<HTMLDivElement>) {
    const hunk = blame?.hunks[hunkFromEvent(event.target)];
    if (hunk === undefined || hunk.uncommitted) {
      return;
    }
    onJumpToCommit(hunk.sha);
  }

  function renderGutter(line: number, hunkIndex: number): ReactNode {
    const hunk = hunkIndex < 0 ? undefined : blame?.hunks[hunkIndex];
    if (hunk === undefined) {
      return <span className="bl-gutter" />;
    }
    const age = hunk.uncommitted ? "bl-uncommitted" : `bl-age-${ages[hunkIndex] ?? 0}`;
    const start = isHunkStart(owner, line);
    const title = hunk.uncommitted
      ? "Not committed yet"
      : `${hunk.shortSha}  ${hunk.author}  ${formatDate(hunk.timestamp)}\n${hunk.summary}`;
    return (
      <span
        className={`bl-gutter ${age}${hunk.uncommitted ? "" : " bl-jump"}`}
        data-hunk={hunkIndex}
        title={title}
      >
        {start &&
          (hunk.uncommitted ? (
            <span className="bl-info bl-info-wip">Not committed yet</span>
          ) : (
            <span className="bl-info">
              <span className="bl-sha">{hunk.shortSha}</span>
              <span className="bl-author">{hunk.author}</span>
              <span className="bl-date">{hunkDate(hunk, dateMode, nowMs)}</span>
            </span>
          ))}
      </span>
    );
  }

  const { dir, base } = splitPath(file);
  const binary = error !== null && /binary/i.test(error);
  const tooLarge = error !== null && /too large/i.test(error);

  let body: ReactNode;
  if (binary) {
    body = <div className="hp-message">Binary file, blame is not available.</div>;
  } else if (tooLarge) {
    body = <div className="hp-message">File is too large to blame.</div>;
  } else if (error !== null) {
    body = <div className="hp-message hp-error">{error}</div>;
  } else if (blame === null) {
    body = <div className="hp-message">Loading blame…</div>;
  } else if (count === 0) {
    body = <div className="hp-message">Empty file.</div>;
  } else {
    const range = virtual
      ? visibleRange(scrollTop, viewportHeight > 0 ? viewportHeight : 600, count, LINE_HEIGHT, OVERSCAN)
      : { first: 0, last: count };
    const rows: ReactNode[] = [];
    for (let line = range.first; line < range.last; line++) {
      const hunkIndex = owner[line] ?? -1;
      const cls =
        "bl-line" +
        (hunkIndex >= 0 && hunkIndex % 2 === 1 ? " bl-odd" : "") +
        (hunkIndex >= 0 && hunkIndex === hovered ? " bl-hover" : "") +
        (hunkIndex >= 0 && isHunkStart(owner, line) && line > 0 ? " bl-start" : "");
      rows.push(
        <div key={line} className={cls}>
          {renderGutter(line, hunkIndex)}
          <span className="dp-no">{line + 1}</span>
          <span className="dp-code" dangerouslySetInnerHTML={{ __html: codeHtml[line] ?? "" }} />
        </div>,
      );
    }
    body = (
      <div
        className="bl-body"
        ref={scrollRef}
        onScroll={onScroll}
        onMouseMove={handleGutterMove}
        onMouseLeave={() => setHovered(-1)}
        onClick={handleGutterClick}
        tabIndex={0}
        aria-label="Blame contents"
      >
        {virtual ? (
          <div className="dp-spacer" style={{ height: count * LINE_HEIGHT }}>
            <div className="dp-window" style={{ top: range.first * LINE_HEIGHT }}>
              {rows}
            </div>
          </div>
        ) : (
          <div className="bl-flow">{rows}</div>
        )}
      </div>
    );
  }

  return (
    <div className="hp-root bl-root">
      <div className="hp-head">
        <span className="hp-kind">Blame</span>
        <span className="hp-path" title={file}>
          <span className="path-dir">{dir}</span>
          <span className="path-base">{base}</span>
        </span>
        <button className="dp-close" onClick={onClose} title="Close" aria-label="Close blame">
          ×
        </button>
      </div>
      {body}
    </div>
  );
}
