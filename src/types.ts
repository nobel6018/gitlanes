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
  /**
   * 변경 파일들의 내용 지문 (v0.15.1). 파일 수가 같아도 내용이 바뀌면 달라진다.
   * 폴링이 이 값이 바뀐 것을 보고 열린 WIP diff를 다시 읽는다. 값 자체에 의미는 없고
   * 같은지 다른지만 비교한다. 낡은 diff로 hunk를 스테이지하는 사고를 막는 장치다
   */
  contentToken: string;
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
  /**
   * v0.19. 서브모듈 포인터(gitlink, 모드 160000) 항목이면 true. 빠졌으면 false로 본다.
   * 이 항목은 텍스트 diff 대신 SubmoduleChangePanel로 보여주고, hunk 스테이징과 History/Blame을 주지 않는다
   */
  submodule?: boolean;
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
 *
 * @see docs/decisions.md#discard-범위
 */
export type DiscardArea = "worktree" | "all";

/**
 * get_wip_file_diff 응답 (v0.16.1). 파일 내용이 UTF-8이 아니면 diff를 latin1로 디코딩해 보낸다.
 * latin1은 바이트 하나가 글자 하나(코드 0~255)라서, 패치 엔진이 문자열을 자르고 붙인 뒤 다시
 * 바이트로 바꾸면 원래 바이트가 손실 없이 돌아온다. 화면 표시는 깨져 보인다(손실 디코딩도 깨져
 * 보이기는 마찬가지였다). 이 diff로 만든 패치는 git_apply_patch에 같은 encoding으로 보낸다
 */
export interface WipDiff {
  text: string;
  encoding: "utf8" | "latin1";
}

// get_wip_file_diff(path, file, area) -> WipDiff   (v0.16.1에서 string에서 바뀜)
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
  /**
   * HTTPS 원격이 403으로 거절하면서 밝힌 계정 이름 (v0.16). `remote: Permission to a/b.git
   * denied to <계정>` 에서 뽑는다. 없으면 null. 여러 GitHub 계정을 credential helper로
   * 쓰는 사용자가 "다른 계정으로 인증됐다"를 바로 알게 하려는 값이다. 이 경우 터미널로 넘겨도
   * 같은 helper가 같은 계정을 내놓으므로 needsAuth와 별개로 보여준다
   */
  deniedAccount: string | null;
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

/**
 * 진행 중인 작업 종류.
 * - "am": `git am` 진행 중 (v0.16). continue/abort/skip은 `git am --continue` 등으로 보낸다
 * - "conflicts": 이어갈 작업 없이 충돌만 남은 상태 (v0.16). squash 머지, `stash pop`/`apply` 충돌이
 *   여기에 해당한다. 해결 UI(ours/theirs/mark resolved)는 보여주되 continue/abort/skip은 숨긴다.
 *   되돌릴 작업이 없어서 abort는 의미가 없다
 */
export type PendingKind = "merge" | "rebase" | "cherryPick" | "revert" | "am" | "conflicts";

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
//   git_apply_patch(path, patch: string, cached: boolean, reverse: boolean, encoding: "utf8" | "latin1")
//       // v0.16.1: encoding은 패치를 만든 WipDiff.encoding 그대로. latin1이면 Rust가 글자를 바이트로 되돌린다
//       // hunk/line 단위 스테이징의 유일한 원시 연산.
//       // 스테이지: cached=true, reverse=false / 언스테이지: cached=true, reverse=true
//       // 워킹트리에서 되돌리기: cached=false, reverse=true
//       // git apply --unidiff-zero --whitespace=nowarn, patch는 stdin으로 전달
//   git_clean(path, paths: string[])          // untracked 삭제 (-fd, 경로 지정 필수)
//
// [커밋]
//   git_commit(path, options: CommitOptions)
//   get_last_commit_message(path) -> string   // amend 초기값
//   get_commit_template(path) -> CommitTemplate | null // commit.template 설정이 있으면 그 내용 (v0.18.1부터 객체)
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
//   get_rebase_steps(path, base: string) -> RebaseStep[]
//       // v0.16: 인터랙티브 리베이스 에디터의 초기 목록. `base..HEAD`에 들어가는 커밋을 git에게 물어
//       // todo 순서(오래된 것이 먼저)로 돌려준다. action은 "pick", message는 null.
//       // 그래프 행으로 계산하면 다른 브랜치 커밋이 섞이고, 페이징 때문에 범위를 다 알 수도 없다.
//       // base가 HEAD의 조상이 아니거나 범위에 머지 커밋이 있으면 Err(사람이 읽을 이유)
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
//   git_stash_apply(path, ref: string, sha: string | null, drop: boolean)   // drop=true가 pop
//   git_stash_drop(path, ref: string, sha: string | null)
//   git_stash_branch(path, ref: string, sha: string | null, name: string)
//       // v0.16: sha가 오면 실행 직전에 `rev-parse <ref>`가 그 sha인지 확인하고 다르면 ok=false.
//       // 터미널이나 다른 창에서 스태시를 추가/삭제하면 stash@{N} 번호가 밀려 엉뚱한 스태시를
//       // drop하는 사고를 막는다. 프론트는 항상 StashInfo.sha를 넘긴다
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

