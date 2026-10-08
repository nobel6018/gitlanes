import type { PullMode, RefEntry, StashInfo, SubmoduleInfo, WorktreeInfo } from "../types";
import { ContextMenu } from "./ContextMenu";
import type { MenuItem } from "./ContextMenu";

// ─────────────────────────────────────────────────────────────
// 이 패널은 Tauri command를 직접 부르지 않는다. 쓰기는 전부 ui-hub가 내려준
// RepoActions(부분집합 = SidebarActions)를 통하고, 입력이 필요한 것은
// onRequestDialog로 넘긴다. 확인 다이얼로그/토스트/새로고침은 ui-hub 몫이다.
// ─────────────────────────────────────────────────────────────

/** RepoActions(CONTRACTS v0.18)에서 사이드바가 실제로 쓰는 부분만. 전체 객체를 그대로 내려도 맞는다 */
export interface SidebarActions {
  checkout(target: string, createLocal: boolean): Promise<void>;
  merge(source: string, opts?: { noFf?: boolean; squash?: boolean }): Promise<void>;
  rebase(upstream: string, onto?: string | null): Promise<void>;
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
  pushTag(remote: string, name: string, del: boolean): Promise<void>;
  stashApply(ref: string, sha: string | null, drop: boolean): Promise<void>;
  /** 쓰기 작업이 진행 중이면 메뉴 항목을 잠근다 */
  busy: boolean;
}

/**
 * 사용자 입력이 필요한 동작. 사이드바는 다이얼로그를 만들지 않고 종류와 대상만 넘긴다.
 * 파괴적인 것(delete*, removeWorktree, stashDrop)도 여기로 보내 ui-hub의 ConfirmDialog를 태운다.
 */
export type SidebarDialogKind =
  | "createBranch"
  | "renameBranch"
  | "deleteBranch"
  | "deleteRemoteBranch"
  | "setUpstream"
  | "createTag"
  | "deleteTag"
  | "deleteTagOnRemote"
  | "stashPush"
  | "stashDrop"
  | "stashBranch"
  | "addRemote"
  | "editRemoteUrl"
  | "renameRemote"
  | "removeRemote"
  | "addWorktree"
  | "removeWorktree";

/**
 * 다이얼로그 대상. 종류별로 의미가 다르다.
 *  - createBranch / createTag: start point ref 이름 (섹션 헤더의 +에서는 null)
 *  - renameBranch / deleteBranch / setUpstream: 로컬 브랜치 이름
 *  - deleteRemoteBranch: "origin/foo" 전체 이름
 *  - deleteTag / deleteTagOnRemote: 태그 이름
 *  - stashDrop / stashBranch: "stash@{0}" 형태 ref. 그 행의 StashInfo.sha를 세 번째 인자로 함께
 *    넘긴다 (v0.16). 셸이 command에 실어 Rust가 번호 밀림을 잡는다
 *  - addRemote / stashPush / addWorktree: null
 *  - editRemoteUrl / renameRemote / removeRemote: remote 이름
 *  - removeWorktree: 워크트리 절대 경로
 */
export type SidebarDialogTarget = string | null;

export type SidebarMenuTarget =
  | { type: "ref"; entry: RefEntry }
  | { type: "stash"; stash: StashInfo; ref: string }
  | { type: "worktree"; worktree: WorktreeInfo }
  | { type: "remote"; remote: string }
  | { type: "submodule"; sub: SubmoduleInfo };

