// Tauri command 래퍼. 시그니처는 CONTRACTS.md 동결 계약을 따른다.
import { invoke } from "@tauri-apps/api/core";
import type {
  CommitDetails,
  GraphData,
  RefEntry,
  RepoInfo,
  OpResult,
  PullMode,
  RepoState,
  SearchMatch,
  SyncState,
  WipArea,
  WipDetails,
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

// ── v0.15 쓰기 작업 ────────────────────────────────────────────────
// 모두 Result<OpResult, String>. git이 실패해도 Err가 아니라 ok=false로 온다
// (Err는 인자 검증 같은 호출 오류뿐). 호출부는 ok와 conflicts를 함께 본다.

/** 현재 브랜치의 upstream 대비 ahead/behind와 stash 개수 */
export function getSyncState(path: string): Promise<SyncState> {
  return invoke<SyncState>("get_sync_state", { path });
}

/** remote가 null이면 --all */
export function gitFetch(path: string, remote: string | null, prune: boolean): Promise<OpResult> {
  return invoke<OpResult>("git_fetch", { path, remote, prune });
}

export function gitPull(path: string, mode: PullMode): Promise<OpResult> {
  return invoke<OpResult>("git_pull", { path, mode });
}

/** 현재 브랜치를 푸시. upstream이 없을 때만 setUpstream이 의미 있다 */
export function gitPush(
  path: string,
  setUpstream: boolean,
  forceWithLease: boolean,
): Promise<OpResult> {
  return invoke<OpResult>("git_push", { path, setUpstream, forceWithLease });
}

/** 로컬 브랜치 이름 또는 "origin/x" (추적 브랜치를 만들며 체크아웃) */
export function gitCheckout(path: string, target: string): Promise<OpResult> {
  return invoke<OpResult>("git_checkout", { path, target });
}

export function gitCreateBranch(
  path: string,
  name: string,
  startPoint: string | null,
  checkout: boolean,
): Promise<OpResult> {
  return invoke<OpResult>("git_create_branch", { path, name, startPoint, checkout });
}

/** 로컬 브랜치만. 현재 브랜치를 지우려 하면 Err */
export function gitDeleteBranch(path: string, name: string, force: boolean): Promise<OpResult> {
  return invoke<OpResult>("git_delete_branch", { path, name, force });
}

/** 현재 브랜치로 source를 머지 (--no-edit) */
export function gitMerge(path: string, source: string): Promise<OpResult> {
  return invoke<OpResult>("git_merge", { path, source });
}

export function gitStashPush(
  path: string,
  message: string | null,
  includeUntracked: boolean,
): Promise<OpResult> {
  return invoke<OpResult>("git_stash_push", { path, message, includeUntracked });
}

/** stash@{0}을 적용하고 목록에서 제거 */
export function gitStashPop(path: string): Promise<OpResult> {
  return invoke<OpResult>("git_stash_pop", { path });
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
