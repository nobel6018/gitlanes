// Tauri command 래퍼. 시그니처는 CONTRACTS.md 동결 계약을 따른다.
import { invoke } from "@tauri-apps/api/core";
import type { CommitDetails, GraphData, RefEntry, RepoInfo } from "../types";

export function openRepo(path: string): Promise<RepoInfo> {
  return invoke<RepoInfo>("open_repo", { path });
}

export function loadGraph(path: string, limit: number): Promise<GraphData> {
  return invoke<GraphData>("load_graph", { path, limit });
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
