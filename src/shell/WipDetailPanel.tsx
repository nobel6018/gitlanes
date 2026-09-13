// WIP(미커밋 변경) 패널. GitKraken의 WIP 노드처럼 Unstaged / Staged 두 영역으로
// 나누고, untracked는 Unstaged 안에 "새 파일"로 합쳐 보여준다.
// 쓰기는 전부 ui-hub가 내려주는 액션(RepoActions의 부분집합)을 거친다.
// 계약: CONTRACTS.md v0.18 "ui-wip".
import { useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent, ReactNode } from "react";
import type { CommitOptions, FileChange, WipArea, WipDetails } from "../types";
import { FileRow } from "./FileRow";
import type { FileRowAction } from "./FileRow";
import { FileTree, buildFileNavRows, readFileView, writeFileView } from "./FileTree";
import type { FileNavRow, FileRowExtras, FileView } from "./FileTree";
import { CommitBox } from "./CommitBox";
import "./panels.css";
import "./wip.css";

/**
 * RepoWorkspace가 내려주는 액션 중 이 패널이 쓰는 부분만.
 * 전체 정의는 CONTRACTS.md v0.18의 RepoActions다 (시그니처 동결).
 */
export interface WipActions {
  stage(files: string[]): Promise<void>;
  unstage(files: string[]): Promise<void>;
  discard(files: string[]): Promise<void>;
  stageAll(): Promise<void>;
  unstageAll(): Promise<void>;
  applyPatch(patch: string, cached: boolean, reverse: boolean): Promise<void>;
  commit(options: CommitOptions): Promise<void>;
  /** 쓰기 작업이 진행 중인가 (버튼 비활성화용) */
  busy: boolean;
}

export interface WipDetailPanelProps {
  /** 로딩 중 null */
  details: WipDetails | null;
  loading: boolean;
  onOpenFile: (file: FileChange, area: WipArea) => void;
  /** 메인 영역 뷰어에 열려 있는 파일 (강조용) */
  openFile: { path: string; area: WipArea } | null;
  /** 쓰기 액션. 없으면 예전처럼 읽기 전용으로 그린다 */
  actions?: WipActions;
  /** 커밋 초안 저장 키. actions와 함께 있어야 CommitBox가 붙는다 */
  repoPath?: string;
  /** Amend 체크 시 마지막 커밋 메시지를 받아온다 (get_last_commit_message) */
  onRequestLastMessage?: () => Promise<string>;
}

type GroupId = "unstaged" | "staged";

interface Entry {
  file: FileChange;
  /** diff를 열 때 필요한 원래 영역. untracked는 Unstaged에 섞여 있다 */
  area: WipArea;
  /** 선택 집합 키 */
  key: string;
}

interface Group {
  id: GroupId;
  label: string;
  entries: Entry[];
  /** 경로 → 항목. Tree 모드에서 FileChange만 받는 콜백이 area를 되찾는 데 쓴다 */
  byPath: Map<string, Entry>;
  /** Tree 모드의 평면 행. Path 모드에서는 빈 배열 */
  treeRows: FileNavRow[];
  /** 화면에 보이는 순서대로 늘어놓은 파일 키 (Shift 범위 선택용) */
  orderedKeys: string[];
  /** 전체 키보드 인덱스에서 이 그룹의 시작 위치 */
  offset: number;
  /** 이 그룹이 차지하는 키보드 인덱스 개수 */
  count: number;
}

type CollapsedByGroup = Record<GroupId, ReadonlySet<string>>;

function emptyCollapsed(): CollapsedByGroup {
  return { unstaged: new Set<string>(), staged: new Set<string>() };
}

function entryKey(group: GroupId, path: string): string {
  return `${group}:${path}`;
}

