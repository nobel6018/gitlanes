// Tauri command 래퍼. 시그니처는 CONTRACTS.md 동결 계약을 따른다.
import { invoke } from "@tauri-apps/api/core";
import type {
  CommitDetails,
  GraphData,
  RefEntry,
  RepoInfo,
  RepoState,
  SearchMatch,
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
