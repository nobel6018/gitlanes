// Tauri command 래퍼. 시그니처는 CONTRACTS.md 동결 계약을 따른다.
import { invoke } from "@tauri-apps/api/core";
import type {
  CommitDetails,
  CommitOptions,
  ConflictFile,
  DiscardArea,
  GraphData,
  OpResult,
  PendingKind,
  PullMode,
  RebaseStep,
  RefEntry,
  RemoteInfo,
  RepoInfo,
  RepoState,
  SearchMatch,
  SyncState,
  WipArea,
  WipDetails,
  WorktreeInfo,
} from "../types";

export function openRepo(path: string): Promise<RepoInfo> {
  return invoke<RepoInfo>("open_repo", { path });
}

/** skip>0이면 rows는 [skip, limit) 구간만 온다. 나머지 필드는 전체 기준 */
export function loadGraph(path: string, limit: number, skip: number): Promise<GraphData> {
  return invoke<GraphData>("load_graph", { path, limit, skip });
}

export function getCommitDetails(path: string, sha: string): Promise<CommitDetails> {
  return invoke<CommitDetails>("get_commit_details", { path, sha });
}

/** oldFile: rename/copy일 때 FileChange.oldPath, 아니면 null */
export function getFileDiff(
  path: string,
  sha: string,
  file: string,
  oldFile: string | null,
): Promise<string> {
  return invoke<string>("get_file_diff", { path, sha, file, oldFile });
}

/** 커밋 시점의 파일 전문 (git show <sha>:<file>). 바이너리면 Err("binary") */
export function getFileContent(path: string, sha: string, file: string): Promise<string> {
  return invoke<string>("get_file_content", { path, sha, file });
}

/** 미커밋 변경 상세 (staged / unstaged / untracked) */
export function getWipDetails(path: string): Promise<WipDetails> {
  return invoke<WipDetails>("get_wip_details", { path });
}

/** 워킹 트리 파일의 unified diff. area에 따라 인덱스/워킹 트리/신규 파일 diff */
export function getWipFileDiff(path: string, file: string, area: WipArea): Promise<string> {
  return invoke<string>("get_wip_file_diff", { path, file, area });
}

/** 워킹 트리의 현재 파일 내용. 바이너리면 Err("binary"), 5MB 초과면 Err("too large") */
export function getWipFileContent(path: string, file: string): Promise<string> {
  return invoke<string>("get_wip_file_content", { path, file });
}

/** 전체 히스토리 검색. index는 load_graph와 같은 topo 순서의 행 번호 */
export function searchCommits(path: string, query: string, limit: number): Promise<SearchMatch[]> {
  return invoke<SearchMatch[]>("search_commits", { path, query, limit });
}

/** origin remote의 웹 URL. remote가 없으면 null */
export function getRemoteUrl(path: string): Promise<string | null> {
  return invoke<string | null>("get_remote_url", { path });
}

/** 자동 새로고침용 경량 폴링 (refs 지문 + wip 요약) */
export function getRepoState(path: string): Promise<RepoState> {
  return invoke<RepoState>("get_repo_state", { path });
}

/** 사이드바용 전체 refs. 로드된 커밋 범위와 무관하다 */
export function listRefs(path: string): Promise<RefEntry[]> {
  return invoke<RefEntry[]>("list_refs", { path });
}

/** CLI 인자/환경변수로 지정된 시작 레포 경로. 없으면 null */
export function getStartupRepo(): Promise<string | null> {
  return invoke<string | null>("get_startup_repo");
}

/** Tauri command는 Err(String)을 그대로 reject 한다. 사람이 읽을 메시지로 정규화. */
export function errorMessage(err: unknown): string {
  if (typeof err === "string") {
    return err;
  }
  if (err instanceof Error) {
    return err.message;
  }
  if (err && typeof err === "object" && "message" in err) {
    return String((err as { message: unknown }).message);
  }
  return String(err);
}

/** Finder/Explorer에서 해당 항목을 보여준다 (macOS: open -R) */
export function revealPath(path: string): Promise<void> {
  return invoke<void>("reveal_path", { path });
}

/** 기본 터미널을 그 디렉토리에서 연다 */
export function openInTerminal(path: string): Promise<void> {
  return invoke<void>("open_in_terminal", { path });
}

