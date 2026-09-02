// ⌘P 퀵 스위처. refs를 퍼지 매치로 좁히고 Enter로 선택한다.
// 계약: QuickSwitcher(props: { open, refs, onSelect, onClose }) — open=false면 null.
import { useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent, MouseEvent, ReactNode } from "react";
import type { RefEntry, RefKind } from "../types";
import "./panels.css";

export interface QuickSwitcherProps {
  open: boolean;
  refs: RefEntry[];
  onSelect: (ref: RefEntry) => void;
  onClose: () => void;
}

/** localStorage: 최근 선택한 ref 이름 배열 (sha가 아니라 name을 저장한다) */
const RECENT_KEY = "gitlanes.quickswitch.recent";
/** 결과 목록 최대 길이 */
const MAX_RESULTS = 12;
/** 빈 질의에서 상단에 고정할 최근 선택 수 */
const MAX_RECENT = 5;

const KIND_ORDER: Record<RefKind, number> = {
  localBranch: 0,
  remoteBranch: 1,
  tag: 2,
};

const KIND_ICON: Record<RefKind, string> = {
  localBranch: "⌂",
  remoteBranch: "☁",
  tag: "🏷",
};

const KIND_TAG: Record<RefKind, string> = {
  localBranch: "local",
  remoteBranch: "remote",
  tag: "tag",
};

type Range = [number, number];

interface Scored {
  ref: RefEntry;
  score: number;
  ranges: Range[];
}

function readRecent(): string[] {
  try {
    const raw = localStorage.getItem(RECENT_KEY);
    if (raw === null) {
      return [];
    }
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.filter((item): item is string => typeof item === "string");
  } catch {
    return [];
  }
}

function writeRecent(names: string[]) {
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(names.slice(0, 10)));
  } catch {
    // localStorage 실패는 무시 (최근 목록만 휘발)
  }
}

/** 겹치거나 붙은 구간을 합친다 (문자 단위 퍼지 매치 결과 정리용) */
function mergeRanges(ranges: Range[]): Range[] {
  if (ranges.length === 0) {
    return ranges;
  }
  const merged: Range[] = [ranges[0]];
  for (let i = 1; i < ranges.length; i++) {
    const last = merged[merged.length - 1];
    const [start, end] = ranges[i];
    if (start <= last[1]) {
      last[1] = Math.max(last[1], end);
    } else {
      merged.push([start, end]);
    }
  }
  return merged;
}

/**
 * 점수: 접두 일치(400) > 경로 세그먼트 시작 일치(300) > 부분 일치(200) > 문자 순서 퍼지(100 이하).
 * 매치 없으면 null.
 */
function scoreRef(name: string, query: string): { score: number; ranges: Range[] } | null {
  const haystack = name.toLowerCase();
  const needle = query.toLowerCase();
  const len = needle.length;

  if (haystack.startsWith(needle)) {
    return { score: 400, ranges: [[0, len]] };
  }

  // "/" 뒤에서 시작하는 일치 (origin/feature → "feature"로 찾기)
  for (let i = 0; i < haystack.length; i++) {
    if (haystack[i] === "/" && haystack.startsWith(needle, i + 1)) {
      return { score: 300, ranges: [[i + 1, i + 1 + len]] };
    }
  }

  const idx = haystack.indexOf(needle);
  if (idx >= 0) {
    // 뒤쪽에서 걸릴수록 조금 낮게
    return { score: 200 - Math.min(idx, 50), ranges: [[idx, idx + len]] };
  }

  // 문자 순서만 맞는 퍼지. 붙어 있을수록 점수가 높다
  const ranges: Range[] = [];
  let cursor = 0;
  let gaps = 0;
  for (let i = 0; i < len; i++) {
    const found = haystack.indexOf(needle[i], cursor);
    if (found < 0) {
      return null;
    }
    if (found > cursor) {
      gaps += found - cursor;
    }
    ranges.push([found, found + 1]);
    cursor = found + 1;
  }
  return { score: Math.max(1, 100 - Math.min(gaps, 90)), ranges: mergeRanges(ranges) };
}

function compareRefs(a: RefEntry, b: RefEntry): number {
  const kind = KIND_ORDER[a.kind] - KIND_ORDER[b.kind];
  if (kind !== 0) {
    return kind;
  }
  return a.name.localeCompare(b.name);
}

/** 빈 질의: 최근 선택 5개 + 로컬 브랜치(HEAD 먼저) 상위로 채운다 */
function defaultList(refs: RefEntry[], recent: string[]): Scored[] {
  const byName = new Map(refs.map((ref) => [ref.name, ref] as const));
  const picked: RefEntry[] = [];
  const seen = new Set<string>();

  for (const name of recent) {
    if (picked.length >= MAX_RECENT) {
      break;
    }
    const ref = byName.get(name);
    if (ref !== undefined && !seen.has(name)) {
      seen.add(name);
      picked.push(ref);
    }
  }

  const locals = refs
    .filter((ref) => ref.kind === "localBranch" && !seen.has(ref.name))
    .sort((a, b) => {
      if (a.isHead !== b.isHead) {
        return a.isHead ? -1 : 1;
      }
      return a.name.localeCompare(b.name);
    });

  for (const ref of locals) {
    if (picked.length >= MAX_RESULTS) {
      break;
    }
    picked.push(ref);
  }

  return picked.map((ref) => ({ ref, score: 0, ranges: [] }));
}

