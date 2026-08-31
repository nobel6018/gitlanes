import type { RepoInfo } from "../types";
import { formatCount } from "./format";

export interface ToolbarProps {
  repo: RepoInfo;
  commitCount: number;
  hasMore: boolean;
  loading: boolean;
  showTags: boolean;
  onToggleTags: () => void;
  onOpen: () => void;
  onRefresh: () => void;
}

export function Toolbar({
  repo,
  commitCount,
  hasMore,
  loading,
  showTags,
  onToggleTags,
  onOpen,
  onRefresh,
}: ToolbarProps) {
  return (
    <header className="toolbar">
      <div className="toolbar-repo">
        <span className="toolbar-repo-name" title={repo.path}>
          {repo.name}
        </span>
        <span className="toolbar-branch" title="Current branch">
          <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
            <g fill="none" stroke="currentColor" strokeWidth="1.3">
              <circle cx="4.5" cy="3.6" r="1.6" />
              <circle cx="4.5" cy="12.4" r="1.6" />
              <circle cx="11.5" cy="3.6" r="1.6" />
              <path d="M4.5 5.2v5.6M11.5 5.2v1.3A2.5 2.5 0 0 1 9 9H4.5" />
            </g>
          </svg>
          {repo.headBranch}
        </span>
      </div>

      <div className="toolbar-spacer">
        <span className="toolbar-count">
          {formatCount(commitCount)} commits{hasMore ? "+" : ""}
        </span>
      </div>

      <button
        className={showTags ? "toolbar-btn toggle on" : "toolbar-btn toggle"}
        onClick={onToggleTags}
        title={showTags ? "Hide tags" : "Show tags"}
        aria-pressed={showTags}
      >
        <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
          <path
            d="M2 2h5.2L14 8.8 8.8 14 2 7.2V2z"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.3"
            strokeLinejoin="round"
          />
          <circle cx="4.8" cy="4.8" r="1.1" fill="currentColor" />
        </svg>
        Tags
      </button>

      <button
        className="toolbar-btn"
        onClick={onRefresh}
        disabled={loading}
        title="Reload graph"
      >
        <svg
          viewBox="0 0 16 16"
          width="13"
          height="13"
          aria-hidden="true"
          className={loading ? "spin" : undefined}
        >
          <path
            d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9M13.5 2v3h-3"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.4"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
        Refresh
      </button>

      <button className="toolbar-btn primary" onClick={onOpen} title="Open another repository">
        Open Repository
      </button>
    </header>
  );
}