/** File > Open Recent 서브메뉴를 다시 만든다 (최대 10개) */
export function setRecentRepos(paths: string[]): Promise<void> {
  return invoke<void>("set_recent_repos", { paths });
}

// ════════════════════════════════════════════════════════════
// v0.18 쓰기 command 래퍼.
// 전부 얇다. invoke만 부르고 확인/토스트/새로고침은 actions.ts가 맡는다.
// 인자는 camelCase로 넘긴다 (Tauri 2가 Rust snake_case로 변환한다).
// ════════════════════════════════════════════════════════════

// ── 상태 조회 ───────────────────────────────────────────────

/** 툴바 ↑ahead ↓behind 배지와 진행 중인 머지/리베이스 판정 */
export function getSyncState(path: string): Promise<SyncState> {
  return invoke<SyncState>("get_sync_state", { path });
}

/** 충돌 파일 목록. 진행 중인 작업이 없으면 [] */
export function getConflicts(path: string): Promise<ConflictFile[]> {
  return invoke<ConflictFile[]>("get_conflicts", { path });
}

/** 3-way 비교용 원문. 해당 stage가 없으면 "" (한쪽이 삭제된 충돌) */
export function getConflictSide(
  path: string,
  file: string,
  side: "base" | "ours" | "theirs",
): Promise<string> {
  return invoke<string>("get_conflict_side", { path, file, side });
}

export function listRemotes(path: string): Promise<RemoteInfo[]> {
  return invoke<RemoteInfo[]>("list_remotes", { path });
}

export function listWorktrees(path: string): Promise<WorktreeInfo[]> {
  return invoke<WorktreeInfo[]>("list_worktrees", { path });
}

/** amend 체크 시 커밋 메시지 초기값 */
export function getLastCommitMessage(path: string): Promise<string> {
  return invoke<string>("get_last_commit_message", { path });
}

/** commit.template 설정이 있으면 그 내용, 없으면 null */
export function getCommitTemplate(path: string): Promise<string | null> {
  return invoke<string | null>("get_commit_template", { path });
}

// ── 스테이징 ───────────────────────────────────────────────

export function gitStage(path: string, files: string[]): Promise<OpResult> {
  return invoke<OpResult>("git_stage", { path, files });
}

export function gitUnstage(path: string, files: string[]): Promise<OpResult> {
  return invoke<OpResult>("git_unstage", { path, files });
}

/**
 * 추적 파일은 restore, untracked는 삭제. 되돌릴 수 없다.
 * area="worktree"는 인덱스 기준으로 워킹트리만 되돌려 staged 변경을 살린다.
 * area="all"은 마지막 커밋 상태로 전부 되돌린다.
 */
export function gitDiscard(
  path: string,
  files: string[],
  area: DiscardArea,
): Promise<OpResult> {
  return invoke<OpResult>("git_discard", { path, files, area });
}

export function gitStageAll(path: string): Promise<OpResult> {
  return invoke<OpResult>("git_stage_all", { path });
}

export function gitUnstageAll(path: string): Promise<OpResult> {
  return invoke<OpResult>("git_unstage_all", { path });
}

/**
 * hunk/line 단위 스테이징의 유일한 원시 연산.
 * 스테이지 cached=true/reverse=false, 언스테이지 cached=true/reverse=true,
 * 워킹트리에서 되돌리기 cached=false/reverse=true
 */
export function gitApplyPatch(
  path: string,
  patch: string,
  cached: boolean,
  reverse: boolean,
): Promise<OpResult> {
  return invoke<OpResult>("git_apply_patch", { path, patch, cached, reverse });
}

/** untracked 삭제 (-fd). 경로 지정이 필수라 레포 전체를 날릴 수 없다 */
export function gitClean(path: string, paths: string[]): Promise<OpResult> {
  return invoke<OpResult>("git_clean", { path, paths });
}

// ── 커밋 ───────────────────────────────────────────────────

export function gitCommit(path: string, options: CommitOptions): Promise<OpResult> {
  return invoke<OpResult>("git_commit", { path, options });
}

/** reset --soft HEAD~1. 머지 커밋에도 안전하다 */
export function gitUndoCommit(path: string): Promise<OpResult> {
  return invoke<OpResult>("git_undo_commit", { path });
}

// ── 브랜치 ─────────────────────────────────────────────────

