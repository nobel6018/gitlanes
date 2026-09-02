import { useEffect, useMemo, useState } from "react";
import type { MouseEvent, ReactNode, RefObject } from "react";
import type { RefEntry } from "../types";
import { shortSha } from "./format";
import { SidebarContextMenu } from "./SidebarContextMenu";
import "./sidebar.css";

export interface BranchSidebarProps {
  refs: RefEntry[];
  loading: boolean;
  selectedSha: string | null;
  /** 항목 클릭 시 해당 커밋으로 점프 요청 */
  onSelectRef: (sha: string) => void;
  /** 우클릭 메뉴 Copy Name */
  onCopyRefName: (name: string) => void;
  /** remoteUrl이 있을 때만 전달된다. undefined면 메뉴 항목을 숨긴다 */
  onOpenRefOnRemote?: (ref: RefEntry) => void;
  /** 외부(⌘⌥F)에서 필터 입력창을 포커스하기 위한 ref */
  filterInputRef?: RefObject<HTMLInputElement | null>;
}

interface RemoteGroup {
  remote: string;
  entries: RefEntry[];
}

interface Grouped {
  locals: RefEntry[];
  remotes: RemoteGroup[];
  tags: RefEntry[];
  remoteCount: number;
}

interface MenuState {
  x: number;
  y: number;
  entry: RefEntry;
}

/** localStorage key: 사이드바 섹션 접힘 상태 (접힌 키만 true) */
const SECTIONS_KEY = "gitlanes.sidebar.sections";

function readCollapsed(): Record<string, boolean> {
  try {
    const raw = localStorage.getItem(SECTIONS_KEY);
    if (raw === null) {
      return {};
    }
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }
    const out: Record<string, boolean> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (value === true) {
        out[key] = true;
      }
    }
    return out;
  } catch {
    return {};
  }
}

function writeCollapsed(collapsed: Record<string, boolean>): void {
  try {
    localStorage.setItem(SECTIONS_KEY, JSON.stringify(collapsed));
  } catch {
    // localStorage 실패는 무시 (다음 실행에서 기본값)
  }
}

/** "origin/feature/x" -> { remote: "origin", rest: "feature/x" } */
function splitRemote(name: string): { remote: string; rest: string } {
  const idx = name.indexOf("/");
  if (idx < 0) {
    return { remote: name, rest: name };
  }
  return { remote: name.slice(0, idx), rest: name.slice(idx + 1) };
}

function group(refs: RefEntry[]): Grouped {
  const locals: RefEntry[] = [];
  const tags: RefEntry[] = [];
  const byRemote = new Map<string, RefEntry[]>();

  for (const ref of refs) {
    if (ref.kind === "localBranch") {
      locals.push(ref);
    } else if (ref.kind === "tag") {
      tags.push(ref);
    } else {
      const { remote } = splitRemote(ref.name);
      const bucket = byRemote.get(remote);
      if (bucket === undefined) {
        byRemote.set(remote, [ref]);
      } else {
        bucket.push(ref);
      }
    }
  }

  const byName = (a: RefEntry, b: RefEntry) => a.name.localeCompare(b.name);
  locals.sort(byName);
  tags.sort(byName);

  const remotes = [...byRemote.entries()]
    .map(([remote, entries]) => ({ remote, entries: entries.sort(byName) }))
    .sort((a, b) => a.remote.localeCompare(b.remote));

  return {
    locals,
    remotes,
    tags,
    remoteCount: remotes.reduce((sum, r) => sum + r.entries.length, 0),
  };
}

