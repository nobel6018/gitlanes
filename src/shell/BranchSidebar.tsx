import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { DragEvent, MouseEvent, ReactNode, RefObject } from "react";
import type { RefEntry, RemoteInfo, StashInfo, SyncState, WorktreeInfo } from "../types";
import { basename, shortSha } from "./format";
import { kbd, withKbd } from "./shortcuts";
import { ContextMenu } from "./ContextMenu";
import type { MenuItem } from "./ContextMenu";
import { SidebarContextMenu } from "./SidebarContextMenu";
import type {
  SidebarActions,
  SidebarDialogKind,
  SidebarDialogTarget,
  SidebarMenuTarget,
} from "./SidebarContextMenu";
import { hasRefDrag, readRefDrag, writeRefDrag } from "./dnd";
import type { RefDragPayload } from "./dnd";
import "./sidebar.css";

export type {
  SidebarActions,
  SidebarDialogKind,
  SidebarDialogTarget,
} from "./SidebarContextMenu";

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

  // ── v0.18 확장. 전부 옵션이라 배선 전에도 기존 화면이 그대로 돈다 ──
  /** load_graph의 stashes를 그대로 넘긴다. 배열 순서가 stash@{n}의 n이다 */
  stashes?: StashInfo[];
  /** list_remotes 결과. 없으면 Remotes 섹션 헤더 액션을 숨긴다 */
  remotes?: RemoteInfo[];
  /** list_worktrees 결과. 없으면 Worktrees 섹션 자체를 숨긴다 */
  worktrees?: WorktreeInfo[];
  /** 현재 브랜치의 ahead/behind 배지용 */
  syncState?: SyncState | null;
  /** ui-hub의 RepoActions. 없으면 쓰기 메뉴가 전부 비활성 */
  actions?: SidebarActions;
  /** 입력이 필요한 동작을 ui-hub 다이얼로그로 넘긴다 */
  onRequestDialog?: (kind: SidebarDialogKind, target: SidebarDialogTarget) => void;
  /** 워크트리를 새 탭으로 연다 */
  onOpenWorktree?: (path: string) => void;
  /** ref 드래그 시작/종료. ui-hub가 그래프 캔버스의 드롭 타깃을 켜는 데 쓴다 */
  onRefDragStateChange?: (payload: RefDragPayload | null) => void;
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
  target: SidebarMenuTarget;
}

/** 드롭 직후 뜨는 선택지 팝오버 */
interface DropMenuState {
  x: number;
  y: number;
  source: RefDragPayload;
  target: RefEntry;
}

/** 브랜치 이름의 "/"를 접는 폴더 트리 */
interface TreeNode {
  /** localStorage 접힘 키이자 React key */
  key: string;
  /** 표시용 마지막 세그먼트 */
  label: string;
  /** 잎이면 ref, 폴더면 null */
  entry: RefEntry | null;
  children: TreeNode[];
}

/** localStorage key: 사이드바 섹션/폴더 접힘 상태 */
const SECTIONS_KEY = "gitlanes.sidebar.sections";

/** 태그가 이보다 많으면 처음에 접어 둔다 (사용자가 한 번이라도 토글하면 그 값이 이긴다) */
const TAG_AUTO_COLLAPSE = 20;

/** 트리 한 단계 들여쓰기(px) */
const INDENT = 12;