/** createLocal=true면 origin/foo -> foo 추적 브랜치를 만들고 체크아웃 */
export function gitCheckout(
  path: string,
  target: string,
  createLocal: boolean,
): Promise<OpResult> {
  return invoke<OpResult>("git_checkout", { path, target, createLocal });
}

export function gitCreateBranch(
  path: string,
  name: string,
  startPoint: string | null,
  checkout: boolean,
): Promise<OpResult> {
  return invoke<OpResult>("git_create_branch", { path, name, startPoint, checkout });
}

/** remote=true면 "origin/foo"를 받아 origin에서 foo를 지운다 */
export function gitDeleteBranch(
  path: string,
  name: string,
  force: boolean,
  remote: boolean,
): Promise<OpResult> {
  return invoke<OpResult>("git_delete_branch", { path, name, force, remote });
}

export function gitRenameBranch(path: string, from: string, to: string): Promise<OpResult> {
  return invoke<OpResult>("git_rename_branch", { path, from, to });
}

/** upstream이 null이면 --unset-upstream */
export function gitSetUpstream(
  path: string,
  branch: string,
  upstream: string | null,
): Promise<OpResult> {
  return invoke<OpResult>("git_set_upstream", { path, branch, upstream });
}

// ── 네트워크 ───────────────────────────────────────────────

export function gitFetch(
  path: string,
  remote: string | null,
  prune: boolean,
  allRemotes: boolean,
  tags: boolean,
): Promise<OpResult> {
  return invoke<OpResult>("git_fetch", { path, remote, prune, allRemotes, tags });
}

export function gitPull(
  path: string,
  mode: PullMode,
  remote: string | null,
  branch: string | null,
): Promise<OpResult> {
  return invoke<OpResult>("git_pull", { path, mode, remote, branch });
}

/** forceWithLease만 허용한다. --force는 계약상 금지 */
export function gitPush(
  path: string,
  remote: string | null,
  branch: string | null,
  setUpstream: boolean,
  forceWithLease: boolean,
  tags: boolean,
): Promise<OpResult> {
  return invoke<OpResult>("git_push", { path, remote, branch, setUpstream, forceWithLease, tags });
}

// ── 히스토리 ───────────────────────────────────────────────

export function gitMerge(
  path: string,
  source: string,
  noFf: boolean,
  squash: boolean,
  noCommit: boolean,
): Promise<OpResult> {
  return invoke<OpResult>("git_merge", { path, source, noFf, squash, noCommit });
}

export function gitRebase(
  path: string,
  upstream: string,
  onto: string | null,
  autostash: boolean,
): Promise<OpResult> {
  return invoke<OpResult>("git_rebase", { path, upstream, onto, autostash });
}

/** mainline: 머지 커밋을 체리픽할 때 고를 부모 번호 (1부터). 아니면 null */
export function gitCherryPick(
  path: string,
  shas: string[],
  noCommit: boolean,
  mainline: number | null,
): Promise<OpResult> {
  return invoke<OpResult>("git_cherry_pick", { path, shas, noCommit, mainline });
}

export function gitRevert(
  path: string,
  shas: string[],
  noCommit: boolean,
  mainline: number | null,
): Promise<OpResult> {
  return invoke<OpResult>("git_revert", { path, shas, noCommit, mainline });
}

export function gitReset(
  path: string,
  target: string,
  mode: "soft" | "mixed" | "hard",
): Promise<OpResult> {
  return invoke<OpResult>("git_reset", { path, target, mode });
}

/** 진행 중인 머지/리베이스/체리픽/리버트 제어. kind는 SyncState.pending.kind 그대로 */
export function gitPendingAction(
  path: string,
  kind: PendingKind,
  action: "continue" | "abort" | "skip",
): Promise<OpResult> {
  return invoke<OpResult>("git_pending_action", { path, kind, action });
}

/** steps 순서가 곧 적용 순서 (위 -> 아래 = 과거 -> 현재). Windows는 Err */
export function gitRebaseInteractive(
  path: string,
  base: string,
  steps: RebaseStep[],
): Promise<OpResult> {
  return invoke<OpResult>("git_rebase_interactive", { path, base, steps });
}

// ── 태그 ───────────────────────────────────────────────────

