import { useCallback, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { PullMode, RepoInfo, SyncState } from "../types";
import { ContextMenu } from "./ContextMenu";
import type { MenuItem } from "./ContextMenu";
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
  /** upstream 대비 상태. 없으면 배지를 숨긴다 */
  syncState: SyncState | null;
  /** 실행 중인 쓰기 작업 id. null이 아니면 모든 작업 버튼을 잠근다 */
  busyOp: string | null;
  onFetch: (prune: boolean) => void;
  onPull: (mode: PullMode) => void;
  onPush: () => void;
  onNewBranch: () => void;
  onStash: () => void;
  onStashPop: () => void;
  onOpenTerminal: () => void;
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
  syncState,
  busyOp,
  onFetch,
  onPull,
  onPush,
  onNewBranch,
  onStash,
  onStashPop,
  onOpenTerminal,
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
  const [fetchMenu, setFetchMenu] = useState<{ x: number; y: number } | null>(null);
  const fetchGroupRef = useRef<HTMLDivElement | null>(null);

  const openFetchMenu = useCallback(() => {
    const rect = fetchGroupRef.current?.getBoundingClientRect();
    if (rect === undefined) {
      return;
    }
    setFetchMenu({ x: rect.left, y: rect.bottom + 2 });
  }, []);

  const busy = busyOp !== null;
  const ahead = syncState?.ahead ?? 0;
  const behind = syncState?.behind ?? 0;
  const stashCount = syncState?.stashCount ?? 0;

  const fetchItems: MenuItem[] = [
    { label: "Fetch", onSelect: () => onFetch(false) },
    { label: "Fetch & Prune", onSelect: () => onFetch(true) },
    {
      label: "Pull (fast-forward only)",
      separatorBefore: true,
      onSelect: () => onPull("ff-only"),
    },
    { label: "Pull (merge)", onSelect: () => onPull("merge") },
    { label: "Pull (rebase)", onSelect: () => onPull("rebase") },
  ];

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

      <div className="toolbar-ops">
        <div className="op-split" ref={fetchGroupRef}>
          <button
            className="toolbar-btn op-main"
            onClick={() => onFetch(false)}
            disabled={busy}
            title="Fetch from remote"
          >
            <Spinner on={busyOp === "fetch"}>
              <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
                <path
                  d="M8 2v8m0 0L4.8 6.8M8 10l3.2-3.2M2.5 13h11"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.4"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </Spinner>
            Fetch
            {behind > 0 && <span className="op-badge">{behind}</span>}
          </button>
          <button
            className="toolbar-btn op-caret"
            onClick={openFetchMenu}
            disabled={busy}
            title="Fetch and pull options"
            aria-label="Fetch options"
          >
            ▾
          </button>
        </div>

        <button
          className="toolbar-btn"
          onClick={onPush}
          disabled={busy}
          title="Push current branch"
        >
          <Spinner on={busyOp === "push"}>
            <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
              <path
                d="M8 14V6m0 0L4.8 9.2M8 6l3.2 3.2M2.5 3h11"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.4"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </Spinner>
          Push
          {ahead > 0 && <span className="op-badge">{ahead}</span>}
        </button>

        <button
          className="toolbar-btn"
          onClick={onNewBranch}
          disabled={busy}
          title="Create a branch from HEAD"
        >
          <Spinner on={busyOp === "branch"}>
            <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
              <g fill="none" stroke="currentColor" strokeWidth="1.3">
                <circle cx="4.5" cy="3.6" r="1.6" />
                <circle cx="4.5" cy="12.4" r="1.6" />
                <circle cx="11.5" cy="3.6" r="1.6" />
                <path d="M4.5 5.2v5.6M11.5 5.2v1.3A2.5 2.5 0 0 1 9 9H4.5" />
              </g>
            </svg>
          </Spinner>
          Branch
        </button>

        <button
          className="toolbar-btn"
          onClick={onStash}
          disabled={busy}
          title="Stash working tree changes"
        >
          <Spinner on={busyOp === "stash"}>
            <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
              <g fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round">
                <path d="M2.4 5.6 8 2.6l5.6 3-5.6 3z" />
                <path d="M2.4 8.4 8 11.4l5.6-3" />
              </g>
            </svg>
          </Spinner>
          Stash
        </button>

        <button
          className="toolbar-btn"
          onClick={onStashPop}
          disabled={busy || stashCount === 0}
          title={stashCount === 0 ? "No stash to pop" : "Pop the latest stash"}
        >
          <Spinner on={busyOp === "pop"}>
            <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
              <g fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round">
                <path d="M2.4 10.4 8 13.4l5.6-3" />
                <path d="M8 10.4V2.6m0 0L5.2 5.4M8 2.6l2.8 2.8" strokeLinecap="round" />
              </g>
            </svg>
          </Spinner>
          Pop
          {stashCount > 0 && <span className="op-badge">{stashCount}</span>}
        </button>

        <button
          className="toolbar-btn"
          onClick={onOpenTerminal}
          disabled={busy}
          title="Open repository in terminal"
        >
          <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
            <g fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round">
              <rect x="1.8" y="2.8" width="12.4" height="10.4" rx="1.6" strokeLinejoin="round" />
              <path d="M4.6 6.2 6.8 8l-2.2 1.8M8.6 10.2h3" />
            </g>
          </svg>
          Terminal
        </button>
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

      {fetchMenu !== null && (
        <ContextMenu
          x={fetchMenu.x}
          y={fetchMenu.y}
          items={fetchItems}
          onClose={() => setFetchMenu(null)}
        />
      )}
    </header>
  );
}

/** 작업 중이면 아이콘 자리에 도는 링을, 아니면 원래 아이콘을 보여준다 */
function Spinner({ on, children }: { on: boolean; children: ReactNode }) {
  if (!on) {
    return <>{children}</>;
  }
  return (
    <svg viewBox="0 0 16 16" width="13" height="13" className="spin" aria-hidden="true">
      <path
        d="M14 8a6 6 0 1 1-1.8-4.3"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
    </svg>
  );
}