/**
 * 값이 명시적으로 기록된 키만 담긴다. 키가 없으면 "사용자가 정한 적 없음"이고
 * 그때는 섹션별 기본값을 쓴다(예: 태그가 많으면 접힘).
 * v0.11 포맷(접힌 키만 true)과 그대로 호환된다.
 */
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
      if (typeof value === "boolean") {
        out[key] = value;
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

/**
 * 표시 경로를 "/"로 쪼개 폴더 트리를 만든다.
 * keyPrefix는 섹션마다 달라야 한다. 같은 "feature" 폴더라도 local과 origin은 따로 접힌다.
 */
function buildTree(
  items: { path: string; entry: RefEntry }[],
  keyPrefix: string,
): TreeNode[] {
  const roots: TreeNode[] = [];
  const folders = new Map<string, TreeNode>();

  for (const item of items) {
    const segments = item.path.split("/");
    let level = roots;
    let acc = "";

    for (let i = 0; i < segments.length - 1; i += 1) {
      acc = acc === "" ? segments[i] : `${acc}/${segments[i]}`;
      const folderKey = `folder:${keyPrefix}:${acc}`;
      let node = folders.get(folderKey);
      if (node === undefined) {
        node = { key: folderKey, label: segments[i], entry: null, children: [] };
        folders.set(folderKey, node);
        level.push(node);
      }
      level = node.children;
    }

    level.push({
      key: `${keyPrefix}:${item.path}`,
      label: segments[segments.length - 1],
      entry: item.entry,
      children: [],
    });
  }

  sortNodes(roots);
  return roots;
}

/** 폴더 먼저, 그다음 이름순. SourceGit과 같은 순서다 */
function sortNodes(nodes: TreeNode[]): void {
  nodes.sort((a, b) => {
    const aFolder = a.entry === null;
    const bFolder = b.entry === null;
    if (aFolder !== bFolder) {
      return aFolder ? -1 : 1;
    }
    return a.label.localeCompare(b.label);
  });
  for (const node of nodes) {
    if (node.children.length > 0) {
      sortNodes(node.children);
    }
  }
}

/** refs에서 체크아웃된 로컬 브랜치를 찾는다. detached면 null */
function headBranch(refs: RefEntry[]): string | null {
  for (const ref of refs) {
    if (ref.kind === "localBranch" && ref.isHead) {
      return ref.name;
    }
  }
  return null;
}

const MINUTE = 60;
const HOUR = 3600;
const DAY = 86400;

/** 스태시 목록용 짧은 상대 시각 */
function relativeTime(seconds: number): string {
  const diff = Math.max(0, Math.floor(Date.now() / 1000) - seconds);
  if (diff < MINUTE) {
    return "just now";
  }
  if (diff < HOUR) {
    return `${Math.floor(diff / MINUTE)}m ago`;
  }
  if (diff < DAY) {
    return `${Math.floor(diff / HOUR)}h ago`;
  }
  if (diff < DAY * 30) {
    return `${Math.floor(diff / DAY)}d ago`;
  }
  return `${Math.floor(diff / (DAY * 30))}mo ago`;
}

/** 다음 프레임까지 기다린다. ui-hub의 refreshAll 이후 props가 내려올 틈을 준다 */
function nextFrame(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => resolve());
  });
}