function search(refs: RefEntry[], query: string, recent: string[]): Scored[] {
  const trimmed = query.trim();
  if (trimmed === "") {
    return defaultList(refs, recent);
  }
  const matched: Scored[] = [];
  for (const ref of refs) {
    const hit = scoreRef(ref.name, trimmed);
    if (hit !== null) {
      matched.push({ ref, score: hit.score, ranges: hit.ranges });
    }
  }
  matched.sort((a, b) => {
    if (a.score !== b.score) {
      return b.score - a.score;
    }
    return compareRefs(a.ref, b.ref);
  });
  return matched.slice(0, MAX_RESULTS);
}

/** 매치 구간만 <mark>로 감싼 조각들 */
function marked(name: string, ranges: Range[]): ReactNode {
  if (ranges.length === 0) {
    return name;
  }
  const parts: ReactNode[] = [];
  let cursor = 0;
  ranges.forEach(([start, end], i) => {
    if (start > cursor) {
      parts.push(name.slice(cursor, start));
    }
    parts.push(<mark key={`m${i}`}>{name.slice(start, end)}</mark>);
    cursor = end;
  });
  if (cursor < name.length) {
    parts.push(name.slice(cursor));
  }
  return parts;
}

export function QuickSwitcher({ open, refs, onSelect, onClose }: QuickSwitcherProps) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [recent, setRecent] = useState<string[]>([]);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLUListElement | null>(null);

  // 열릴 때 질의 초기화 + 최근 목록 재로드 + 입력창 포커스
  useEffect(() => {
    if (!open) {
      return;
    }
    setQuery("");
    setActive(0);
    setRecent(readRecent());
    inputRef.current?.focus();
  }, [open]);

  const results = useMemo(
    () => (open ? search(refs, query, recent) : []),
    [open, refs, query, recent],
  );

  // 결과가 줄어들면 활성 인덱스를 범위 안으로 당긴다
  useEffect(() => {
    setActive((prev) => (prev >= results.length ? Math.max(0, results.length - 1) : prev));
  }, [results.length]);

  // 활성 항목이 목록 밖이면 스크롤로 따라간다
  useEffect(() => {
    const list = listRef.current;
    if (list === null) {
      return;
    }
    const item = list.querySelector<HTMLElement>(`[data-qs-index="${active}"]`);
    item?.scrollIntoView({ block: "nearest" });
  }, [active, results.length]);

  if (!open) {
    return null;
  }

  function choose(entry: Scored) {
    const next = [entry.ref.name, ...recent.filter((name) => name !== entry.ref.name)];
    writeRecent(next);
    setRecent(next);
    onSelect(entry.ref);
    onClose();
  }

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape") {
      event.stopPropagation();
      event.preventDefault();
      onClose();
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActive((prev) => (results.length === 0 ? 0 : (prev + 1) % results.length));
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      setActive((prev) => (results.length === 0 ? 0 : (prev - 1 + results.length) % results.length));
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      const entry = results[active];
      if (entry !== undefined) {
        choose(entry);
      }
    }
  }

  function handleBackdrop(event: MouseEvent<HTMLDivElement>) {
    if (event.target === event.currentTarget) {
      onClose();
    }
  }

  const showingRecent = query.trim() === "";

  return (
    <div
      className="ov-backdrop qs-backdrop"
      onMouseDown={handleBackdrop}
      onKeyDown={handleKeyDown}
      role="presentation"
    >
      <div className="qs-modal" role="dialog" aria-modal="true" aria-label="Quick switcher">
        <input
          ref={inputRef}
          className="qs-input"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setActive(0);
          }}
          placeholder="Jump to branch or tag"
          spellCheck={false}
          autoComplete="off"
          aria-label="Jump to branch or tag"
        />
        {results.length === 0 ? (
          <div className="qs-empty">No matching refs</div>
        ) : (
          <ul className="qs-list" ref={listRef}>
            {results.map((entry, index) => (
              <li key={`${entry.ref.kind}:${entry.ref.name}`}>
                <button
                  className={index === active ? "qs-item on" : "qs-item"}
                  data-qs-index={index}
                  onMouseEnter={() => setActive(index)}
                  onClick={() => choose(entry)}
                  title={`${entry.ref.name} — ${entry.ref.sha.slice(0, 10)}`}
                >
                  <span className="qs-icon" aria-hidden="true">
                    {KIND_ICON[entry.ref.kind]}
                  </span>
                  <span className="qs-name">{marked(entry.ref.name, entry.ranges)}</span>
                  {entry.ref.isHead && <span className="qs-tag">head</span>}
                  <span className="qs-tag">{KIND_TAG[entry.ref.kind]}</span>
                  <span className="qs-sha">{entry.ref.sha.slice(0, 7)}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
        <div className="qs-foot">
          <span>{showingRecent ? "Recent & local branches" : `${results.length} shown`}</span>
          <span>↑↓ move · Enter open · Esc close</span>
        </div>
      </div>
    </div>
  );
}