export interface SidebarContextMenuProps {
  x: number;
  y: number;
  target: SidebarMenuTarget;
  /** 체크아웃된 로컬 브랜치. detached HEAD면 null */
  currentBranch: string | null;
  /** push tag 등 remote 인자가 필요한 동작의 기본값 */
  defaultRemote: string;
  actions?: SidebarActions;
  onRequestDialog?: (
    kind: SidebarDialogKind,
    target: SidebarDialogTarget,
    stashSha?: string,
  ) => void;
  onCopyName: (name: string) => void;
  /** undefined면 "Open on Remote" 항목을 아예 넣지 않는다 */
  onOpenOnRemote?: (ref: RefEntry) => void;
  /** 항목 클릭(=커밋 점프)과 같은 동작 */
  onJumpToCommit: (sha: string) => void;
  /** 현재 브랜치(base)와 이 브랜치(head)를 비교한다 (v0.18). undefined면 항목을 넣지 않는다 */
  onCompareWithCurrent?: (name: string) => void;
  /** 워크트리를 새 탭으로 연다. undefined면 항목을 비활성 */
  onOpenWorktree?: (path: string) => void;
  /** 서브모듈을 새 탭으로 연다 (v0.19). undefined면 항목을 비활성 */
  onOpenSubmodule?: (sub: SubmoduleInfo) => void;
  /**
   * 서브모듈 Initialize(uninitialized일 때) 또는 Update to Recorded Commit(moved일 때) (v0.19).
   * 어느 쪽인지는 셸이 sub.state로 정하고 확인창도 셸이 띄운다
   */
  onUpdateSubmodule?: (sub: SubmoduleInfo) => void;
  onClose: () => void;
}

/**
 * 액션 호출을 감싸 rejection을 삼킨다.
 * 실패 처리(토스트, 터미널 핸드오프)는 ui-hub 책임이라 여기서 다시 알릴 곳이 없고,
 * 잡지 않으면 unhandledrejection으로 새어 나간다.
 */
function fire(run: () => Promise<void>): void {
  void run().catch(() => {
    // ui-hub가 이미 알렸다
  });
}

/** "origin/feature/x" -> "feature/x" */
function stripRemote(name: string): string {
  const idx = name.indexOf("/");
  return idx < 0 ? name : name.slice(idx + 1);
}

/** 사이드바 항목 우클릭 메뉴. 위치 보정, 바깥 클릭, Esc 닫힘은 공용 ContextMenu가 처리한다 */
export function SidebarContextMenu(props: SidebarContextMenuProps) {
  const items = buildItems(props);
  return <ContextMenu x={props.x} y={props.y} items={items} onClose={props.onClose} />;
}

function buildItems(props: SidebarContextMenuProps): MenuItem[] {
  switch (props.target.type) {
    case "ref":
      return refItems(props, props.target.entry);
    case "stash":
      return stashItems(props, props.target.stash, props.target.ref);
    case "worktree":
      return worktreeItems(props, props.target.worktree);
    case "remote":
      return remoteItems(props, props.target.remote);
    case "submodule":
      return submoduleItems(props, props.target.sub);
  }
}

function refItems(props: SidebarContextMenuProps, entry: RefEntry): MenuItem[] {
  switch (entry.kind) {
    case "localBranch":
      return localBranchItems(props, entry);
    case "remoteBranch":
      return remoteBranchItems(props, entry);
    case "tag":
      return tagItems(props, entry);
  }
}

/** 액션이 아직 배선되지 않았거나 다른 쓰기가 도는 중이면 잠근다 */
function lock(actions: SidebarActions | undefined): { disabled: boolean; title?: string } {
  if (actions === undefined) {
    return { disabled: true, title: "Repository actions are not available" };
  }
  if (actions.busy) {
    return { disabled: true, title: "Another git operation is running" };
  }
  return { disabled: false };
}

function dialogLock(
  onRequestDialog: SidebarContextMenuProps["onRequestDialog"],
): { disabled: boolean; title?: string } {
  if (onRequestDialog === undefined) {
    return { disabled: true, title: "Repository actions are not available" };
  }
  return { disabled: false };
}