export function BranchSidebar({
  refs,
  loading,
  selectedSha,
  onSelectRef,
  onCopyRefName,
  onOpenRefOnRemote,
  filterInputRef,
  stashes,
  remotes,
  worktrees,
  syncState,
  actions,
  onRequestDialog,
  onOpenWorktree,
  onRefDragStateChange,
}: BranchSidebarProps) {
  const all = useMemo(() => group(refs), [refs]);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>(readCollapsed);
  const [filter, setFilter] = useState("");
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [drag, setDrag] = useState<RefDragPayload | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const [dropMenu, setDropMenu] = useState<DropMenuState | null>(null);

  const currentBranch = useMemo(() => headBranch(refs), [refs]);
  // 체크아웃이 실제로 먹었는지 확인하는 용도. 렌더 중이 아니라 커밋 후에 갱신한다
  const refsRef = useRef(refs);
  useEffect(() => {
    refsRef.current = refs;
  }, [refs]);

  useEffect(() => {
    writeCollapsed(collapsed);
  }, [collapsed]);

  // 드래그 상태를 ui-hub로 올려 그래프 캔버스가 같은 드롭을 받게 한다.
  // 콜백을 ref에 담아 의존성에서 빼야 인라인 람다로 내려줘도 매 렌더마다 다시 부르지 않는다
  const dragNotifyRef = useRef(onRefDragStateChange);
  useEffect(() => {
    dragNotifyRef.current = onRefDragStateChange;
  }, [onRefDragStateChange]);
  useEffect(() => {
    dragNotifyRef.current?.(drag);
  }, [drag]);

  // Esc로 드래그 취소. 네이티브 드래그는 브라우저가 끝내 주지만 하이라이트는 우리가 지운다
  useEffect(() => {
    if (drag === null) {
      return;
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setDrag(null);
        setDropTarget(null);
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [drag]);

  const query = filter.trim().toLowerCase();
  const filtering = query !== "";
  const matches = useCallback(
    (text: string) => query === "" || text.toLowerCase().includes(query),
    [query],
  );

  // 리모트 수백 개에서도 입력마다 재계산이 눈에 띄지 않게 메모
  const view = useMemo<Grouped>(() => {
    if (query === "") {
      return all;
    }
    // 표시 라벨은 리모트 접두사가 빠지지만, 매치는 전체 이름 기준으로 본다
    const hit = (ref: RefEntry) => ref.name.toLowerCase().includes(query);
    const remoteGroups = all.remotes
      .map((g) => ({ remote: g.remote, entries: g.entries.filter(hit) }))
      .filter((g) => g.entries.length > 0);
    return {
      locals: all.locals.filter(hit),
      remotes: remoteGroups,
      tags: all.tags.filter(hit),
      remoteCount: remoteGroups.reduce((sum, g) => sum + g.entries.length, 0),
    };
  }, [all, query]);

  const stashList = useMemo(() => {
    const list = stashes ?? [];
    // 배열 인덱스가 곧 stash@{n}이다 (git stash list 순서 = 최신 우선)
    return list.map((stash, index) => ({ stash, ref: `stash@{${index}}` }));
  }, [stashes]);
  const stashView = useMemo(
    () => stashList.filter((item) => matches(item.stash.message) || matches(item.ref)),
    [stashList, matches],
  );

  const worktreeView = useMemo(
    () => (worktrees ?? []).filter((wt) => matches(wt.path) || matches(wt.branch ?? "")),
    [worktrees, matches],
  );

  const defaultRemote = remotes?.[0]?.name ?? all.remotes[0]?.remote ?? "origin";

  const toggle = (key: string, current: boolean) =>
    setCollapsed((prev) => ({ ...prev, [key]: !current }));

  /** 저장된 접힘 상태. 필터와 무관하게 "사용자가 정한 값"이다 */
  const rawCollapsed = (key: string, fallback = false) => collapsed[key] ?? fallback;

  // 필터 중에는 접힘 상태를 무시하고 전부 펼친다 (지우면 원래 상태 복귀)
  const isCollapsed = (key: string, fallback = false) => !filtering && rawCollapsed(key, fallback);

  const openMenu = (target: SidebarMenuTarget, x: number, y: number) =>
    setMenu({ x, y, target });

  const handleCheckout = (entry: RefEntry) => {
    if (actions === undefined || actions.busy) {
      return;
    }
    if (entry.kind === "localBranch" && entry.isHead) {
      return;
    }
    void actions.checkout(entry.name, entry.kind === "remoteBranch").catch(() => {
      // 실패 알림은 ui-hub가 한다
    });
  };

  const dragStart = (event: DragEvent<HTMLElement>, payload: RefDragPayload) => {
    writeRefDrag(event.dataTransfer, payload);
    setDrag(payload);
  };

  const dragEnd = () => {
    setDrag(null);
    setDropTarget(null);
  };

  /** 드롭을 받을 수 있는 행인가. 로컬 브랜치 위에만 놓을 수 있다 */
  const canDrop = (entry: RefEntry) =>
    drag !== null && entry.kind === "localBranch" && drag.name !== entry.name;

  const handleDrop = (event: DragEvent<HTMLElement>, entry: RefEntry) => {
    event.preventDefault();
    const payload = readRefDrag(event.dataTransfer);
    setDrag(null);
    setDropTarget(null);
    if (payload === null || payload.name === entry.name || entry.kind !== "localBranch") {
      return;
    }
    setDropMenu({ x: event.clientX, y: event.clientY, source: payload, target: entry });
  };

  /**
   * 타깃 브랜치를 체크아웃한 뒤 머지/리베이스한다.
   * RepoActions는 성공 여부를 돌려주지 않으므로, 체크아웃 후 refs로 실제 HEAD를 확인하고
   * 확인되지 않으면 두 번째 단계를 하지 않는다. 엉뚱한 브랜치에 머지하는 것보다 아무것도
   * 안 하는 쪽이 낫다 (실패 사유는 ui-hub 토스트에 이미 떠 있다).
   */
  const runOnTarget = async (target: string, run: () => Promise<void>): Promise<void> => {
    if (actions === undefined) {
      return;
    }
    if (headBranch(refsRef.current) !== target) {
      await actions.checkout(target, false);
      await nextFrame();
      if (headBranch(refsRef.current) !== target) {
        return;
      }
    }
    await run();
  };

  const dropItems = (state: DropMenuState): MenuItem[] => {
    const source = state.source.name;
    const target = state.target.name;
    const needsCheckout = currentBranch !== target;
    const note = needsCheckout ? ` (checks out "${target}" first)` : "";
    const busy = actions === undefined || actions.busy;
    const lockTitle =
      actions === undefined
        ? "Repository actions are not available"
        : actions.busy
          ? "Another git operation is running"
          : undefined;
    return [
      {
        label: `Merge "${source}" into "${target}"${note}`,
        disabled: busy,
        title: lockTitle,
        onSelect: () => {
          void runOnTarget(target, () => actions!.merge(source)).catch(() => {});
        },
      },
      {
        label: `Rebase "${target}" onto "${source}"${note}`,
        disabled: busy,
        title: lockTitle,
        onSelect: () => {
          void runOnTarget(target, () => actions!.rebase(source)).catch(() => {});
        },
      },
    ];
  };

  const renderNodes = (nodes: TreeNode[], depth: number, nested: boolean): ReactNode[] =>
    nodes.flatMap((node) => {
      if (node.entry !== null) {
        const entry = node.entry;
        return [
          <li key={node.key}>
            <RefRow
              label={node.label}
              query={query}
              entry={entry}
              depth={depth}
              nested={nested}
              selected={entry.sha === selectedSha}
              badge={entry.isHead ? syncBadge(syncState) : null}
              draggable
              dragging={drag !== null && drag.name === entry.name}
              dimmed={drag !== null && !canDrop(entry) && drag.name !== entry.name}
              dropActive={dropTarget === entry.name}
              onSelect={onSelectRef}
              onActivate={handleCheckout}
              onContextMenu={(e, x, y) => openMenu({ type: "ref", entry: e }, x, y)}
              onDragStart={(event) =>
                dragStart(event, { kind: entry.kind, name: entry.name, sha: entry.sha })
              }
              onDragEnd={dragEnd}
              onDragOver={
                canDrop(entry)
                  ? (event) => {
                      if (!hasRefDrag(event.dataTransfer)) {
                        return;
                      }
                      event.preventDefault();
                      event.dataTransfer.dropEffect = "move";
                      setDropTarget(entry.name);
                    }
                  : undefined
              }
              onDragLeave={() =>
                setDropTarget((prev) => (prev === entry.name ? null : prev))
              }
              onDrop={canDrop(entry) ? (event) => handleDrop(event, entry) : undefined}
            />
          </li>,
        ];
      }

      const folderCollapsed = isCollapsed(node.key);
      const rows: ReactNode[] = [
        <li key={node.key}>
          <FolderRow
            label={node.label}
            depth={depth}
            nested={nested}
            collapsed={folderCollapsed}
            count={countLeaves(node)}
            onToggle={() => toggle(node.key, rawCollapsed(node.key))}
          />
        </li>,
      ];
      if (!folderCollapsed) {
        rows.push(...renderNodes(node.children, depth + 1, nested));
      }
      return rows;
    });

  const localTree = useMemo(
    () => buildTree(view.locals.map((entry) => ({ path: entry.name, entry })), "local"),
    [view.locals],
  );

  const tagTree = useMemo(
    () => buildTree(view.tags.map((entry) => ({ path: entry.name, entry })), "tag"),
    [view.tags],
  );

  const dialogAvailable = onRequestDialog !== undefined;

  return (
    <nav
      className={drag === null ? "sidebar" : "sidebar dragging"}
      aria-label="Branches"
      onDragEnd={dragEnd}
    >
      <div className="sb-filter">
        <input
          ref={filterInputRef}
          className="sb-filter-input"
          type="text"
          value={filter}
          placeholder={`Filter branches (${kbd("Mod+Alt+F")})`}
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
            title={withKbd("Clear filter", "Esc")}
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
          count={view.locals.length}
          collapsed={isCollapsed("local")}
          emptyLabel={filtering ? "No matches" : "No local branches"}
          actionLabel={dialogAvailable ? "New branch" : undefined}
          onAction={() => onRequestDialog?.("createBranch", null)}
          onToggle={() => toggle("local", rawCollapsed("local"))}
        >
          {renderNodes(localTree, 0, false)}
        </Section>

        <Section
          title="Remotes"
          count={view.remoteCount}
          collapsed={isCollapsed("remotes")}
          emptyLabel={filtering ? "No matches" : "No remote branches"}
          actionLabel={dialogAvailable ? "Add remote" : undefined}
          onAction={() => onRequestDialog?.("addRemote", null)}
          onToggle={() => toggle("remotes", rawCollapsed("remotes"))}
        >
          {view.remotes.map((remoteGroup) => {
            const key = `remote:${remoteGroup.remote}`;
            const groupCollapsed = isCollapsed(key);
            const tree = buildTree(
              remoteGroup.entries.map((entry) => ({
                path: splitRemote(entry.name).rest,
                entry,
              })),
              key,
            );
            return (
              <li key={key} className="sb-subsection">
                <RemoteHeader
                  remote={remoteGroup.remote}
                  count={remoteGroup.entries.length}
                  collapsed={groupCollapsed}
                  busy={actions === undefined || actions.busy}
                  onToggle={() => toggle(key, rawCollapsed(key))}
                  onFetch={() => {
                    void actions?.fetch({ remote: remoteGroup.remote }).catch(() => {});
                  }}
                  onContextMenu={(x, y) =>
                    openMenu({ type: "remote", remote: remoteGroup.remote }, x, y)
                  }
                />
                {!groupCollapsed && <ul className="sb-list">{renderNodes(tree, 0, true)}</ul>}
              </li>
            );
          })}
        </Section>

        <Section
          title="Tags"
          count={view.tags.length}
          collapsed={isCollapsed("tags", all.tags.length > TAG_AUTO_COLLAPSE)}
          emptyLabel={filtering ? "No matches" : "No tags"}
          actionLabel={dialogAvailable ? "New tag" : undefined}
          onAction={() => onRequestDialog?.("createTag", null)}
          onToggle={() =>
            toggle("tags", rawCollapsed("tags", all.tags.length > TAG_AUTO_COLLAPSE))
          }
        >
          {renderNodes(tagTree, 0, false)}
        </Section>

        <Section
          title="Stashes"
          count={stashView.length}
          collapsed={isCollapsed("stashes")}
          emptyLabel={filtering ? "No matches" : "No stashes"}
          actionLabel={dialogAvailable ? "Stash changes" : undefined}
          onAction={() => onRequestDialog?.("stashPush", null)}
          onToggle={() => toggle("stashes", rawCollapsed("stashes"))}
        >
          {stashView.map((item) => (
            <li key={item.ref}>
              <StashRow
                stash={item.stash}
                stashRef={item.ref}
                query={query}
                selected={item.stash.sha === selectedSha}
                onSelect={onSelectRef}
                onDragStart={(event) =>
                  dragStart(event, {
                    kind: "stash",
                    name: item.ref,
                    sha: item.stash.sha,
                  })
                }
                onDragEnd={dragEnd}
                onContextMenu={(x, y) =>
                  openMenu({ type: "stash", stash: item.stash, ref: item.ref }, x, y)
                }
              />
            </li>
          ))}
        </Section>

        {worktrees !== undefined && (
          <Section
            title="Worktrees"
            count={worktreeView.length}
            collapsed={isCollapsed("worktrees")}
            emptyLabel={filtering ? "No matches" : "No worktrees"}
            actionLabel={dialogAvailable ? "Add worktree" : undefined}
            onAction={() => onRequestDialog?.("addWorktree", null)}
            onToggle={() => toggle("worktrees", rawCollapsed("worktrees"))}
          >
            {worktreeView.map((worktree) => (
              <li key={worktree.path}>
                <WorktreeRow
                  worktree={worktree}
                  query={query}
                  onOpen={onOpenWorktree}
                  onContextMenu={(x, y) => openMenu({ type: "worktree", worktree }, x, y)}
                />
              </li>
            ))}
          </Section>
        )}
      </div>

      {menu !== null && (
        <SidebarContextMenu
          x={menu.x}
          y={menu.y}
          target={menu.target}
          currentBranch={currentBranch}
          defaultRemote={defaultRemote}
          actions={actions}
          onRequestDialog={onRequestDialog}
          onCopyName={onCopyRefName}
          onOpenOnRemote={onOpenRefOnRemote}
          onJumpToCommit={onSelectRef}
          onOpenWorktree={onOpenWorktree}
          onClose={() => setMenu(null)}
        />
      )}

      {dropMenu !== null && (
        <ContextMenu
          x={dropMenu.x}
          y={dropMenu.y}
          items={dropItems(dropMenu)}
          onClose={() => setDropMenu(null)}
        />
      )}
    </nav>
  );
}

/** 폴더 아래 잎(ref) 개수 */
function countLeaves(node: TreeNode): number {
  if (node.entry !== null) {
    return 1;
  }
  return node.children.reduce((sum, child) => sum + countLeaves(child), 0);
}

/** "↑2 ↓1". 둘 다 0이거나 upstream이 없으면 null */
function syncBadge(state: SyncState | null | undefined): string | null {
  if (state === null || state === undefined || state.upstream === null) {
    return null;
  }
  const parts: string[] = [];
  if (state.ahead > 0) {
    parts.push(`↑${state.ahead}`);
  }
  if (state.behind > 0) {
    parts.push(`↓${state.behind}`);
  }
  return parts.length === 0 ? null : parts.join(" ");
}

interface SectionProps {
  title: string;
  /** 실제로 그릴 항목 수 (필터 중이면 매치 수) */
  count: number;
  collapsed: boolean;
  /** count가 0일 때 목록 대신 보여줄 한 줄 */
  emptyLabel: string;
  /** 헤더 오른쪽 "+" 버튼의 툴팁. undefined면 버튼을 숨긴다 */
  actionLabel?: string;
  onAction: () => void;
  onToggle: () => void;
  children: ReactNode;
}

function Section({
  title,
  count,
  collapsed,
  emptyLabel,
  actionLabel,
  onAction,
  onToggle,
  children,
}: SectionProps) {
  return (
    <section className="sb-section">
      <div className="sb-head-row">
        <button
          className="sb-head"
          onClick={onToggle}
          aria-expanded={!collapsed}
          title={collapsed ? "Expand" : "Collapse"}
        >
          <span className={collapsed ? "sb-caret collapsed" : "sb-caret"} aria-hidden="true">
            ▾
          </span>
          <span className="sb-title">{title}</span>
          <span className="sb-count">{count}</span>
        </button>
        {actionLabel !== undefined && (
          <button
            className="sb-head-action"
            title={actionLabel}
            aria-label={actionLabel}
            onClick={(event) => {
              event.stopPropagation();
              onAction();
            }}
          >
            +
          </button>
        )}
      </div>
      {!collapsed &&
        (count === 0 ? (
          <div className="sb-nomatch">{emptyLabel}</div>
        ) : (
          <ul className="sb-list">{children}</ul>
        ))}
    </section>
  );
}

interface RemoteHeaderProps {
  remote: string;
  count: number;
  collapsed: boolean;
  busy: boolean;
  onToggle: () => void;
  onFetch: () => void;
  onContextMenu: (x: number, y: number) => void;
}

function RemoteHeader({
  remote,
  count,
  collapsed,
  busy,
  onToggle,
  onFetch,
  onContextMenu,
}: RemoteHeaderProps) {
  return (
    <div
      className="sb-head-row nested"
      onContextMenu={(event) => {
        event.preventDefault();
        event.stopPropagation();
        onContextMenu(event.clientX, event.clientY);
      }}
    >
      <button
        className="sb-head sub"
        onClick={onToggle}
        aria-expanded={!collapsed}
        title={collapsed ? "Expand" : "Collapse"}
      >
        <span className={collapsed ? "sb-caret collapsed" : "sb-caret"} aria-hidden="true">
          ▾
        </span>
        <span className="sb-title">{remote}</span>
        <span className="sb-count">{count}</span>
      </button>
      <button
        className="sb-head-action"
        title={`Fetch "${remote}"`}
        aria-label={`Fetch ${remote}`}
        disabled={busy}
        onClick={(event) => {
          event.stopPropagation();
          onFetch();
        }}
      >
        ⟳
      </button>
    </div>
  );
}

interface RefRowProps {
  label: string;
  /** 소문자 필터어. 빈 문자열이면 강조 없음 */
  query: string;
  entry: RefEntry;
  depth: number;
  nested: boolean;
  selected: boolean;
  /** 현재 브랜치의 ahead/behind */
  badge: string | null;
  draggable: boolean;
  dragging: boolean;
  dimmed: boolean;
  dropActive: boolean;
  onSelect: (sha: string) => void;
  /** 더블클릭. GitKraken/SourceGit 공통으로 체크아웃이다 */
  onActivate: (entry: RefEntry) => void;
  onContextMenu: (entry: RefEntry, x: number, y: number) => void;
  onDragStart: (event: DragEvent<HTMLElement>) => void;
  onDragEnd: () => void;
  onDragOver?: (event: DragEvent<HTMLElement>) => void;
  onDragLeave?: () => void;
  onDrop?: (event: DragEvent<HTMLElement>) => void;
}

function RefRow({
  label,
  query,
  entry,
  depth,
  nested,
  selected,
  badge,
  draggable,
  dragging,
  dimmed,
  dropActive,
  onSelect,
  onActivate,
  onContextMenu,
  onDragStart,
  onDragEnd,
  onDragOver,
  onDragLeave,
  onDrop,
}: RefRowProps) {
  const classes = ["sb-item"];
  if (nested) {
    classes.push("nested");
  }
  if (entry.isHead) {
    classes.push("head");
  }
  if (selected) {
    classes.push("selected");
  }
  if (dragging) {
    classes.push("dragging-src");
  }
  if (dimmed) {
    classes.push("dimmed");
  }
  if (onDrop !== undefined) {
    classes.push("droppable");
  }
  if (dropActive) {
    classes.push("drop-active");
  }

  const handleContextMenu = (event: MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    onContextMenu(entry, event.clientX, event.clientY);
  };

  return (
    <button
      className={classes.join(" ")}
      style={{ paddingLeft: indentOf(depth, nested) }}
      draggable={draggable}
      onClick={() => onSelect(entry.sha)}
      onDoubleClick={() => onActivate(entry)}
      onContextMenu={handleContextMenu}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      title={`${entry.name} (${shortSha(entry.sha)})`}
    >
      <span className="sb-check" aria-hidden="true">
        {entry.isHead ? "✓" : ""}
      </span>
      <span className="sb-label">
        <Highlight text={label} query={query} />
      </span>
      {badge !== null && <span className="sb-sync">{badge}</span>}
    </button>
  );
}

interface FolderRowProps {
  label: string;
  depth: number;
  nested: boolean;
  collapsed: boolean;
  count: number;
  onToggle: () => void;
}

function FolderRow({ label, depth, nested, collapsed, count, onToggle }: FolderRowProps) {
  return (
    <button
      className="sb-item sb-folder"
      style={{ paddingLeft: indentOf(depth, nested) }}
      onClick={onToggle}
      aria-expanded={!collapsed}
      title={collapsed ? "Expand" : "Collapse"}
    >
      <span className={collapsed ? "sb-caret collapsed" : "sb-caret"} aria-hidden="true">
        ▾
      </span>
      <span className="sb-label">{label}</span>
      <span className="sb-count">{count}</span>
    </button>
  );
}

interface StashRowProps {
  stash: StashInfo;
  stashRef: string;
  query: string;
  selected: boolean;
  onSelect: (sha: string) => void;
  onDragStart: (event: DragEvent<HTMLElement>) => void;
  onDragEnd: () => void;
  onContextMenu: (x: number, y: number) => void;
}

function StashRow({
  stash,
  stashRef,
  query,
  selected,
  onSelect,
  onDragStart,
  onDragEnd,
  onContextMenu,
}: StashRowProps) {
  const classes = ["sb-item", "sb-stash"];
  if (selected) {
    classes.push("selected");
  }
  return (
    <button
      className={classes.join(" ")}
      style={{ paddingLeft: indentOf(0, false) }}
      draggable
      onClick={() => onSelect(stash.sha)}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onContextMenu={(event) => {
        event.preventDefault();
        event.stopPropagation();
        onContextMenu(event.clientX, event.clientY);
      }}
      title={`${stashRef}: ${stash.message}`}
    >
      <span className="sb-check" aria-hidden="true" />
      <span className="sb-label">
        <Highlight text={stash.message} query={query} />
      </span>
      <span className="sb-meta">{relativeTime(stash.timestamp)}</span>
    </button>
  );
}

interface WorktreeRowProps {
  worktree: WorktreeInfo;
  query: string;
  onOpen?: (path: string) => void;
  onContextMenu: (x: number, y: number) => void;
}

function WorktreeRow({ worktree, query, onOpen, onContextMenu }: WorktreeRowProps) {
  const classes = ["sb-item", "sb-worktree"];
  if (worktree.isPrunable) {
    classes.push("prunable");
  }
  const label = basename(worktree.path);
  const detail = worktree.isMain ? "(this)" : (worktree.branch ?? shortSha(worktree.head));
  return (
    <button
      className={classes.join(" ")}
      style={{ paddingLeft: indentOf(0, false) }}
      onDoubleClick={() => {
        if (!worktree.isMain) {
          onOpen?.(worktree.path);
        }
      }}
      onContextMenu={(event) => {
        event.preventDefault();
        event.stopPropagation();
        onContextMenu(event.clientX, event.clientY);
      }}
      title={
        worktree.isPrunable
          ? `${worktree.path} (missing on disk)`
          : `${worktree.path}\n${worktree.branch ?? "detached"}`
      }
    >
      <span className="sb-check" aria-hidden="true" />
      <span className="sb-label">
        <Highlight text={label} query={query} />
      </span>
      <span className="sb-meta">{detail}</span>
    </button>
  );
}

/** 트리 깊이를 좌측 패딩(px)으로. 기본 들여쓰기는 기존 .sb-item 값과 맞춘다 */
function indentOf(depth: number, nested: boolean): number {
  return (nested ? 24 : 13) + depth * INDENT;
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