/** Unstaged 목록은 unstaged + untracked를 경로 순으로 합친다 (GitKraken 방식) */
function buildUnstagedEntries(details: WipDetails): Entry[] {
  const entries: Entry[] = [
    ...details.unstaged.map((file) => ({
      file,
      area: "unstaged" as WipArea,
      key: entryKey("unstaged", file.path),
    })),
    ...details.untracked.map((file) => ({
      file,
      area: "untracked" as WipArea,
      key: entryKey("unstaged", file.path),
    })),
  ];
  entries.sort((a, b) => a.file.path.localeCompare(b.file.path));
  return entries;
}

export function WipDetailPanel({
  details,
  loading,
  onOpenFile,
  openFile,
  actions,
  repoPath,
  onRequestLastMessage,
}: WipDetailPanelProps) {
  const [fileView, setFileView] = useState<FileView>(readFileView);
  const [collapsed, setCollapsed] = useState<CollapsedByGroup>(emptyCollapsed);
  /** 키보드 포커스 행 (두 그룹을 이어 붙인 전체 인덱스). -1이면 없음 */
  const [focusIndex, setFocusIndex] = useState(-1);
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set<string>());
  /** Shift 범위 선택의 기준점 */
  const anchorRef = useRef<{ group: GroupId; key: string } | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  const groups = useMemo<Group[]>(() => {
    const source: { id: GroupId; label: string; entries: Entry[] }[] = [
      {
        id: "unstaged",
        label: "Unstaged",
        entries: details === null ? [] : buildUnstagedEntries(details),
      },
      {
        id: "staged",
        label: "Staged",
        entries:
          details === null
            ? []
            : details.staged.map((file) => ({
                file,
                area: "staged" as WipArea,
                key: entryKey("staged", file.path),
              })),
      },
    ];

    let offset = 0;
    return source.map(({ id, label, entries }) => {
      const byPath = new Map(entries.map((entry) => [entry.file.path, entry]));
      const treeRows =
        fileView === "tree"
          ? buildFileNavRows(
              entries.map((entry) => entry.file),
              collapsed[id],
            )
          : [];
      const orderedKeys: string[] = [];
      if (fileView === "tree") {
        for (const row of treeRows) {
          if (row.kind === "file") {
            orderedKeys.push(entryKey(id, row.file.path));
          }
        }
      } else {
        for (const entry of entries) {
          orderedKeys.push(entry.key);
        }
      }
      const count = fileView === "tree" ? treeRows.length : entries.length;
      const group: Group = { id, label, entries, byPath, treeRows, orderedKeys, offset, count };
      offset += count;
      return group;
    });
  }, [details, fileView, collapsed]);

  const navCount = groups.reduce((sum, group) => sum + group.count, 0);
  const totalFiles = groups.reduce((sum, group) => sum + group.entries.length, 0);

  // 목록이 줄어들면(뷰 전환, 접기, 새로고침) 포커스를 범위 안으로 당긴다
  useEffect(() => {
    setFocusIndex((prev) => (prev >= navCount ? navCount - 1 : prev));
  }, [navCount]);

  // 새로고침으로 사라진 파일의 선택은 버린다
  useEffect(() => {
    const live = new Set<string>();
    for (const group of groups) {
      for (const entry of group.entries) {
        live.add(entry.key);
      }
    }
    setSelected((prev) => {
      const next = new Set([...prev].filter((key) => live.has(key)));
      return next.size === prev.size ? prev : next;
    });
  }, [groups]);

  // 포커스 행 스크롤 추종. 그룹마다 data-nav-index가 0부터라 group으로 먼저 좁힌다
  useEffect(() => {
    if (focusIndex < 0) {
      return;
    }
    const hit = groups.find(
      (group) => focusIndex >= group.offset && focusIndex < group.offset + group.count,
    );
    if (hit === undefined) {
      return;
    }
    const local = focusIndex - hit.offset;
    listRef.current
      ?.querySelector<HTMLElement>(`[data-group="${hit.id}"] [data-nav-index="${local}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [focusIndex, groups]);

  function changeFileView(next: FileView) {
    setFileView(next);
    setFocusIndex(-1);
    writeFileView(next);
  }

  function toggleDir(group: GroupId, path: string) {
    setCollapsed((prev) => {
      const next = new Set(prev[group]);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return { ...prev, [group]: next };
    });
  }

  /** 전체 인덱스 → 그룹과 그 안의 행 */
  function rowAt(index: number):
    | { group: Group; local: number; row: FileNavRow | null; entry: Entry | null }
    | null {
    const group = groups.find(
      (candidate) => index >= candidate.offset && index < candidate.offset + candidate.count,
    );
    if (group === undefined) {
      return null;
    }
    const local = index - group.offset;
    if (fileView === "tree") {
      const row = group.treeRows[local] ?? null;
      const entry =
        row !== null && row.kind === "file" ? (group.byPath.get(row.file.path) ?? null) : null;
      return { group, local, row, entry };
    }
    return { group, local, row: null, entry: group.entries[local] ?? null };
  }

  function moveFocus(delta: number) {
    if (navCount === 0) {
      return;
    }
    setFocusIndex((prev) => {
      const from = prev < 0 ? (delta > 0 ? -1 : navCount) : prev;
      return Math.max(0, Math.min(navCount - 1, from + delta));
    });
  }

  function activate(index: number) {
    const hit = rowAt(index);
    if (hit === null) {
      return;
    }
    if (hit.entry !== null) {
      onOpenFile(hit.entry.file, hit.entry.area);
      return;
    }
    if (hit.row !== null && hit.row.kind === "dir") {
      toggleDir(hit.group.id, hit.row.path);
    }
  }

  /** 체크박스 토글. range면 같은 그룹 안에서 기준점까지 한 번에 켠다 */
  function toggleSelect(group: Group, key: string, range: boolean) {
    setSelected((prev) => {
      const next = new Set(prev);
      const anchor = anchorRef.current;
      if (range && anchor !== null && anchor.group === group.id) {
        const from = group.orderedKeys.indexOf(anchor.key);
        const to = group.orderedKeys.indexOf(key);
        if (from >= 0 && to >= 0) {
          const [lo, hi] = from <= to ? [from, to] : [to, from];
          for (let i = lo; i <= hi; i++) {
            next.add(group.orderedKeys[i]);
          }
          return next;
        }
      }
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      anchorRef.current = { group: group.id, key };
      return next;
    });
  }

  function clearSelection() {
    anchorRef.current = null;
    setSelected(new Set<string>());
  }

  /** 그룹 안에서 선택된 파일 경로 (화면 순서 그대로) */
  function selectedPaths(group: Group): string[] {
    return group.entries.filter((entry) => selected.has(entry.key)).map((entry) => entry.file.path);
  }

  /** 쓰기 액션을 돌리고 나면 선택을 비운다 (대상이 목록에서 사라진다) */
  function run(action: Promise<void>) {
    clearSelection();
    void action.catch(() => undefined);
  }

  /** Tree 모드에서 같은 그룹 안의 부모 디렉토리 행 (없으면 -1) */
  function parentIndex(index: number): number {
    const hit = rowAt(index);
    if (hit === null || hit.row === null) {
      return -1;
    }
    for (let i = hit.local - 1; i >= 0; i--) {
      if (hit.group.treeRows[i].depth < hit.row.depth) {
        return hit.group.offset + i;
      }
    }
    return -1;
  }

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.metaKey || event.ctrlKey || event.altKey) {
      return;
    }
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        moveFocus(1);
        return;
      case "ArrowUp":
        event.preventDefault();
        moveFocus(-1);
        return;
      case "Home":
        event.preventDefault();
        if (navCount > 0) {
          setFocusIndex(0);
        }
        return;
      case "End":
        event.preventDefault();
        if (navCount > 0) {
          setFocusIndex(navCount - 1);
        }
        return;
      case " ": {
        if (actions === undefined || focusIndex < 0) {
          return;
        }
        event.preventDefault();
        const hit = rowAt(focusIndex);
        if (hit === null || hit.entry === null) {
          return;
        }
        toggleSelect(hit.group, hit.entry.key, event.shiftKey);
        return;
      }
      case "Enter":
        event.preventDefault();
        if (focusIndex < 0) {
          if (navCount > 0) {
            setFocusIndex(0);
            activate(0);
          }
          return;
        }
        activate(focusIndex);
        return;
      case "ArrowRight": {
        event.preventDefault();
        if (focusIndex < 0) {
          moveFocus(1);
          return;
        }
        const hit = rowAt(focusIndex);
        if (hit === null) {
          return;
        }
        if (hit.row !== null && hit.row.kind === "dir") {
          if (hit.row.collapsed) {
            toggleDir(hit.group.id, hit.row.path);
          } else {
            moveFocus(1);
          }
          return;
        }
        activate(focusIndex);
        return;
      }
      case "ArrowLeft": {
        if (fileView !== "tree" || focusIndex < 0) {
          return;
        }
        event.preventDefault();
        const hit = rowAt(focusIndex);
        if (hit === null || hit.row === null) {
          return;
        }
        if (hit.row.kind === "dir" && !hit.row.collapsed) {
          toggleDir(hit.group.id, hit.row.path);
          return;
        }
        const parent = parentIndex(focusIndex);
        if (parent >= 0) {
          setFocusIndex(parent);
        }
        return;
      }
      default:
    }
  }

  if (details === null) {
    return (
      <aside className="detail-panel">
        <div className="panel-scroll">
          <section className="panel-section">
            <div className="wip-title">// WIP</div>
            {loading ? (
              <div className="wip-skeleton" aria-label="Loading working tree changes">
                <span className="wip-skel-line w60" />
                <span className="wip-skel-line w85" />
                <span className="wip-skel-line w45" />
              </div>
            ) : (
              <div className="panel-empty small">워킹 트리 정보를 불러오지 못했습니다.</div>
            )}
          </section>
        </div>
      </aside>
    );
  }

  const busy = actions?.busy === true;

  /** 행 하나에 붙는 체크박스와 hover 액션 */
  function rowExtrasFor(group: Group, entry: Entry): FileRowExtras {
    if (actions === undefined) {
      return { untracked: entry.area === "untracked" };
    }
    const path = entry.file.path;
    const rowActions: FileRowAction[] =
      group.id === "unstaged"
        ? [
            {
              key: "stage",
              glyph: "+",
              label: `Stage ${path}`,
              disabled: busy,
              onRun: () => run(actions.stage([path])),
            },
            {
              key: "discard",
              glyph: "↺",
              label: `Discard ${path}`,
              danger: true,
              disabled: busy,
              onRun: () => run(actions.discard([path])),
            },
          ]
        : [
            {
              key: "unstage",
              glyph: "−",
              label: `Unstage ${path}`,
              disabled: busy,
              onRun: () => run(actions.unstage([path])),
            },
          ];
    return {
      untracked: entry.area === "untracked",
      checked: selected.has(entry.key),
      onToggleCheck: (range) => toggleSelect(group, entry.key, range),
      actions: rowActions,
    };
  }

  function renderGroupBody(group: Group): ReactNode {
    const activePath =
      openFile !== null && (group.id === "staged") === (openFile.area === "staged")
        ? openFile.path
        : null;

    if (fileView === "tree") {
      return (
        <FileTree
          rows={group.treeRows}
          focusIndex={focusIndex - group.offset}
          activePath={activePath}
          rowExtras={(file) => {
            const entry = group.byPath.get(file.path);
            return entry === undefined ? {} : rowExtrasFor(group, entry);
          }}
          onOpen={(file, index) => {
            setFocusIndex(group.offset + index);
            onOpenFile(file, group.byPath.get(file.path)?.area ?? "unstaged");
          }}
          onToggle={(path, index) => {
            setFocusIndex(group.offset + index);
            toggleDir(group.id, path);
          }}
        />
      );
    }

    return (
      <ul className="file-list">
        {group.entries.map((entry, index) => (
          <FileRow
            key={entry.file.path}
            file={entry.file}
            navIndex={index}
            focused={focusIndex === group.offset + index}
            active={entry.file.path === activePath}
            {...rowExtrasFor(group, entry)}
            onOpen={() => {
              setFocusIndex(group.offset + index);
              onOpenFile(entry.file, entry.area);
            }}
          />
        ))}
      </ul>
    );
  }

  function renderGroupHead(group: Group): ReactNode {
    const picked = selectedPaths(group);
    const isUnstaged = group.id === "unstaged";
    return (
      <h3 className="files-title wip-section-title">
        <span className="wip-group-name">
          {group.label}
          <span className={`wip-count wip-count-${group.id}`}>{group.entries.length}</span>
        </span>
        {actions !== undefined && group.entries.length > 0 && (
          <span className="wip-group-acts">
            {picked.length > 0 ? (
              <>
                <button
                  className="wip-btn"
                  disabled={busy}
                  onClick={() =>
                    run(isUnstaged ? actions.stage(picked) : actions.unstage(picked))
                  }
                >
                  {isUnstaged ? "Stage" : "Unstage"} {picked.length} selected
                </button>
                {isUnstaged && (
                  <button
                    className="wip-btn danger"
                    disabled={busy}
                    onClick={() => run(actions.discard(picked))}
                    title={`Discard ${picked.length} selected`}
                  >
                    ↺
                  </button>
                )}
              </>
            ) : (
              <button
                className="wip-btn"
                disabled={busy}
                onClick={() => run(isUnstaged ? actions.stageAll() : actions.unstageAll())}
              >
                {isUnstaged ? "Stage all" : "Unstage all"}
              </button>
            )}
          </span>
        )}
      </h3>
    );
  }

  const counts = {
    staged: details.staged.length,
    unstaged: details.unstaged.length,
    untracked: details.untracked.length,
  };

  return (
    <aside className="detail-panel">
      <div className="panel-scroll">
        <section className="panel-section">
          <div className="wip-head">
            <span className="wip-title">// WIP</span>
            {loading && <span className="wip-refreshing">refreshing…</span>}
            <span className="view-toggle" role="group" aria-label="File list layout">
              <button
                className={fileView === "path" ? "view-btn on" : "view-btn"}
                onClick={() => changeFileView("path")}
                aria-pressed={fileView === "path"}
              >
                Path
              </button>
              <button
                className={fileView === "tree" ? "view-btn on" : "view-btn"}
                onClick={() => changeFileView("tree")}
                aria-pressed={fileView === "tree"}
              >
                Tree
              </button>
            </span>
          </div>
          <div className="file-summary">
            <span className="sum-add">{counts.staged} staged</span>
            <span className="sum-sep"> · </span>
            <span className="sum-mod">{counts.unstaged} unstaged</span>
            <span className="sum-sep"> · </span>
            <span className="sum-untracked">{counts.untracked} untracked</span>
          </div>
        </section>

        {totalFiles === 0 ? (
          <div className="panel-empty">Working tree clean</div>
        ) : (
          // 두 그룹을 하나의 연속 목록처럼 다루는 단일 탭 스톱
          <div
            className="file-nav"
            ref={listRef}
            tabIndex={0}
            aria-label="Working tree changes"
            onKeyDown={handleKeyDown}
          >
            {groups.map((group) =>
              group.entries.length === 0 ? null : (
                <section className="panel-section files" key={group.id} data-group={group.id}>
                  {renderGroupHead(group)}
                  {renderGroupBody(group)}
                </section>
              ),
            )}
          </div>
        )}
      </div>

      {actions !== undefined && repoPath !== undefined && (
        <CommitBox
          repoPath={repoPath}
          stagedCount={counts.staged}
          actions={actions}
          onRequestLastMessage={onRequestLastMessage}
        />
      )}
    </aside>
  );
}
