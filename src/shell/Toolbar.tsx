import type { ReactNode } from "react";
import type { RepoInfo } from "../types";
import { formatCount } from "./format";

export interface ToolbarProps {
  repo: RepoInfo;
  /** 툴바 중앙에 놓을 검색 UI */
  search: ReactNode;
  sidebarOpen: boolean;
  onToggleSidebar: () => void;
  commitCount: number;
  hasMore: boolean;
  loading: boolean;
  showTags: boolean;
  onToggleTags: () => void;
  onRefresh: () => void;
  /** 새 버전이 있으면 배지를 띄운다 */
  updateTag: string | null;
  onOpenRelease: () => void;
  /** 현재 앱 버전. 클릭하면 수동으로 업데이트를 확인한다 */
  appVersion: string;
  checkingUpdate: boolean;
  onCheckUpdates: () => void;
}

export function Toolbar({
  repo,
  search,
  sidebarOpen,
  onToggleSidebar,
  commitCount,
  hasMore,
  loading,
  showTags,
  onToggleTags,
  onRefresh,
  updateTag,
  onOpenRelease,
  appVersion,
  checkingUpdate,
  onCheckUpdates,
}: ToolbarProps) {
  return (
    <header className="toolbar">
      <button
        className={sidebarOpen ? "toolbar-icon on" : "toolbar-icon"}
        onClick={onToggleSidebar}
        title={sidebarOpen ? "Hide branch sidebar" : "Show branch sidebar"}
        aria-pressed={sidebarOpen}
        aria-label="Toggle branch sidebar"
      >
        <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
          <g fill="none" stroke="currentColor" strokeWidth="1.3">
            <rect x="1.7" y="2.7" width="12.6" height="10.6" rx="1.6" />
            <path d="M6.2 2.7v10.6" />
          </g>
        </svg>
      </button>

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
        {search}
        <span className="toolbar-count">
          {formatCount(commitCount)} commits{hasMore ? "+" : ""}
        </span>
      </div>

      <button
        className="version-label"
        onClick={onCheckUpdates}
        disabled={checkingUpdate}
        title="업데이트 확인"
      >
        v{appVersion}
      </button>

      {updateTag !== null && (
        <button
          className="update-badge"
          onClick={onOpenRelease}
          title={`새 버전 ${updateTag}가 있습니다. 릴리스 페이지 열기`}
        >
          {updateTag} ↑
        </button>
      )}

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
    </header>
  );
}