// ════════════════════════════════════════════════════════════
// v0.17 작업 되돌리기
// ════════════════════════════════════════════════════════════

/** 되돌리기 판단용 ref 스냅샷. Tauri command: get_ref_snapshot(path) */
export interface RefSnapshot {
  /** HEAD가 가리키는 브랜치의 전체 이름("refs/heads/main"). detached면 null */
  headRef: string | null;
  headSha: string;
  /** 로컬 브랜치와 태그의 전체 ref 이름 → sha ("refs/heads/x", "refs/tags/v1") */
  refs: Record<string, string>;
  /**
   * v0.18.1. 로컬 브랜치의 upstream 설정. 키는 전체 ref 이름("refs/heads/x"), 값은
   * `branch.<x>.remote`와 `branch.<x>.merge` 원문. 둘 다 있는 브랜치만 넣는다.
   * 되돌리기 판단(바뀐 ref 비교)에는 쓰지 않고, 브랜치를 되살릴 때 설정을 복원하는 데만 쓴다
   */
  upstreams: Record<string, BranchUpstream>;
}

export interface BranchUpstream {
  /** "origin" 같은 리모트 이름. "." 이면 로컬 브랜치를 추적 */
  remote: string;
  /** "refs/heads/main" 같은 리모트 쪽 ref */
  merge: string;
}

/**
 * 되돌릴 수 있는 작업. 데이터 자체가 사라지는 작업(discard, clean, stash drop)은 되돌릴 수 없어 넣지 않는다.
 * merge, pull, cherry-pick, rebase는 워킹트리까지 바뀌어 ref만 되돌려서는 원상복구가 안 되므로 넣지 않는다
 */
export type UndoKind =
  | "commit"
  | "amend"
  | "checkout"
  | "createBranch"
  | "deleteBranch"
  | "renameBranch"
  | "createTag"
  | "deleteTag"
  | "reset";

export interface UndoEntry {
  kind: UndoKind;
  /** 버튼과 메뉴에 쓰는 문구. 예: `Undo commit "fix: typo"` */
  label: string;
  before: RefSnapshot;
  after: RefSnapshot;
  /** kind가 "reset"일 때 그 reset의 모드. 그 외는 null */
  resetMode: "soft" | "mixed" | "hard" | null;
}

// get_ref_snapshot(path) -> RefSnapshot
// git_undo(path, entry: UndoEntry) -> OpResult
//   현재 상태가 entry.after와 다르면(그 사이 다른 작업이 있었으면) git을 실행하지 않고 ok=false와
//   사람이 읽을 이유를 돌려준다. 남의 작업을 덮어쓰지 않기 위해서다. 비교는 이 작업이 바꾼 ref만 본다.
//   kind별 복원:
//   - commit, amend: HEAD 브랜치를 before.headSha로 `reset --soft` (변경은 스테이지에 남는다)
//   - checkout: before.headRef(없으면 before.headSha)로 checkout. 워킹트리가 막으면 git이 거절한다
//     v0.18.1: checkout이 새로 만든 로컬 브랜치(origin/x 체크아웃으로 생긴 추적 브랜치)는 HEAD를 돌린 뒤
//     지우고 그 브랜치의 upstream 설정도 지운다(옛 값 인자로 묶어서)
//   - createBranch/deleteBranch/renameBranch/createTag/deleteTag: update-ref로 before 상태 복원
//     v0.18.1: 되살린 브랜치는 before.upstreams의 설정도 복원하고, 지운 브랜치의 설정은 지운다
//   - reset: before.headSha로 같은 모드 reset. hard는 워킹트리가 깨끗할 때만(아니면 ok=false)
//   v0.18.1: commit, amend, reset 되돌리기의 ref 이동은 `update-ref <ref> <before> <after>`로 옛 값을 묶는다.
//   검사와 실행 사이에 ref가 움직이면 git이 거절한다. index와 워킹트리는 그 뒤 `reset --mixed`/`--hard`(대상 없이)로 맞춘다