/** message가 있으면 annotated tag */
export function gitCreateTag(
  path: string,
  name: string,
  target: string,
  message: string | null,
): Promise<OpResult> {
  return invoke<OpResult>("git_create_tag", { path, name, target, message });
}

export function gitDeleteTag(path: string, name: string): Promise<OpResult> {
  return invoke<OpResult>("git_delete_tag", { path, name });
}

/** del=true면 원격에서 태그를 지운다 */
export function gitPushTag(
  path: string,
  remote: string,
  name: string,
  del: boolean,
): Promise<OpResult> {
  return invoke<OpResult>("git_push_tag", { path, remote, name, delete: del });
}

// ── 스태시 ─────────────────────────────────────────────────

/** files가 있으면 부분 스태시 (git stash push -- <files>) */
export function gitStashPush(
  path: string,
  message: string | null,
  includeUntracked: boolean,
  keepIndex: boolean,
  files: string[] | null,
): Promise<OpResult> {
  return invoke<OpResult>("git_stash_push", {
    path,
    message,
    includeUntracked,
    keepIndex,
    files,
  });
}

/** drop=true가 pop이다 */
export function gitStashApply(path: string, ref: string, drop: boolean): Promise<OpResult> {
  return invoke<OpResult>("git_stash_apply", { path, ref, drop });
}

export function gitStashDrop(path: string, ref: string): Promise<OpResult> {
  return invoke<OpResult>("git_stash_drop", { path, ref });
}

export function gitStashBranch(path: string, ref: string, name: string): Promise<OpResult> {
  return invoke<OpResult>("git_stash_branch", { path, ref, name });
}

// ── remote ─────────────────────────────────────────────────

export function gitAddRemote(path: string, name: string, url: string): Promise<OpResult> {
  return invoke<OpResult>("git_add_remote", { path, name, url });
}

export function gitRemoveRemote(path: string, name: string): Promise<OpResult> {
  return invoke<OpResult>("git_remove_remote", { path, name });
}

export function gitRenameRemote(path: string, from: string, to: string): Promise<OpResult> {
  return invoke<OpResult>("git_rename_remote", { path, from, to });
}

export function gitSetRemoteUrl(path: string, name: string, url: string): Promise<OpResult> {
  return invoke<OpResult>("git_set_remote_url", { path, name, url });
}

// ── 충돌 ───────────────────────────────────────────────────

/** checkout --ours/--theirs 후 git add까지 한 번에 */
export function gitResolveWith(
  path: string,
  file: string,
  side: "ours" | "theirs",
): Promise<OpResult> {
  return invoke<OpResult>("git_resolve_with", { path, file, side });
}

/** 손으로 고친 파일을 해결됨으로 표시 (git add) */
export function gitMarkResolved(path: string, files: string[]): Promise<OpResult> {
  return invoke<OpResult>("git_mark_resolved", { path, files });
}

// ── 워크트리 ───────────────────────────────────────────────

export function gitAddWorktree(
  path: string,
  dir: string,
  branch: string,
  createBranch: boolean,
): Promise<OpResult> {
  return invoke<OpResult>("git_add_worktree", { path, dir, branch, createBranch });
}

export function gitRemoveWorktree(path: string, dir: string, force: boolean): Promise<OpResult> {
  return invoke<OpResult>("git_remove_worktree", { path, dir, force });
}

// ── 패치 ───────────────────────────────────────────────────

/** git format-patch. outDir에 .patch 파일을 쓴다 */
export function gitCreatePatch(
  path: string,
  shas: string[],
  outDir: string,
): Promise<OpResult> {
  return invoke<OpResult>("git_create_patch", { path, shas, outDir });
}

export function gitApplyPatchFile(
  path: string,
  file: string,
  threeWay: boolean,
): Promise<OpResult> {
  return invoke<OpResult>("git_apply_patch_file", { path, file, threeWay });
}

// ── 내장 터미널 (인증 핸드오프) ─────────────────────────────

/** PTY를 열고 세션 id를 돌려준다. Terminal.tsx가 자기 세션을 관리한다 */
export function termOpen(path: string, cols: number, rows: number): Promise<string> {
  return invoke<string>("term_open", { path, cols, rows });
}

/** 세션에 그대로 써 넣는다. 개행까지 포함해야 실제로 실행된다 */
export function termWrite(id: string, data: string): Promise<void> {
  return invoke<void>("term_write", { id, data });
}
