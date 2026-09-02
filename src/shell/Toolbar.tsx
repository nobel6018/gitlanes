import type { ReactNode } from "react";
import type { RepoInfo } from "../types";
import { formatCount } from "./format";
import { withKbd } from "./shortcuts";

export interface ToolbarProps {
  repo: RepoInfo;
  /** 툴바 중앙에 놓을 검색 UI */
  search: ReactNode;
  sidebarOpen: boolean;
  onToggleSidebar: () => void;
  /** HEAD 커밋으로 이동 (⌘⇧H) */
  onGoToHead: () => void;
  /** 레포명 우클릭. 화면 좌표를 그대로 넘긴다 */
  onRepoContextMenu: (clientX: number, clientY: number) => void;
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
  onGoToHead,
  onRepoContextMenu,
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
        title={withKbd(sidebarOpen ? "Hide branch sidebar" : "Show branch sidebar", "Mod+B")}
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

      <div
        className="toolbar-repo"
        onContextMenu={(e) => {
          e.preventDefault();
          onRepoContextMenu(e.clientX, e.clientY);
        }}
      >
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
        title="Check for updates"
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

      <button className="toolbar-btn" onClick={onGoToHead} title={withKbd("Go to HEAD", "Mod+Shift+H")}>
        <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
          <g fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round">
            <circle cx="8" cy="10.6" r="2.4" />
            <path d="M8 8.2V2.4M5.6 4.8 8 2.4l2.4 2.4" strokeLinejoin="round" />
          </g>
        </svg>
        HEAD
      </button>

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
        title={withKbd("Reload graph", "Mod+R")}
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
