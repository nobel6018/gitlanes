// ============================================================
// FROZEN CONTRACT — 이 파일은 감독(main session)만 수정한다.
// Rust 쪽 serde 구조체는 이 타입과 1:1로 일치해야 한다
// (#[serde(rename_all = "camelCase")]).
// ============================================================

/** Tauri command: open_repo(path) */
export interface RepoInfo {
  /** 절대 경로 (정규화된 레포 루트) */
  path: string;
  /** 디렉토리 이름 */
  name: string;
  /** 현재 브랜치 이름. detached HEAD면 "HEAD" */
  headBranch: string;
  /** HEAD 커밋 sha (풀 sha) */
  headSha: string;
}

export type RefKind = "localBranch" | "remoteBranch" | "tag";

export interface RefInfo {
  /** 표시 이름: "main", "origin/main", "v1.2.0" */
  name: string;
  kind: RefKind;
  /** 이 ref가 현재 HEAD가 가리키는 브랜치인가 */
  isHead: boolean;
}

/**
 * row i와 row i+1 사이 구간에 그릴 엣지 선분.
 * fromLane === toLane 이면 수직 통과선, 다르면 곡선.
 */
export interface Edge {
  fromLane: number;
  toLane: number;
  /** LANE_COLORS 인덱스 (0..9) */
  color: number;
}

export interface CommitRow {
  sha: string;
  /** 10자리 축약 sha */
  shortSha: string;
  subject: string;
  author: string;
  authorEmail: string;
  /** unix seconds */
  timestamp: number;
  parents: string[];
  /** 커밋 점이 놓이는 레인 (0부터) */
  lane: number;
  /** LANE_COLORS 인덱스 (0..9) */
  color: number;
  isHead: boolean;
  isMerge: boolean;
  refs: RefInfo[];
  /** 이 row와 다음 row 사이 구간의 모든 엣지 (통과선 포함) */
  edges: Edge[];
}

/** 워킹 디렉토리 미커밋 변경 요약. 깨끗하면 GraphData.wip이 null */
export interface WipInfo {
  /** 변경된 파일 수 (staged + unstaged + untracked, 파일 단위 중복 제거) */
  changedFiles: number;
  /** 그중 staged 파일 수 */
  stagedFiles: number;
}

/** Tauri command: load_graph(path, limit) */
export interface GraphData {
  rows: CommitRow[];
  /** rows.length */
  totalLoaded: number;
  /** limit에 걸려 잘렸으면 true */
  hasMore: boolean;
  /** 전체 rows에서 사용된 최대 레인 수 (캔버스 폭 계산용) */
  laneCount: number;
  /** 미커밋 변경. 없으면 null. GraphView가 HEAD 행 위에 WIP 행으로 렌더 */
  wip: WipInfo | null;
}

/** Tauri command: list_refs(path) — 사이드바용 전체 refs (로드된 커밋 범위와 무관) */
export interface RefEntry {
  /** "main", "origin/main", "v1.2.0" */
  name: string;
  kind: RefKind;
  /** 가리키는 커밋 sha (annotated tag는 역참조된 커밋) */
  sha: string;
  isHead: boolean;
}

export type FileStatus = "A" | "M" | "D" | "R" | "C" | "T";

export interface FileChange {
  path: string;
  /** rename/copy일 때 원본 경로, 아니면 null */
  oldPath: string | null;
  status: FileStatus;
  additions: number;
  deletions: number;
}

export interface Signature {
  name: string;
  email: string;
  /** unix seconds */
  timestamp: number;
}

/** Tauri command: get_commit_details(path, sha) */
export interface CommitDetails {
  sha: string;
  subject: string;
  /** subject 제외한 본문. 없으면 "" */
  body: string;
  author: Signature;
  committer: Signature;
  parents: string[];
  files: FileChange[];
}

// get_file_diff(path, sha, file, oldFile) -> string (unified diff 원문)
//   oldFile: rename/copy 커밋에서 FileChange.oldPath를 그대로 전달 (아니면 null).
//   pathspec에 old/new 경로를 함께 걸어 rename이 "new file"로 보이지 않게 한다.

// get_startup_repo() -> string | null
//   CLI 첫 위치 인자 또는 GITLANES_REPO 환경변수로 지정된 시작 레포 경로.
//   ui-shell은 마운트 시 1회 호출해 값이 있으면 자동으로 open_repo를 수행한다.