function localBranchItems(props: SidebarContextMenuProps, entry: RefEntry): MenuItem[] {
  const { actions, onRequestDialog, currentBranch } = props;
  const act = lock(actions);
  const dlg = dialogLock(onRequestDialog);
  const name = entry.name;
  const isCurrent = currentBranch !== null && currentBranch === name;
  const items: MenuItem[] = [];

  items.push({
    label: `Checkout "${name}"`,
    disabled: act.disabled || isCurrent,
    title: isCurrent ? "Already checked out" : act.title,
    onSelect: () => fire(() => actions!.checkout(name, false)),
  });

  // 방향을 라벨에 박아 넣는다. git GUI 사고의 대부분이 머지/리베이스 방향 착각에서 나온다
  if (currentBranch !== null && !isCurrent) {
    items.push({
      label: `Merge "${name}" into "${currentBranch}"`,
      separatorBefore: true,
      disabled: act.disabled,
      title: act.title,
      onSelect: () => fire(() => actions!.merge(name)),
    });
    items.push({
      label: `Rebase "${currentBranch}" onto "${name}"`,
      disabled: act.disabled,
      title: act.title,
      onSelect: () => fire(() => actions!.rebase(name)),
    });
  }
  items.push(...compareItems(props, name, isCurrent));

  items.push({
    label: `Push "${name}"`,
    separatorBefore: true,
    disabled: act.disabled,
    title: act.title,
    onSelect: () => fire(() => actions!.push({ branch: name })),
  });
  if (isCurrent) {
    // pull은 체크아웃된 브랜치에만 의미가 있다
    items.push({
      label: "Pull",
      disabled: act.disabled,
      title: act.title,
      onSelect: () => fire(() => actions!.pull("ff-only")),
    });
  }
  items.push({
    label: "Set Upstream…",
    disabled: dlg.disabled,
    title: dlg.title,
    onSelect: () => onRequestDialog!("setUpstream", name),
  });

  items.push({
    label: "Rename…",
    separatorBefore: true,
    disabled: dlg.disabled,
    title: dlg.title,
    onSelect: () => onRequestDialog!("renameBranch", name),
  });
  items.push({
    label: "Delete…",
    danger: true,
    disabled: dlg.disabled || isCurrent,
    title: isCurrent ? "Cannot delete the checked out branch" : dlg.title,
    onSelect: () => onRequestDialog!("deleteBranch", name),
  });

  items.push(...createHereItems(props, name));
  items.push(...commonRefItems(props, entry));
  return items;
}

function remoteBranchItems(props: SidebarContextMenuProps, entry: RefEntry): MenuItem[] {
  const { actions, onRequestDialog, currentBranch } = props;
  const act = lock(actions);
  const dlg = dialogLock(onRequestDialog);
  const name = entry.name;
  const local = stripRemote(name);
  const items: MenuItem[] = [];

  items.push({
    label: `Checkout "${local}"`,
    disabled: act.disabled,
    title: act.title ?? `Creates local branch "${local}" tracking "${name}"`,
    onSelect: () => fire(() => actions!.checkout(name, true)),
  });

  if (currentBranch !== null) {
    items.push({
      label: `Merge "${name}" into "${currentBranch}"`,
      separatorBefore: true,
      disabled: act.disabled,
      title: act.title,
      onSelect: () => fire(() => actions!.merge(name)),
    });
    items.push({
      label: `Rebase "${currentBranch}" onto "${name}"`,
      disabled: act.disabled,
      title: act.title,
      onSelect: () => fire(() => actions!.rebase(name)),
    });
  }
  items.push(...compareItems(props, name, false));

  items.push({
    label: "Delete Remote Branch…",
    separatorBefore: true,
    danger: true,
    disabled: dlg.disabled,
    title: dlg.title,
    onSelect: () => onRequestDialog!("deleteRemoteBranch", name),
  });

  items.push(...createHereItems(props, name));
  items.push(...commonRefItems(props, entry));
  return items;
}

