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

/** 스태시 항목. 그래프에서 base 커밋 위에 의사 행으로 표시 */
export interface StashInfo {
  /** 스태시 커밋 sha (실존 커밋 — get_commit_details/get_file_diff 그대로 사용 가능) */
  sha: string;
  shortSha: string;
  /** "WIP on main: ..." 형태의 스태시 메시지 */
  message: string;
  /** 스태시가 만들어진 기반 커밋(첫 부모) sha */
  baseSha: string;
  /** unix seconds */
  timestamp: number;
}

/** Tauri command: load_graph(path, limit, skip) */
export interface GraphData {
  rows: CommitRow[];
  /** skip 적용 전, 이번 limit까지 계산된 전체 행 수 (rows.length + skip과 일치) */
  totalLoaded: number;
  /** limit에 걸려 잘렸으면 true */
  hasMore: boolean;
  /** 전체 rows에서 사용된 최대 레인 수 (캔버스 폭 계산용) */
  laneCount: number;
  /** 미커밋 변경. 없으면 null. GraphView가 HEAD 행 위에 WIP 행으로 렌더 */
  wip: WipInfo | null;
  /** refs 상태 지문 (모든 ref tip sha의 해시). skip 페이징 중 이 값이 바뀌면
   *  프론트는 누적분을 버리고 skip=0으로 전체 리로드한다 */
  graphToken: string;
  /** 스태시 목록 (skip과 무관하게 항상 전체) */
  stashes: StashInfo[];
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

/** Tauri command: search_commits(path, query, limit) — 전체 히스토리 검색 */
export interface SearchMatch {
  sha: string;
  /** load_graph와 같은 topo 순서에서의 행 인덱스 (이 값+1 이상 limit로 로드하면 행이 존재) */
  index: number;
}

/** Tauri command: get_repo_state(path) — 자동 새로고침용 경량 폴링 */
export interface RepoState {
  /** GraphData.graphToken과 같은 refs 지문 */
  graphToken: string;
  /** 현재 워킹 디렉토리 상태 */
  wip: WipInfo | null;
}

// get_file_diff(path, sha, file, oldFile) -> string (unified diff 원문)
//   oldFile: rename/copy 커밋에서 FileChange.oldPath를 그대로 전달 (아니면 null).
//   pathspec에 old/new 경로를 함께 걸어 rename이 "new file"로 보이지 않게 한다.

// get_startup_repo() -> string | null
//   CLI 첫 위치 인자 또는 GITLANES_REPO 환경변수로 지정된 시작 레포 경로.
//   ui-shell은 마운트 시 1회 호출해 값이 있으면 자동으로 open_repo를 수행한다.