export function BranchSidebar({
  refs,
  loading,
  selectedSha,
  onSelectRef,
  onCopyRefName,
  onOpenRefOnRemote,
  filterInputRef,
}: BranchSidebarProps) {
  const all = useMemo(() => group(refs), [refs]);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>(readCollapsed);
  const [filter, setFilter] = useState("");
  const [menu, setMenu] = useState<MenuState | null>(null);

  useEffect(() => {
    writeCollapsed(collapsed);
  }, [collapsed]);

  const query = filter.trim().toLowerCase();
  const filtering = query !== "";

  // 리모트 수백 개에서도 입력마다 재계산이 눈에 띄지 않게 메모
  const view = useMemo<Grouped>(() => {
    if (query === "") {
      return all;
    }
    // 표시 라벨은 리모트 접두사가 빠지지만, 매치는 전체 이름 기준으로 본다
    const matches = (ref: RefEntry) => ref.name.toLowerCase().includes(query);
    const remotes = all.remotes
      .map((g) => ({ remote: g.remote, entries: g.entries.filter(matches) }))
      .filter((g) => g.entries.length > 0);
    return {
      locals: all.locals.filter(matches),
      remotes,
      tags: all.tags.filter(matches),
      remoteCount: remotes.reduce((sum, g) => sum + g.entries.length, 0),
    };
  }, [all, query]);

  const toggle = (key: string) =>
    setCollapsed((prev) => {
      const next = { ...prev };
      if (next[key] === true) {
        delete next[key];
      } else {
        next[key] = true;
      }
      return next;
    });

  // 필터 중에는 접힘 상태를 무시하고 전부 펼친다 (지우면 원래 상태 복귀)
  const isCollapsed = (key: string) => !filtering && collapsed[key] === true;

  const openMenu = (entry: RefEntry, x: number, y: number) => setMenu({ x, y, entry });

  return (
    <nav className="sidebar" aria-label="Branches">
      <div className="sb-filter">
        <input
          ref={filterInputRef}
          className="sb-filter-input"
          type="text"
          value={filter}
          placeholder="Filter branches"
          aria-label="Filter branches"
          spellCheck={false}
          autoComplete="off"
          autoCorrect="off"
          onChange={(event) => setFilter(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== "Escape") {
              return;
            }
            if (filter !== "") {
              // 전역 Esc 핸들러(선택 해제 등)까지 번지지 않게 여기서 소비
              event.preventDefault();
              event.stopPropagation();
              setFilter("");
            } else {
              event.currentTarget.blur();
            }
          }}
        />
        {filter !== "" && (
          <button
            className="sb-filter-clear"
            onClick={() => setFilter("")}
            title="Clear filter (Esc)"
            aria-label="Clear filter"
          >
            ×
          </button>
        )}
      </div>

      <div className="sidebar-scroll">
        {refs.length === 0 && (
          <div className="panel-empty small sidebar-empty">
            {loading ? "Loading refs…" : "표시할 브랜치가 없습니다."}
          </div>
        )}

        <Section
          title="Local"
          total={all.locals.length}
          count={view.locals.length}
          collapsed={isCollapsed("local")}
          emptyLabel={filtering ? "No matches" : undefined}
          onToggle={() => toggle("local")}
        >
          {view.locals.map((ref) => (
            <RefRow
              key={`l:${ref.name}`}
              label={ref.name}
              query={query}
              entry={ref}
              selected={ref.sha === selectedSha}
              onSelect={onSelectRef}
              onContextMenu={openMenu}
            />
          ))}
        </Section>

        <Section
          title="Remote"
          total={all.remoteCount}
          count={view.remoteCount}
          collapsed={isCollapsed("remote")}
          emptyLabel={filtering ? "No matches" : undefined}
          onToggle={() => toggle("remote")}
        >
          {view.remotes.map((remoteGroup) => (
            <Section
              key={remoteGroup.remote}
              title={remoteGroup.remote}
              total={remoteGroup.entries.length}
              count={remoteGroup.entries.length}
              nested
              collapsed={isCollapsed(`remote:${remoteGroup.remote}`)}
              onToggle={() => toggle(`remote:${remoteGroup.remote}`)}
            >
              {remoteGroup.entries.map((ref) => (
                <RefRow
                  key={`r:${ref.name}`}
                  label={splitRemote(ref.name).rest}
                  query={query}
                  entry={ref}
                  nested
                  selected={ref.sha === selectedSha}
                  onSelect={onSelectRef}
                  onContextMenu={openMenu}
                />
              ))}
            </Section>
          ))}
        </Section>

        <Section
          title="Tags"
          total={all.tags.length}
          count={view.tags.length}
          collapsed={isCollapsed("tags")}
          emptyLabel={filtering ? "No matches" : undefined}
          onToggle={() => toggle("tags")}
        >
          {view.tags.map((ref) => (
            <RefRow
              key={`t:${ref.name}`}
              label={ref.name}
              query={query}
              entry={ref}
              selected={ref.sha === selectedSha}
              onSelect={onSelectRef}
              onContextMenu={openMenu}
            />
          ))}
        </Section>
      </div>

      {menu !== null && (
        <SidebarContextMenu
          x={menu.x}
          y={menu.y}
          entry={menu.entry}
          onCopyName={onCopyRefName}
          onOpenOnRemote={onOpenRefOnRemote}
          onJumpToCommit={onSelectRef}
          onClose={() => setMenu(null)}
        />
      )}
    </nav>
  );
}