function tagItems(props: SidebarContextMenuProps, entry: RefEntry): MenuItem[] {
  const { actions, onRequestDialog, defaultRemote } = props;
  const act = lock(actions);
  const dlg = dialogLock(onRequestDialog);
  const name = entry.name;
  const items: MenuItem[] = [];

  items.push({
    label: `Checkout "${name}"`,
    disabled: act.disabled,
    title: act.title ?? "Checks out a detached HEAD at this tag",
    onSelect: () => fire(() => actions!.checkout(name, false)),
  });
  items.push({
    label: `Push Tag to "${defaultRemote}"`,
    separatorBefore: true,
    disabled: act.disabled,
    title: act.title,
    onSelect: () => fire(() => actions!.pushTag(defaultRemote, name, false)),
  });
  items.push({
    label: "Delete Tag…",
    separatorBefore: true,
    danger: true,
    disabled: dlg.disabled,
    title: dlg.title,
    onSelect: () => onRequestDialog!("deleteTag", name),
  });
  items.push({
    label: "Delete Tag on Remote…",
    danger: true,
    disabled: dlg.disabled,
    title: dlg.title,
    onSelect: () => onRequestDialog!("deleteTagOnRemote", name),
  });

  items.push(...createHereItems(props, name));
  items.push(...commonRefItems(props, entry));
  return items;
}

/**
 * 비교는 읽기 전용이라 쓰기 잠금(busy)과 무관하다. 현재 브랜치가 없거나(detached) 자기 자신이면 넣지 않는다.
 * base가 현재 브랜치라 목록의 "head에만 있는 커밋"이 곧 이 브랜치를 머지하면 들어올 커밋이다
 */
function compareItems(props: SidebarContextMenuProps, name: string, isCurrent: boolean): MenuItem[] {
  const { currentBranch, onCompareWithCurrent } = props;
  if (onCompareWithCurrent === undefined || currentBranch === null || isCurrent) {
    return [];
  }
  return [
    {
      label: "Compare with current branch",
      separatorBefore: true,
      title: `Commits and files that differ between "${currentBranch}" and "${name}"`,
      onSelect: () => onCompareWithCurrent(name),
    },
  ];
}

/** 이 ref를 start point로 삼는 생성 항목들 */
function createHereItems(props: SidebarContextMenuProps, startPoint: string): MenuItem[] {
  const dlg = dialogLock(props.onRequestDialog);
  return [
    {
      label: "Create Branch Here…",
      separatorBefore: true,
      disabled: dlg.disabled,
      title: dlg.title,
      onSelect: () => props.onRequestDialog!("createBranch", startPoint),
    },
    {
      label: "Create Tag Here…",
      disabled: dlg.disabled,
      title: dlg.title,
      onSelect: () => props.onRequestDialog!("createTag", startPoint),
    },
  ];
}

/** 모든 ref 메뉴 공통 꼬리 */
function commonRefItems(props: SidebarContextMenuProps, entry: RefEntry): MenuItem[] {
  const items: MenuItem[] = [
    { label: "Copy Name", separatorBefore: true, onSelect: () => props.onCopyName(entry.name) },
  ];
  if (props.onOpenOnRemote !== undefined) {
    items.push({ label: "Open on Remote", onSelect: () => props.onOpenOnRemote!(entry) });
  }
  items.push({ label: "Jump to Commit", onSelect: () => props.onJumpToCommit(entry.sha) });
  return items;
}

function stashItems(
  props: SidebarContextMenuProps,
  stash: StashInfo,
  ref: string,
): MenuItem[] {
  const { actions, onRequestDialog } = props;
  const act = lock(actions);
  const dlg = dialogLock(onRequestDialog);
  return [
    {
      label: "Apply",
      disabled: act.disabled,
      title: act.title ?? "Applies the stash and keeps it in the list",
      onSelect: () => fire(() => actions!.stashApply(ref, stash.sha, false)),
    },
    {
      label: "Pop",
      disabled: act.disabled,
      title: act.title ?? "Applies the stash and removes it from the list",
      onSelect: () => fire(() => actions!.stashApply(ref, stash.sha, true)),
    },
    {
      label: "Create Branch from Stash…",
      separatorBefore: true,
      disabled: dlg.disabled,
      title: dlg.title,
      onSelect: () => onRequestDialog!("stashBranch", ref, stash.sha),
    },
    {
      label: "Drop…",
      separatorBefore: true,
      danger: true,
      disabled: dlg.disabled,
      title: dlg.title,
      onSelect: () => onRequestDialog!("stashDrop", ref, stash.sha),
    },
    {
      label: "Jump to Commit",
      separatorBefore: true,
      onSelect: () => props.onJumpToCommit(stash.sha),
    },
  ];
}

