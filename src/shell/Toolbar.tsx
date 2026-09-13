import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { PullMode, RepoInfo, SyncState } from "../types";
import { formatCount } from "./format";
import { withKbd } from "./shortcuts";
import "./actions.css";

/**
 * ui-hub가 내려주는 RepoActions 중 툴바가 실제로 쓰는 부분만 로컬로 선언한다.
 * 전체 시그니처는 CONTRACTS.md v0.18의 RepoActions에 동결돼 있고, 이 인터페이스는
 * 그 부분집합이라 구조적으로 그대로 대입된다.
 */
export interface ToolbarActions {
  fetch(opts?: {
    remote?: string;
    prune?: boolean;
    allRemotes?: boolean;
    tags?: boolean;
  }): Promise<void>;
  pull(mode: PullMode): Promise<void>;
  push(opts?: {
    remote?: string;
    branch?: string;
    setUpstream?: boolean;
    forceWithLease?: boolean;
    tags?: boolean;
  }): Promise<void>;
  stashPush(opts?: {
    message?: string;
    includeUntracked?: boolean;
    keepIndex?: boolean;
    files?: string[];
  }): Promise<void>;
  stashApply(ref: string, drop: boolean): Promise<void>;
  /** 쓰기 작업 진행 중이면 액션 버튼을 잠근다 */
  busy: boolean;
}

const PULL_MODE_KEY = "gitlanes.pullMode";

const PULL_MODES: { mode: PullMode; label: string; hint: string }[] = [
  {
    mode: "ff-only",
    label: "Fast-forward only",
    hint: "Refuses to pull when a merge would be needed. Safest default.",
  },
  {
    mode: "merge",
    label: "Merge",
    hint: "Creates a merge commit when local and remote have diverged.",
  },
  {
    mode: "rebase",
    label: "Rebase",
    hint: "Replays your local commits on top of the remote. Rewrites their shas.",
  },
];

function isPullMode(value: string | null): value is PullMode {
  return value === "ff-only" || value === "merge" || value === "rebase";
}

function readPullMode(): PullMode {
  try {
    const stored = window.localStorage.getItem(PULL_MODE_KEY);
    if (isPullMode(stored)) {
      return stored;
    }
  } catch {
    // 사파리 프라이빗 모드 등에서 localStorage 접근이 던질 수 있다. 기본값으로 넘어간다
  }
  return "ff-only";
}

function writePullMode(mode: PullMode) {
  try {
    window.localStorage.setItem(PULL_MODE_KEY, mode);
  } catch {
    // 저장 실패는 기능을 막지 않는다. 다음 실행에 기본값으로 돌아갈 뿐이다
  }
}

/** 스플릿 버튼 드롭다운 한 줄 */
interface ActionMenuItem {
  key: string;
  label: string;
  /** 한 줄 설명. 위험한 조합일수록 반드시 채운다 */
  hint?: string;
  danger?: boolean;
  /** 현재 선택된 항목에 체크 표시 (pull 모드) */
  checked?: boolean;
  disabled?: boolean;
  onSelect: () => void;
}

interface SplitButtonProps {
  label: string;
  icon: ReactNode;
  title: string;
  /** 버튼 본체를 눌렀을 때의 기본 동작. 없으면 드롭다운만 연다 */
  onDefault?: () => void;
  menu?: ActionMenuItem[];
  disabled?: boolean;
  busy?: boolean;
  /** 라벨 오른쪽 배지 (↑3 ↓1 등) */
  badge?: ReactNode;
}

/**
 * GitKraken/SourceGit 공통 패턴: 버튼 본체는 기본 동작을 바로 실행하고,
 * 오른쪽 ▾ 영역만 드롭다운을 연다. 기본 동작을 쓰는 사람이 메뉴를 거치지 않게 하려는 것.
 */