// ════════════════════════════════════════════════════════════
// v0.18 파일 히스토리, blame, 비교 (전부 읽기 전용)
// ════════════════════════════════════════════════════════════

/** 비교 결과와 파일 히스토리에 쓰는 커밋 요약 */
export interface CommitSummary {
  sha: string;
  shortSha: string;
  subject: string;
  author: string;
  /** unix seconds */
  timestamp: number;
}

/** get_file_history의 한 항목. `--follow`로 rename을 따라간다 */
export interface FileHistoryEntry extends CommitSummary {
  authorEmail: string;
  /** 이 커밋 시점의 경로 */
  path: string;
  /** 이 커밋에서 rename됐으면 원래 경로, 아니면 null */
  oldPath: string | null;
  status: FileStatus;
}

/** blame의 연속 구간. 같은 커밋이 이어지는 줄을 하나로 묶는다 */
export interface BlameHunk {
  sha: string;
  shortSha: string;
  author: string;
  authorEmail: string;
  /** unix seconds */
  timestamp: number;
  summary: string;
  /** 결과 파일 기준 시작 줄 (1부터) */
  startLine: number;
  lineCount: number;
  /** 아직 커밋되지 않은 줄(워킹트리 blame에서만) */
  uncommitted: boolean;
}

export interface BlameResult {
  /** 파일 내용을 줄 단위로 (줄바꿈 제외) */
  lines: string[];
  hunks: BlameHunk[];
}

/** compare_refs 결과. 파일 목록은 세 점(`base...head`, 공통 조상 기준) diff다 */
export interface CompareResult {
  base: string;
  head: string;
  /** 공통 조상. 없으면(관계없는 히스토리) null */
  mergeBase: string | null;
  /** head에만 있는 커밋 (`base..head`), 최신이 먼저 */
  onlyInHead: CommitSummary[];
  /** base에만 있는 커밋 (`head..base`), 최신이 먼저 */
  onlyInBase: CommitSummary[];
  /** v0.18.1. onlyInHead가 limit에 걸려 잘렸으면 true (v0.18.0의 truncated 하나를 목록별로 나눔) */
  onlyInHeadTruncated: boolean;
  /** v0.18.1. onlyInBase가 limit에 걸려 잘렸으면 true */
  onlyInBaseTruncated: boolean;
  files: FileChange[];
}

// get_file_history(path, file: string, rev: string | null, limit: number) -> FileHistoryEntry[]
//   rev가 null이면 HEAD부터. 최신이 먼저. `git log --follow` 이라 경로 하나만 받는다
// get_blame(path, file: string, rev: string | null) -> BlameResult
//   rev가 null이면 워킹트리 기준(커밋 안 된 줄은 uncommitted). 바이너리면 Err("binary"),
//   5MB 넘으면 Err("too large"). 사용자 설정(blame.ignoreRevsFile 등)에 흔들리지 않게 인자를 고정한다
// compare_refs(path, base: string, head: string, limit: number) -> CompareResult
// get_compare_file_diff(path, base: string, head: string, file: string, oldFile: string | null) -> string
//   `base...head` 세 점 diff. 형식은 get_file_diff와 같다(접두 고정)

// ════════════════════════════════════════════════════════════
// v0.18.1
// ════════════════════════════════════════════════════════════

/** get_commit_template 결과 */
export interface CommitTemplate {
  text: string;
  /**
   * 주석 줄 접두. `core.commentChar`와 `core.commentString`(git 2.45+) 중 git처럼 나중에 읽힌 값,
   * 둘 다 없거나 "auto"면 "#". 템플릿에서 온 줄 중 이 접두로 시작하는 줄만 커밋 직전에 지운다
   */
  commentPrefix: string;
}

// ════════════════════════════════════════════════════════════
// v0.19 서브모듈 (상위 레포 기준, 최상위 서브모듈만. 중첩은 그 서브모듈을 탭으로 열어서 본다)
// ════════════════════════════════════════════════════════════

/**
 * - uninitialized: .gitmodules에는 있지만 체크아웃이 없다 (`git submodule status`의 '-')
 * - ok: 서브모듈 HEAD가 상위 레포 index에 기록된 커밋과 같다
 * - moved: 서브모듈 HEAD가 기록된 커밋과 다르다 ('+')
 * - conflict: 상위 레포에서 gitlink가 충돌 중이다 ('U')
 */
export type SubmoduleState = "uninitialized" | "ok" | "moved" | "conflict";