function worktreeItems(props: SidebarContextMenuProps, worktree: WorktreeInfo): MenuItem[] {
  const { onOpenWorktree, onRequestDialog } = props;
  const dlg = dialogLock(onRequestDialog);
  const openDisabled = onOpenWorktree === undefined || worktree.isMain;
  return [
    {
      label: "Open in New Tab",
      disabled: openDisabled,
      title: worktree.isMain ? "This worktree is already open" : undefined,
      onSelect: () => onOpenWorktree!(worktree.path),
    },
    {
      label: "Remove…",
      separatorBefore: true,
      danger: true,
      disabled: dlg.disabled || worktree.isMain,
      title: worktree.isMain ? "Cannot remove the worktree you are in" : dlg.title,
      onSelect: () => onRequestDialog!("removeWorktree", worktree.path),
    },
    {
      label: "Copy Path",
      separatorBefore: true,
      onSelect: () => props.onCopyName(worktree.path),
    },
  ];
}

function remoteItems(props: SidebarContextMenuProps, remote: string): MenuItem[] {
  const { actions, onRequestDialog } = props;
  const act = lock(actions);
  const dlg = dialogLock(onRequestDialog);
  return [
    {
      label: `Fetch "${remote}"`,
      disabled: act.disabled,
      title: act.title,
      onSelect: () => fire(() => actions!.fetch({ remote })),
    },
    {
      label: `Fetch "${remote}" with Prune`,
      disabled: act.disabled,
      title: act.title ?? "Removes remote branches that no longer exist",
      onSelect: () => fire(() => actions!.fetch({ remote, prune: true })),
    },
    {
      label: "Edit URL…",
      separatorBefore: true,
      disabled: dlg.disabled,
      title: dlg.title,
      onSelect: () => onRequestDialog!("editRemoteUrl", remote),
    },
    {
      label: "Rename…",
      disabled: dlg.disabled,
      title: dlg.title,
      onSelect: () => onRequestDialog!("renameRemote", remote),
    },
    {
      label: "Remove…",
      separatorBefore: true,
      danger: true,
      disabled: dlg.disabled,
      title: dlg.title,
      onSelect: () => onRequestDialog!("removeRemote", remote),
    },
    { label: "Copy Name", separatorBefore: true, onSelect: () => props.onCopyName(remote) },
  ];
}

function submoduleItems(props: SidebarContextMenuProps, sub: SubmoduleInfo): MenuItem[] {
  const { onOpenSubmodule, onUpdateSubmodule } = props;
  const uninitialized = sub.state === "uninitialized";
  // update는 쓰기라 busy 잠금을 따른다. 셸이 핸들러를 안 주면 쓰기 액션 없이 뜬 것으로 본다
  const act = onUpdateSubmodule === undefined ? lock(undefined) : lock(props.actions);
  // 목록 더블클릭과 같은 기준: update 도중 열면 반쯤 옮겨진 체크아웃을 보게 된다
  const busy = props.actions?.busy === true;
  const items: MenuItem[] = [
    {
      label: "Open Submodule",
      disabled: onOpenSubmodule === undefined || uninitialized || busy,
      title: uninitialized
        ? "Initialize the submodule first"
        : busy
          ? "Another git operation is running"
          : undefined,
      onSelect: () => onOpenSubmodule!(sub),
    },
  ];
  if (uninitialized) {
    items.push({
      label: "Initialize",
      disabled: act.disabled,
      title: act.title ?? "Clones the submodule and checks out the recorded commit",
      onSelect: () => onUpdateSubmodule!(sub),
    });
  } else if (sub.state === "moved") {
    items.push({
      label: "Update to Recorded Commit",
      disabled: act.disabled,
      title: act.title ?? "Moves the submodule HEAD back to the commit this repository records",
      onSelect: () => onUpdateSubmodule!(sub),
    });
  }
  items.push({
    label: "Copy Path",
    separatorBefore: true,
    onSelect: () => props.onCopyName(sub.path),
  });
  return items;
}