function SplitButton({
  label,
  icon,
  title,
  onDefault,
  menu,
  disabled,
  busy,
  badge,
}: SplitButtonProps) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) {
      return;
    }
    function onDocMouseDown(event: MouseEvent) {
      const wrap = wrapRef.current;
      if (wrap !== null && !wrap.contains(event.target as Node)) {
        setOpen(false);
      }
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        // 셸의 Esc 단계 판정이 이 메뉴를 모르므로 여기서 소비한다
        event.stopPropagation();
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", onDocMouseDown, true);
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("mousedown", onDocMouseDown, true);
      document.removeEventListener("keydown", onKeyDown, true);
    };
  }, [open]);

  const hasMenu = menu !== undefined && menu.length > 0;

  return (
    <div className="act-wrap" ref={wrapRef}>
      <button
        className={hasMenu ? "act-main" : "act-main solo"}
        title={title}
        disabled={disabled === true}
        onClick={() => {
          if (onDefault !== undefined) {
            onDefault();
            return;
          }
          setOpen((v) => !v);
        }}
      >
        <span className={busy === true ? "spin" : undefined} aria-hidden="true">
          {icon}
        </span>
        <span className="act-label">{label}</span>
        {badge}
      </button>
      {hasMenu && (
        <button
          className={open ? "act-caret open" : "act-caret"}
          title={`${label} options`}
          aria-haspopup="menu"
          aria-expanded={open}
          aria-label={`${label} options`}
          disabled={disabled === true}
          onClick={() => setOpen((v) => !v)}
        >
          ▾
        </button>
      )}
      {open && hasMenu && (
        <div className="act-menu" role="menu">
          {menu.map((item) => (
            <button
              key={item.key}
              role="menuitem"
              className={[
                "act-menu-item",
                item.danger === true ? "danger" : "",
                item.checked === true ? "on" : "",
              ]
                .filter((c) => c !== "")
                .join(" ")}
              disabled={item.disabled === true}
              onClick={() => {
                setOpen(false);
                item.onSelect();
              }}
            >
              <span className="act-menu-label">{item.label}</span>
              {item.hint !== undefined && <span className="act-menu-hint">{item.hint}</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function Badge({ count, prefix, warn }: { count: number; prefix: string; warn?: boolean }) {
  if (count <= 0) {
    return null;
  }
  return (
    <span className={warn === true ? "act-badge warn" : "act-badge"}>
      {prefix}
      {count}
    </span>
  );
}

const ICON_DOWN = (
  <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
    <path
      d="M8 2.6v8.2M4.8 7.6 8 10.8l3.2-3.2M3 13.4h10"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

const ICON_UP = (
  <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
    <path
      d="M8 13.4V5.2M4.8 8.4 8 5.2l3.2 3.2M3 2.6h10"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

const ICON_SYNC = (
  <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
    <path
      d="M13.4 8a5.4 5.4 0 1 1-1.6-3.8M13.4 2.2v3.1h-3.1"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

const ICON_BRANCH = (
  <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
    <g fill="none" stroke="currentColor" strokeWidth="1.4">
      <circle cx="4.6" cy="3.6" r="1.6" />
      <circle cx="4.6" cy="12.4" r="1.6" />
      <circle cx="11.4" cy="3.6" r="1.6" />
      <path d="M4.6 5.2v5.6M11.4 5.2v1.3A2.5 2.5 0 0 1 8.9 9H4.6" />
    </g>
  </svg>
);

const ICON_STASH = (
  <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
    <g fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round">
      <path d="M2.2 5.4 8 2.6l5.8 2.8L8 8.2z" />
      <path d="M2.2 8.4 8 11.2l5.8-2.8M2.2 11.2 8 14l5.8-2.8" />
    </g>
  </svg>
);

export interface ToolbarProps {
  repo: RepoInfo;
  /** 툴바 중앙에 놓을 검색 UI */
  search: ReactNode;
  sidebarOpen: boolean;
  onToggleSidebar: () => void;
  /** HEAD 커밋으로 이동 (⌘⇧H) */
  onGoToHead: () => void;
  /** 하단 내장 터미널이 열려 있는가 */
  terminalOpen: boolean;
  onToggleTerminal: () => void;
  /** 레포명 우클릭. 화면 좌표를 그대로 넘긴다 */
  onRepoContextMenu: (clientX: number, clientY: number) => void;
  commitCount: number;
  hasMore: boolean;
  loading: boolean;
  onRefresh: () => void;
  /** 새 버전이 있으면 배지를 띄운다 */
  updateTag: string | null;
  onOpenRelease: () => void;
  /** 현재 앱 버전. 클릭하면 수동으로 업데이트를 확인한다 */
  appVersion: string;
  checkingUpdate: boolean;
  onCheckUpdates: () => void;

  // ── v0.18 액션 그룹. 없으면 액션 그룹 자체를 그리지 않는다 ──
  /** ui-hub가 만든 RepoActions. 확인 다이얼로그/토스트/refresh는 그쪽 책임이다 */
  actions?: ToolbarActions | null;
  /** ahead/behind/upstream 배지의 출처 */
  sync?: SyncState | null;
  /** Branch 버튼. 브랜치 생성 다이얼로그를 여는 건 ui-hub가 한다 */
  onCreateBranch?: () => void;
  /** Stash 드롭다운의 "Stash changes..." (메시지 입력 다이얼로그) */
  onOpenStashDialog?: () => void;
}

/** 액션 그룹이 글자를 접는 임계 폭. 이 아래로는 아이콘만 남는다 */
const COMPACT_WIDTH = 1080;

export function Toolbar({
  repo,
  search,
  sidebarOpen,
  onToggleSidebar,
  onGoToHead,
  terminalOpen,
  onToggleTerminal,
  onRepoContextMenu,
  commitCount,
  hasMore,
  loading,
  onRefresh,
  updateTag,
  onOpenRelease,
  appVersion,
  checkingUpdate,
  onCheckUpdates,
  actions,
  sync,
  onCreateBranch,
  onOpenStashDialog,
}: ToolbarProps) {
  const headerRef = useRef<HTMLElement | null>(null);
  const [compact, setCompact] = useState(false);
  const [pullMode, setPullMode] = useState<PullMode>(readPullMode);

  // 툴바 폭을 직접 재서 액션 라벨을 접는다. 미디어 쿼리로는 사이드바 폭 변화를 못 잡는다
  useLayoutEffect(() => {
    const el = headerRef.current;
    if (el === null || typeof ResizeObserver === "undefined") {
      return;
    }
    const ro = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width ?? 0;
      setCompact(width < COMPACT_WIDTH);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const run = useCallback((task: Promise<void>) => {
    // 결과 처리(토스트/refresh)는 전부 ui-hub의 RepoActions 안에 있다.
    // 여기서는 unhandled rejection만 막는다
    void task.catch(() => undefined);
  }, []);

  const choosePullMode = useCallback(
    (mode: PullMode) => {
      setPullMode(mode);
      writePullMode(mode);
    },
    [],
  );

  const ahead = sync?.ahead ?? 0;
  const behind = sync?.behind ?? 0;
  const hasUpstream = sync?.upstream != null && sync.upstream !== "";
  const busy = actions?.busy === true;
  const currentPull = PULL_MODES.find((m) => m.mode === pullMode) ?? PULL_MODES[0];

  return (
    <header className="toolbar" ref={headerRef}>
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

      {actions != null && (
        <div className={compact ? "act-group compact" : "act-group"}>
          <SplitButton
            label="Fetch"
            icon={ICON_SYNC}
            title={withKbd("Fetch from origin", "Mod+Shift+F")}
            busy={busy}
            disabled={busy}
            onDefault={() => run(actions.fetch())}
            menu={[
              {
                key: "fetch",
                label: "Fetch",
                hint: "Update remote-tracking refs for origin.",
                onSelect: () => run(actions.fetch()),
              },
              {
                key: "fetch-all",
                label: "Fetch all remotes",
                hint: "Runs git fetch --all.",
                onSelect: () => run(actions.fetch({ allRemotes: true })),
              },
              {
                key: "fetch-prune",
                label: "Fetch with prune",
                hint: "Also drops remote-tracking branches deleted on the server.",
                onSelect: () => run(actions.fetch({ prune: true })),
              },
              {
                key: "fetch-tags",
                label: "Fetch tags",
                hint: "Brings down tags that are not reachable from fetched branches.",
                onSelect: () => run(actions.fetch({ tags: true })),
              },
            ]}
          />

          <SplitButton
            label="Pull"
            icon={ICON_DOWN}
            title={withKbd(`Pull (${currentPull.label})`, "Mod+Shift+P")}
            busy={busy}
            disabled={busy}
            badge={<Badge count={behind} prefix="↓" />}
            onDefault={() => run(actions.pull(pullMode))}
            menu={PULL_MODES.map((m) => ({
              key: m.mode,
              label: m.label,
              hint: m.hint,
              checked: m.mode === pullMode,
              onSelect: () => {
                choosePullMode(m.mode);
                run(actions.pull(m.mode));
              },
            }))}
          />

          <SplitButton
            label="Push"
            icon={ICON_UP}
            title={
              hasUpstream
                ? withKbd("Push to upstream", "Mod+Shift+U")
                : withKbd("Push and set upstream", "Mod+Shift+U")
            }
            busy={busy}
            disabled={busy}
            badge={
              hasUpstream ? (
                <Badge count={ahead} prefix="↑" />
              ) : (
                <span className="act-hint">no upstream</span>
              )
            }
            // upstream이 없으면 기본 push가 그냥 실패한다. 기본 동작을 set-upstream으로 바꾼다
            onDefault={() => run(actions.push(hasUpstream ? undefined : { setUpstream: true }))}
            menu={[
              {
                key: "push",
                label: "Push",
                hint: "Sends commits to the tracked upstream branch.",
                disabled: !hasUpstream,
                onSelect: () => run(actions.push()),
              },
              {
                key: "push-upstream",
                label: "Push and set upstream",
                hint: "Runs git push -u so later pushes need no arguments.",
                onSelect: () => run(actions.push({ setUpstream: true })),
              },
              {
                key: "push-tags",
                label: "Push all tags",
                hint: "Sends every local tag that the remote does not have.",
                onSelect: () => run(actions.push({ tags: true })),
              },
              {
                key: "push-force",
                label: "Force push (with lease)",
                hint: "Overwrites the remote branch, but refuses if someone else pushed first.",
                danger: true,
                onSelect: () => run(actions.push({ forceWithLease: true })),
              },
            ]}
          />

          {onCreateBranch !== undefined && (
            <SplitButton
              label="Branch"
              icon={ICON_BRANCH}
              title={withKbd("Create branch", "Mod+Shift+N")}
              disabled={busy}
              onDefault={onCreateBranch}
            />
          )}

          <SplitButton
            label="Stash"
            icon={ICON_STASH}
            title={withKbd("Stash changes", "Mod+Shift+S")}
            busy={busy}
            disabled={busy}
            badge={<Badge count={sync?.stashCount ?? 0} prefix="≡" warn />}
            onDefault={() => run(actions.stashPush())}
            menu={[
              {
                key: "stash",
                label: "Stash changes",
                hint: "Saves tracked modifications and restores a clean tree.",
                onSelect: () => run(actions.stashPush()),
              },
              {
                key: "stash-msg",
                label: "Stash with message...",
                hint: "Opens a dialog for a message and stash options.",
                disabled: onOpenStashDialog === undefined,
                onSelect: () => onOpenStashDialog?.(),
              },
              {
                key: "stash-untracked",
                label: "Stash including untracked",
                hint: "Also stashes files git does not track yet.",
                onSelect: () => run(actions.stashPush({ includeUntracked: true })),
              },
              {
                key: "stash-keep-index",
                label: "Stash but keep index",
                hint: "Leaves what you already staged in place.",
                onSelect: () => run(actions.stashPush({ keepIndex: true })),
              },
              {
                key: "stash-pop",
                label: "Pop latest",
                hint: "Applies stash@{0} and drops it.",
                disabled: (sync?.stashCount ?? 0) === 0,
                onSelect: () => run(actions.stashApply("stash@{0}", true)),
              },
              {
                key: "stash-apply",
                label: "Apply latest",
                hint: "Applies stash@{0} and keeps it on the stack.",
                disabled: (sync?.stashCount ?? 0) === 0,
                onSelect: () => run(actions.stashApply("stash@{0}", false)),
              },
            ]}
          />
        </div>
      )}

      <button
        className={terminalOpen ? "toolbar-icon on" : "toolbar-icon"}
        onClick={onToggleTerminal}
        title={withKbd("Toggle terminal", "Ctrl+`")}
        aria-pressed={terminalOpen}
        aria-label="Toggle terminal"
      >
        <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
          <g fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round">
            <rect x="1.8" y="2.8" width="12.4" height="10.4" rx="1.6" strokeLinejoin="round" />
            <path d="M4.6 6.2 6.8 8l-2.2 1.8M8.6 10.2h3" />
          </g>
        </svg>
      </button>

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
