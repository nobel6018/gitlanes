import { useMemo, useState } from "react";
import type { ReactNode } from "react";
import type { RefEntry } from "../types";
import { shortSha } from "./format";

export interface BranchSidebarProps {
  refs: RefEntry[];
  loading: boolean;
  selectedSha: string | null;
  /** 항목 클릭 시 해당 커밋으로 점프 요청 */
  onSelectRef: (sha: string) => void;
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

export function BranchSidebar({ refs, loading, selectedSha, onSelectRef }: BranchSidebarProps) {
  const { locals, remotes, tags, remoteCount } = useMemo(() => group(refs), [refs]);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});

  const toggle = (key: string) =>
    setCollapsed((prev) => ({ ...prev, [key]: !prev[key] }));

  return (
    <nav className="sidebar" aria-label="Branches">
      <div className="sidebar-scroll">
        {refs.length === 0 && (
          <div className="panel-empty small sidebar-empty">
            {loading ? "Loading refs…" : "표시할 브랜치가 없습니다."}
          </div>
        )}

        <Section
          title="Local"
          count={locals.length}
          collapsed={collapsed["local"] === true}
          onToggle={() => toggle("local")}
        >
          {locals.map((ref) => (
            <RefRow
              key={`l:${ref.name}`}
              label={ref.name}
              entry={ref}
              selected={ref.sha === selectedSha}
              onSelect={onSelectRef}
            />
          ))}
        </Section>

        <Section
          title="Remote"
          count={remoteCount}
          collapsed={collapsed["remote"] === true}
          onToggle={() => toggle("remote")}
        >
          {remotes.map((group) => (
            <Section
              key={group.remote}
              title={group.remote}
              count={group.entries.length}
              nested
              collapsed={collapsed[`remote:${group.remote}`] === true}
              onToggle={() => toggle(`remote:${group.remote}`)}
            >
              {group.entries.map((ref) => (
                <RefRow
                  key={`r:${ref.name}`}
                  label={splitRemote(ref.name).rest}
                  entry={ref}
                  nested
                  selected={ref.sha === selectedSha}
                  onSelect={onSelectRef}
                />
              ))}
            </Section>
          ))}
        </Section>

        <Section
          title="Tags"
          count={tags.length}
          collapsed={collapsed["tags"] === true}
          onToggle={() => toggle("tags")}
        >
          {tags.map((ref) => (
            <RefRow
              key={`t:${ref.name}`}
              label={ref.name}
              entry={ref}
              selected={ref.sha === selectedSha}
              onSelect={onSelectRef}
            />
          ))}
        </Section>
      </div>
    </nav>
  );
}

interface SectionProps {
  title: string;
  count: number;
  collapsed: boolean;
  nested?: boolean;
  onToggle: () => void;
  children: ReactNode;
}

function Section({ title, count, collapsed, nested, onToggle, children }: SectionProps) {
  if (count === 0) {
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
      {!collapsed && <ul className="sb-list">{children}</ul>}
    </section>
  );
}

interface RefRowProps {
  label: string;
  entry: RefEntry;
  nested?: boolean;
  selected: boolean;
  onSelect: (sha: string) => void;
}

function RefRow({ label, entry, nested, selected, onSelect }: RefRowProps) {
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

  return (
    <li>
      <button
        className={classes.join(" ")}
        onClick={() => onSelect(entry.sha)}
        title={`${entry.name} — ${shortSha(entry.sha)}`}
      >
        <span className="sb-check" aria-hidden="true">
          {entry.isHead ? "✓" : ""}
        </span>
        <span className="sb-label">{label}</span>
      </button>
    </li>
  );
}
