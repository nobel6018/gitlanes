import type { RefObject } from "react";

export interface SearchBoxProps {
  query: string;
  /** 전체 매치 수 */
  matchCount: number;
  /** 현재 매치의 1-based 위치. 매치 없으면 0 */
  matchPosition: number;
  inputRef: RefObject<HTMLInputElement | null>;
  onChange: (query: string) => void;
  onNext: () => void;
  onPrev: () => void;
  onClear: () => void;
}

export function SearchBox({
  query,
  matchCount,
  matchPosition,
  inputRef,
  onChange,
  onNext,
  onPrev,
  onClear,
}: SearchBoxProps) {
  const hasQuery = query !== "";
  const noMatch = hasQuery && matchCount === 0;

  return (
    <div className={noMatch ? "search no-match" : "search"}>
      <svg className="search-icon" viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
        <g fill="none" stroke="currentColor" strokeWidth="1.4">
          <circle cx="7" cy="7" r="4.2" />
          <path d="M10.2 10.2 14 14" strokeLinecap="round" />
        </g>
      </svg>
      <input
        ref={inputRef}
        className="search-input"
        type="text"
        value={query}
        spellCheck={false}
        placeholder="Search commits (⌘F)"
        aria-label="Search commits"
        onChange={(e) => onChange(e.currentTarget.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            if (e.shiftKey) {
              onPrev();
            } else {
              onNext();
            }
          } else if (e.key === "Escape") {
            e.preventDefault();
            onClear();
            e.currentTarget.blur();
          }
        }}
      />
      {hasQuery && (
        <>
          <span className="search-count">
            {matchCount === 0 ? "0/0" : `${matchPosition}/${matchCount}`}
          </span>
          <button className="search-nav" onClick={onPrev} title="Previous match (Shift+Enter)">
            ‹
          </button>
          <button className="search-nav" onClick={onNext} title="Next match (Enter)">
            ›
          </button>
          <button className="search-clear" onClick={onClear} title="Clear (Esc)">
            ×
          </button>
        </>
      )}
    </div>
  );
}