/** Tauri command: get_submodules(path) -> SubmoduleInfo[] (경로순) */
export interface SubmoduleInfo {
  /** .gitmodules의 `submodule.<name>` 이름 */
  name: string;
  /** 상위 레포 기준 상대 경로 */
  path: string;
  url: string | null;
  /** .gitmodules의 branch 설정. 없으면 null */
  branch: string | null;
  /** 상위 레포 index에 기록된 커밋. 충돌 중이거나 아직 add 전이면 null */
  recordedSha: string | null;
  /** 서브모듈 체크아웃의 HEAD. uninitialized면 null */
  headSha: string | null;
  state: SubmoduleState;
  /** 서브모듈 안에 커밋 안 한 변경(추적 파일 수정, untracked 포함)이 있는가. uninitialized면 false */
  dirty: boolean;
}

/** get_submodule_change에서 old/new를 어디서 읽을지 */
export type SubmoduleChangeSource =
  | { kind: "commit"; sha: string }               // 그 커밋의 첫 부모 → 그 커밋
  | { kind: "staged" }                            // HEAD → index
  | { kind: "unstaged" }                          // index → 서브모듈 체크아웃 HEAD
  | { kind: "compare"; base: string; head: string }; // compare_refs와 같은 기준(merge-base → head)

/** Tauri command: get_submodule_change(path, subPath, source, limit) -> SubmoduleChange */
export interface SubmoduleChange {
  path: string;
  /** null이면 그 쪽에 서브모듈이 없다(추가 또는 삭제) */
  oldSha: string | null;
  newSha: string | null;
  /** source가 unstaged일 때 서브모듈 안에 커밋 안 한 변경이 있는가. 그 외는 false */
  dirty: boolean;
  /**
   * 서브모듈 저장소에서 두 커밋을 읽을 수 있는가. 초기화 안 됐거나 fetch 안 된 커밋이면 false이고
   * 그때 ahead, behind는 빈 배열이다
   */
  available: boolean;
  /** old..new: 새로 들어온 커밋, 최신이 먼저 */
  ahead: CommitSummary[];
  /** new..old: 포인터가 되감기며 빠진 커밋, 최신이 먼저 */
  behind: CommitSummary[];
  aheadTruncated: boolean;
  behindTruncated: boolean;
}

// git_submodule_update(path, paths: string[], init: boolean) -> OpResult
//   `submodule update [--init] --recursive -- <paths>`. paths가 비면 전부. 네트워크 명령(clone, fetch가
//   일어날 수 있음)이라 네트워크 타임아웃과 needsAuth 판정을 쓴다. 서브모듈 HEAD를 기록된 커밋으로
//   옮기므로 moved 상태 대상이 있으면 UI가 ConfirmDialog를 띄운다(옮기기 전 HEAD는 서브모듈 reflog에 남는다)

// ════════════════════════════════════════════════════════════
// v0.20 서브모듈 추가, 제거 (결과는 스테이지에 남고 커밋은 사용자가 한다. 되돌리기 스택 대상 아님)
// ════════════════════════════════════════════════════════════

export interface AddSubmoduleOptions {
  /** 원격 URL 또는 상대 경로("../lib"). "-"로 시작하면 거절 */
  url: string;
  /** 상위 레포 기준 상대 경로. 레포 밖, 이미 있는 경로는 git이 거절 */
  path: string;
  /** `-b <branch>`. null이면 원격 기본 브랜치 */
  branch: string | null;
}

// git_submodule_add(path, options: AddSubmoduleOptions) -> OpResult
//   `submodule add [-b <branch>] -- <url> <path>`. 네트워크 명령(clone)이라 네트워크 타임아웃과 needsAuth.
//   `protocol.file.allow` 같은 사용자 설정은 덮지 않는다(로컬 경로 URL이 막히면 git stderr 그대로)
//
// git_submodule_remove(path, subPath: string, force: boolean) -> OpResult
//   `submodule deinit [-f] -- <subPath>` 뒤 `rm [-f] -- <subPath>`. .gitmodules 항목과 gitlink 삭제가 스테이지된다.
//   `.git/modules/<name>`은 지우지 않는다(서브모듈 안의 push 안 한 커밋 보존). force=false인데 서브모듈 안에
//   커밋 안 한 변경이 있으면 git을 실행하지 않고 ok=false와 이유를 돌려준다. force=true면 그 변경을 버린다.
//   force는 이 뜻만 가진다. 검사를 통과하면 git에는 늘 `-f`를 준다(HEAD만 옮겨진 moved 서브모듈은 git이
//   -f 없이 거절하지만 커밋이 .git/modules에 남아 손실이 아니다)