interface SectionProps {
  title: string;
  /** 필터 이전 항목 수. 0이면 섹션 자체를 숨긴다 */
  total: number;
  /** 실제로 그릴 항목 수 (필터 중이면 매치 수) */
  count: number;
  collapsed: boolean;
  nested?: boolean;
  /** count가 0일 때 목록 대신 보여줄 한 줄 */
  emptyLabel?: string;
  onToggle: () => void;
  children: ReactNode;
}

function Section({
  title,
  total,
  count,
  collapsed,
  nested,
  emptyLabel,
  onToggle,
  children,
}: SectionProps) {
  if (total === 0) {
    return null;
  }
  return (
    <section className={nested === true ? "sb-section nested" : "sb-section"}>
      <button className="sb-head" onClick={onToggle} aria-expanded={!collapsed}>
        <span className={collapsed ? "sb-caret collapsed" : "sb-caret"} aria-hidden="true">
          ▾
        </span>
        <span className="sb-title">{title}</span>
        <span className="sb-count">{count}</span>
      </button>
      {!collapsed &&
        (count === 0 && emptyLabel !== undefined ? (
          <div className="sb-nomatch">{emptyLabel}</div>
        ) : (
          <ul className="sb-list">{children}</ul>
        ))}
    </section>
  );
}

interface RefRowProps {
  label: string;
  /** 소문자 필터어. 빈 문자열이면 강조 없음 */
  query: string;
  entry: RefEntry;
  nested?: boolean;
  selected: boolean;
  onSelect: (sha: string) => void;
  onContextMenu: (entry: RefEntry, x: number, y: number) => void;
}

function RefRow({ label, query, entry, nested, selected, onSelect, onContextMenu }: RefRowProps) {
  const classes = ["sb-item"];
  if (nested === true) {
    classes.push("nested");
  }
  if (entry.isHead) {
    classes.push("head");
  }
  if (selected) {
    classes.push("selected");
  }

  const handleContextMenu = (event: MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    onContextMenu(entry, event.clientX, event.clientY);
  };

  return (
    <li>
      <button
        className={classes.join(" ")}
        onClick={() => onSelect(entry.sha)}
        onContextMenu={handleContextMenu}
        title={`${entry.name} — ${shortSha(entry.sha)}`}
      >
        <span className="sb-check" aria-hidden="true">
          {entry.isHead ? "✓" : ""}
        </span>
        <span className="sb-label">
          <Highlight text={label} query={query} />
        </span>
      </button>
    </li>
  );
}

/** query(소문자)와 일치하는 구간을 <mark>로 감싼다 */
function Highlight({ text, query }: { text: string; query: string }) {
  if (query === "") {
    return <>{text}</>;
  }
  const lower = text.toLowerCase();
  const parts: ReactNode[] = [];
  let cursor = 0;
  let key = 0;

  for (;;) {
    const idx = lower.indexOf(query, cursor);
    if (idx < 0) {
      parts.push(text.slice(cursor));
      break;
    }
    if (idx > cursor) {
      parts.push(text.slice(cursor, idx));
    }
    parts.push(
      <mark key={key} className="sb-mark">
        {text.slice(idx, idx + query.length)}
      </mark>,
    );
    key += 1;
    cursor = idx + query.length;
  }

  return <>{parts}</>;
}
