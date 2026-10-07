// 파일 히스토리 목록. 계약: CONTRACTS.md v0.18 "FileHistoryPanelProps".
// 상세 패널 자리와 diff 영역 어느 쪽에 놓여도 되게 높이 100% 컬럼으로 그린다.
import { useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import type { FileHistoryEntry } from "../types";
import { formatDate, formatRelativeDate } from "../graph/layout";
import { splitPath } from "./format";
import { moveIndex } from "./historyModel";
import "./panels.css";
import "./history.css";

export interface FileHistoryPanelProps {
  file: string;
  entries: FileHistoryEntry[] | null; // null이면 로딩
  error: string | null;
  selectedSha: string | null;
  onSelect(entry: FileHistoryEntry): void;
  onClose(): void;
}

export function FileHistoryPanel({
  file,
  entries,
  error,
  selectedSha,
  onSelect,
  onClose,
}: FileHistoryPanelProps) {
  const listRef = useRef<HTMLUListElement | null>(null);
  const selectedIndex = useMemo(
    () => (entries === null ? -1 : entries.findIndex((entry) => entry.sha === selectedSha)),
    [entries, selectedSha],
  );
  const [focus, setFocus] = useState(selectedIndex);
  // 렌더당 한 번만 시계를 읽는다 (행마다 Date.now()를 부르지 않는다)
  const nowMs = Date.now();

  // 바깥에서 선택이 바뀌면 키보드 포커스도 따라간다
  useEffect(() => {
    setFocus(selectedIndex);
  }, [selectedIndex]);

  useEffect(() => {
    if (focus < 0) {
      return;
    }
    listRef.current
      ?.querySelector<HTMLElement>(`[data-nav-index="${focus}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [focus]);

  function handleKeyDown(event: KeyboardEvent<HTMLUListElement>) {
    if (entries === null || event.metaKey || event.ctrlKey || event.altKey) {
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      setFocus((prev) => moveIndex(prev, event.key === "ArrowDown" ? 1 : -1, entries.length));
      return;
    }
    if (event.key === "Enter") {
      const entry = entries[focus];
      if (entry !== undefined) {
        event.preventDefault();
        onSelect(entry);
      }
    }
  }

  const { dir, base } = splitPath(file);

  let body;
  if (error !== null) {
    body = <div className="hp-message hp-error">{error}</div>;
  } else if (entries === null) {
    body = <div className="hp-message">Loading history…</div>;
  } else if (entries.length === 0) {
    body = <div className="hp-message">No commits touch this file.</div>;
  } else {
    body = (
      <ul
        className="hp-list panel-scroll"
        ref={listRef}
        tabIndex={0}
        role="listbox"
        aria-label="File history"
        aria-activedescendant={focus >= 0 ? `fh-${focus}` : undefined}
        onKeyDown={handleKeyDown}
      >
        {entries.map((entry, index) => {
          const selected = entry.sha === selectedSha;
          const cls =
            "hp-commit" + (selected ? " selected" : "") + (index === focus ? " kb-focus" : "");
          return (
            <li
              key={`${entry.sha}:${entry.path}`}
              id={`fh-${index}`}
              className={cls}
              data-nav-index={index}
              role="option"
              aria-selected={selected}
              title={entry.sha}
              onClick={() => {
                setFocus(index);
                onSelect(entry);
              }}
            >
              <span className="hp-sha">{entry.shortSha}</span>
              <span className="hp-subject">{entry.subject}</span>
              <span className="hp-meta">
                <span className="hp-author">{entry.author}</span>
                <span className="hp-date" title={formatDate(entry.timestamp)}>
                  {formatRelativeDate(entry.timestamp, nowMs)}
                </span>
              </span>
              {entry.oldPath !== null && (
                <span className="hp-rename" title={`${entry.oldPath} → ${entry.path}`}>
                  renamed from {entry.oldPath}
                </span>
              )}
              {entry.oldPath === null && entry.path !== file && (
                <span className="hp-rename" title={entry.path}>
                  as {entry.path}
                </span>
              )}
            </li>
          );
        })}
      </ul>
    );
  }

  return (
    <div className="hp-root">
      <div className="hp-head">
        <span className="hp-kind">History</span>
        <span className="hp-path" title={file}>
          <span className="path-dir">{dir}</span>
          <span className="path-base">{base}</span>
        </span>
        {entries !== null && entries.length > 0 && (
          <span className="hp-count">{entries.length}</span>
        )}
        <button className="dp-close" onClick={onClose} title="Close" aria-label="Close history">
          ×
        </button>
      </div>
      {body}
    </div>
  );
}
