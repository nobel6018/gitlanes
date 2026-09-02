// 검색 필터 모드의 평면 커밋 목록. 그래프 없이 MESSAGE/AUTHOR/DATE만 보여준다.
// 가상 스크롤은 GraphView와 같은 spacer + 절대배치 패턴.
// 계약: FilterResults(props: { rows, query, selectedSha, onSelect, total, hasMore, onLoadMore })
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { ROW_HEIGHT } from "../constants";
import type { CommitRow } from "../types";
import { formatTimestamp } from "./format";
import "./panels.css";

export interface FilterResultsProps {
  /** ui-shell이 이미 필터링해 넘긴 매치 커밋들 */
  rows: CommitRow[];
  query: string;
  selectedSha: string | null;
  onSelect: (sha: string) => void;
  /** 전체 매치 수 (로드되지 않은 것 포함) */
  total: number;
  hasMore: boolean;
  onLoadMore: () => void;
}

/** 보이는 범위 위아래로 더 그려두는 행 수 */
const OVERSCAN_ROWS = 10;
/** "Load more" 버튼 영역 높이(px) */
const FOOTER_HEIGHT = 34;

/** query 매치 구간을 <mark>로 감싼다 (대소문자 무시, 모든 등장) */
function marked(text: string, query: string): ReactNode {
  const needle = query.trim().toLowerCase();
  if (needle === "") {
    return text;
  }
  const haystack = text.toLowerCase();
  const parts: ReactNode[] = [];
  let cursor = 0;
  let found = haystack.indexOf(needle);
  let key = 0;
  while (found >= 0) {
    if (found > cursor) {
      parts.push(text.slice(cursor, found));
    }
    parts.push(<mark key={`m${key++}`}>{text.slice(found, found + needle.length)}</mark>);
    cursor = found + needle.length;
    found = haystack.indexOf(needle, cursor);
  }
  if (parts.length === 0) {
    return text;
  }
  if (cursor < text.length) {
    parts.push(text.slice(cursor));
  }
  return parts;
}

export function FilterResults({
  rows,
  query,
  selectedSha,
  onSelect,
  total,
  hasMore,
  onLoadMore,
}: FilterResultsProps) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(0);

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

  // rows가 교체되면 브라우저가 scrollTop을 클램프했을 수 있으니 실제 값을 다시 읽는다
  useEffect(() => {
    setScrollTop(scrollRef.current?.scrollTop ?? 0);
  }, [rows]);

  const dates = useMemo(() => rows.map((row) => formatTimestamp(row.timestamp)), [rows]);

  // 뷰포트 높이를 아직 못 쟀으면(0) 첫 페인트용으로 넉넉히 잡는다
  const height = viewportHeight > 0 ? viewportHeight : 600;
  const first = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN_ROWS);
  const last = Math.min(rows.length, Math.ceil((scrollTop + height) / ROW_HEIGHT) + OVERSCAN_ROWS);

  const visible: ReactNode[] = [];
  for (let i = first; i < last; i++) {
    const row = rows[i];
    visible.push(
      <div
        key={row.sha}
        className={row.sha === selectedSha ? "fr-row on" : "fr-row"}
        style={{ top: i * ROW_HEIGHT, height: ROW_HEIGHT }}
        onClick={() => onSelect(row.sha)}
        title={`${row.subject}\n${row.author} · ${dates[i]} · ${row.shortSha}`}
      >
        <span className="fr-cell fr-cell-message">{marked(row.subject, query)}</span>
        <span className="fr-cell fr-cell-author">{row.author}</span>
        <span className="fr-cell fr-cell-date">{dates[i]}</span>
      </div>,
    );
  }

  const totalHeight = rows.length * ROW_HEIGHT;
  const label = total === 1 ? "1 match" : `${total.toLocaleString()} matches`;

  return (
    <div className="fr-root">
      <div className="fr-head">
        <span className="fr-count">{label}</span>
      </div>
      <div className="fr-cols">
        <span className="fr-cell fr-cell-message">Message</span>
        <span className="fr-cell fr-cell-author">Author</span>
        <span className="fr-cell fr-cell-date">Date</span>
      </div>
      {rows.length === 0 ? (
        <div className="fr-empty">No commits match</div>
      ) : (
        <div className="fr-scroll" ref={scrollRef} onScroll={onScroll} tabIndex={0}>
          <div
            className="fr-spacer"
            style={{ height: totalHeight + (hasMore ? FOOTER_HEIGHT : 0) }}
          >
            {visible}
            {hasMore && (
              <div className="fr-more" style={{ top: totalHeight, height: FOOTER_HEIGHT }}>
                <button className="fr-more-btn" onClick={onLoadMore}>
                  Load more
                </button>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
