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
 * 모든 선분은 정확히 하나의 "자식 커밋 → 부모 커밋" 링크에 속한다.
 */
export interface Edge {
  fromLane: number;
  toLane: number;
  /** LANE_COLORS 인덱스 (0..9) */
  color: number;
  /** 이 선분이 속한 링크의 자식 커밋 행 인덱스 (skip과 무관한 전역 topo 인덱스) */
  childRow: number;
  /** 링크의 부모 커밋 행 인덱스. 부모가 로드 범위(limit) 밖이면 -1 */
  parentRow: number;
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
  /** 그중 추적되지 않는 새 파일 수. v0.18에서 추가, 그래프 WIP 배지 3분할용 */
  untrackedFiles: number;
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

// get_remote_url(path) -> string | null
//   origin remote를 웹 URL로 정규화 (git@host:a/b.git → https://host/a/b).
//   origin이 없으면 첫 remote, remote가 없으면 null.

// get_file_diff(path, sha, file, oldFile) -> string (unified diff 원문)
//   oldFile: rename/copy 커밋에서 FileChange.oldPath를 그대로 전달 (아니면 null).
//   pathspec에 old/new 경로를 함께 걸어 rename이 "new file"로 보이지 않게 한다.

// get_startup_repo() -> string | null
//   CLI 첫 위치 인자 또는 GITLANES_REPO 환경변수로 지정된 시작 레포 경로.
//   ui-shell은 마운트 시 1회 호출해 값이 있으면 자동으로 open_repo를 수행한다.

// get_file_content(path, sha, file) -> string
//   해당 커밋 시점의 파일 전문 (`git show <sha>:<file>`). 바이너리면 Err("binary").
//   File View(전문 보기)와 split diff 렌더에 사용.

/** Tauri command: get_wip_details(path) — 워킹 디렉토리 변경 파일 목록 (GitKraken WIP 노드) */
export interface WipDetails {
  /** 인덱스에 올라간 변경 (git diff --cached) */
  staged: FileChange[];
  /** 워킹 트리 변경 중 인덱스에 안 올라간 것 (git diff) */
  unstaged: FileChange[];
  /** 추적되지 않는 새 파일 (status 'A', additions = 줄 수, deletions 0) */
  untracked: FileChange[];
}

export type WipArea = "staged" | "unstaged" | "untracked";

/**
 * git_discard의 범위. 레퍼런스 앱(GitKraken/SourceGit)은 "all"만 있지만, 우리 WIP 패널은
 * Unstaged와 Staged를 시각적으로 나눠 그리므로 Unstaged 행의 discard가 staged 변경까지
 * 날리면 사용자의 기대를 배신한다. 커밋 안 한 변경은 reflog로도 복구가 안 된다.
 */
export type DiscardArea = "worktree" | "all";

// get_wip_file_diff(path, file, area) -> string
//   staged: git diff --cached -- file / unstaged: git diff -- file /
//   untracked: git diff --no-index /dev/null file. rename은 file=새 경로.
// get_wip_file_content(path, file) -> string
//   워킹 트리의 현재 파일 내용. 바이너리 Err("binary"), 5MB 초과 Err("too large").


// ════════════════════════════════════════════════════════════
// v0.18 쓰기 작업 (git client 전환)
//
// 안전 계약 (rust-core가 지킨다):
//  1. 모든 git 실행은 비대화식. stdin=null, GIT_TERMINAL_PROMPT=0,
//     GIT_SSH_COMMAND="ssh -oBatchMode=yes", GIT_ASKPASS/SSH_ASKPASS="".
//     자격증명이 없으면 멈추지 않고 실패한다.
//  2. 실패는 Err가 아니라 ok=false다. Err(String)는 인자 검증 실패에만.
//  3. `--force`는 쓰지 않는다. push는 `--force-with-lease`만.
//  4. 타임아웃: 네트워크 120초, 로컬 60초.
//  5. 모든 OpResult는 실행한 argv를 command로 돌려준다. needsAuth면
//     ui-shell이 내장 터미널로 핸드오프한다 (term_write로 그대로 실행).
// ════════════════════════════════════════════════════════════

/** 모든 쓰기 command의 공통 결과 */
export interface OpResult {
  ok: boolean;
  /** git stdout (마지막 200줄) */
  stdout: string;
  /** git stderr (마지막 200줄) — non-fast-forward, 인증 실패 등을 그대로 보여준다 */
  stderr: string;
  /** 충돌 파일 경로 (git diff --name-only --diff-filter=U). 없으면 [] */
  conflicts: string[];
  /** 실제로 실행한 git 인자 (프로그램명 "git" 제외). 터미널 핸드오프에 쓴다 */
  command: string[];
  /** stderr가 인증/권한 실패로 보이면 true. ui-shell이 "터미널에서 실행"을 권한다 */
  needsAuth: boolean;
}

export type PullMode = "ff-only" | "merge" | "rebase";

/** Tauri command: get_sync_state(path) — 툴바 ↑ahead ↓behind 배지 */
export interface SyncState {
  /** detached HEAD면 null */
  branch: string | null;
  /** "origin/main" 형태. 없으면 null */
  upstream: string | null;
  ahead: number;
  behind: number;
  /** stash 개수 */
  stashCount: number;
  /** 진행 중인 머지/리베이스/체리픽/리버트 상태. 없으면 null */
  pending: PendingOp | null;
}

export type PendingKind = "merge" | "rebase" | "cherryPick" | "revert";

/** 진행 중이라 continue/abort가 필요한 작업. .git의 MERGE_HEAD 등으로 판정 */
export interface PendingOp {
  kind: PendingKind;
  /** 리베이스 진행도 "3/12". 알 수 없으면 null */
  progress: string | null;
  /** 충돌 파일 수 */
  conflictCount: number;
  /** 리베이스 중인 브랜치 이름 등 부가 설명. 없으면 null */
  detail: string | null;
}

/** Tauri command: get_conflicts(path) */
export interface ConflictFile {
  path: string;
  /** 양쪽이 수정 / 한쪽 삭제 등 */
  kind: "bothModified" | "bothAdded" | "deletedByUs" | "deletedByThem" | "bothDeleted";
  /** 충돌 마커가 남아 있으면 true. 사용자가 손으로 해결하면 false가 된다 */
  hasMarkers: boolean;
}

/** Tauri command: list_remotes(path) */
export interface RemoteInfo {
  name: string;
  fetchUrl: string;
  pushUrl: string;
}

/** Tauri command: list_worktrees(path) */
export interface WorktreeInfo {
  path: string;
  /** 체크아웃된 브랜치. detached면 null */
  branch: string | null;
  head: string;
  /** 이 앱이 연 레포 자신이면 true */
  isMain: boolean;
  /** 경로가 사라졌으면 true (prune 대상) */
  isPrunable: boolean;
}

export type RebaseAction = "pick" | "reword" | "edit" | "squash" | "fixup" | "drop";

/** git_rebase_interactive의 todo 한 줄 */
export interface RebaseStep {
  sha: string;
  action: RebaseAction;
  /** 화면 표시용 원본 subject */
  subject: string;
  /** action이 "reword"일 때 쓸 새 메시지. 그 외엔 null */
  message: string | null;
}

/** git_commit 인자 묶음 */
export interface CommitOptions {
  message: string;
  /** 마지막 커밋을 고쳐 쓴다 (--amend) */
  amend: boolean;
  /** Signed-off-by 추가 */
  signoff: boolean;
  /** GPG 서명 (--gpg-sign). 서명 키가 없으면 ok=false로 실패한다 */
  gpgSign: boolean;
  /** staged가 비어도 커밋 (--allow-empty) */
  allowEmpty: boolean;
  /** 추적 중인 파일의 변경을 전부 스테이지하고 커밋 (-a) */
  stageAll: boolean;
}

// ── 쓰기 command 목록 (rust-core 구현, ui-* 호출) ────────────────
// 반환 타입이 안 적힌 것은 전부 OpResult.
//
// [스테이징]
//   git_stage(path, files: string[])
//   git_unstage(path, files: string[])
//   git_discard(path, files: string[], area: DiscardArea)
//       // "worktree": 인덱스 기준으로 워킹트리만 되돌린다 (git restore -- <files>).
//       //             staged 변경은 보존된다. WIP 패널의 Unstaged 행이 이걸 쓴다
//       // "all":      마지막 커밋 상태로 전부 되돌린다 (restore --source=HEAD --staged --worktree).
//       //             Staged 영역과 파일 단위 전체 discard가 이걸 쓴다
//       // 두 모드 모두 untracked는 clean -fd로 삭제한다
//   git_stage_all(path)  /  git_unstage_all(path)
//   git_apply_patch(path, patch: string, cached: boolean, reverse: boolean)
//       // hunk/line 단위 스테이징의 유일한 원시 연산.
//       // 스테이지: cached=true, reverse=false / 언스테이지: cached=true, reverse=true
//       // 워킹트리에서 되돌리기: cached=false, reverse=true
//       // git apply --unidiff-zero --whitespace=nowarn, patch는 stdin으로 전달
//   git_clean(path, paths: string[])          // untracked 삭제 (-fd, 경로 지정 필수)
//
// [커밋]
//   git_commit(path, options: CommitOptions)
//   get_last_commit_message(path) -> string   // amend 초기값
//   get_commit_template(path) -> string | null // commit.template 설정이 있으면 그 내용
//   git_undo_commit(path)                     // reset --soft HEAD~1 (머지 커밋도 안전)
//
// [브랜치]
//   git_checkout(path, target: string, createLocal: boolean)
//       // createLocal=true면 origin/foo → foo 추적 브랜치 생성 후 체크아웃
//   git_create_branch(path, name, startPoint: string | null, checkout: boolean)
//   git_delete_branch(path, name, force: boolean, remote: boolean)
//       // remote=true면 "origin/foo"를 받아 `git push origin --delete foo`
//   git_rename_branch(path, from: string, to: string)
//   git_set_upstream(path, branch: string, upstream: string | null)  // null이면 --unset-upstream
//
// [네트워크]
//   git_fetch(path, remote: string | null, prune: boolean, allRemotes: boolean, tags: boolean)
//   git_pull(path, mode: PullMode, remote: string | null, branch: string | null)
//   git_push(path, remote, branch, setUpstream, forceWithLease, tags: boolean)
//
// [히스토리]
//   git_merge(path, source: string, noFf: boolean, squash: boolean, noCommit: boolean)
//   git_rebase(path, upstream: string, onto: string | null, autostash: boolean)
//   git_cherry_pick(path, shas: string[], noCommit: boolean, mainline: number | null)
//   git_revert(path, shas: string[], noCommit: boolean, mainline: number | null)
//   git_reset(path, target: string, mode: "soft" | "mixed" | "hard")
//   git_pending_action(path, kind: PendingKind, action: "continue" | "abort" | "skip")
//       // 진행 중 작업 제어. kind는 get_sync_state().pending.kind를 그대로
//   git_rebase_interactive(path, base: string, steps: RebaseStep[])
//       // GIT_SEQUENCE_EDITOR로 todo를 주입한다. steps 순서가 곧 적용 순서(위→아래=과거→현재).
//       // reword는 GIT_EDITOR 주입으로 메시지를 넣는다. Windows는 Err("unsupported")로 둬도 된다
//
// [태그]
//   git_create_tag(path, name, target: string, message: string | null)  // message 있으면 annotated
//   git_delete_tag(path, name)
//   git_push_tag(path, remote, name, delete: boolean)
//
// [스태시]
//   git_stash_push(path, message: string | null, includeUntracked, keepIndex, files: string[] | null)
//       // files가 있으면 `git stash push -- <files>` (부분 스태시)
//   git_stash_apply(path, ref: string, drop: boolean)   // drop=true가 pop
//   git_stash_drop(path, ref: string)
//   git_stash_branch(path, ref: string, name: string)
//
// [remote]
//   list_remotes(path) -> RemoteInfo[]
//   git_add_remote(path, name, url)  /  git_remove_remote(path, name)
//   git_rename_remote(path, from, to)  /  git_set_remote_url(path, name, url)
//
// [충돌]
//   get_conflicts(path) -> ConflictFile[]
//   git_resolve_with(path, file: string, side: "ours" | "theirs")  // checkout --ours/--theirs + add
//   git_mark_resolved(path, files: string[])                        // git add
//   get_conflict_side(path, file: string, side: "base"|"ours"|"theirs") -> string
//       // 3-way 비교용 원문. 해당 stage가 없으면 "" (삭제된 쪽)
//
// [워크트리]
//   list_worktrees(path) -> WorktreeInfo[]
//   git_add_worktree(path, dir: string, branch: string, createBranch: boolean)
//   git_remove_worktree(path, dir: string, force: boolean)
//
// [패치]
//   git_create_patch(path, shas: string[], outDir: string) -> OpResult  // format-patch
//   git_apply_patch_file(path, file: string, threeWay: boolean)
