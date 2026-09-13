//! 프론트엔드 접점 타입. `src/types.ts`와 1:1로 대응한다.
//!
//! @see CONTRACTS.md

use serde::{Deserialize, Serialize};

/// `open_repo` 응답.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoInfo {
    pub path: String,
    pub name: String,
    /// detached HEAD면 "HEAD"
    pub head_branch: String,
    pub head_sha: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum RefKind {
    LocalBranch,
    RemoteBranch,
    Tag,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RefInfo {
    /// 표시 이름: "main", "origin/main", "v1.2.0"
    pub name: String,
    pub kind: RefKind,
    /// 현재 HEAD가 가리키는 브랜치인지
    pub is_head: bool,
}

/// row i와 row i+1 사이 구간에 그릴 선분 하나.
/// `from_lane == to_lane`이면 수직 통과선이다.
///
/// 모든 선분은 정확히 하나의 "자식 커밋 → 부모 커밋" 링크에 속한다. 통과 수직선도
/// 자기 링크의 값을 갖는다. 프론트는 이 값으로 경로 강조 대상을 판정한다.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Edge {
    pub from_lane: usize,
    pub to_lane: usize,
    /// LANE_COLORS 인덱스 (0..9)
    pub color: usize,
    /// 링크의 자식 커밋 행 인덱스. skip과 무관한 전역 topo 인덱스다
    pub child_row: usize,
    /// 링크의 부모 커밋 행 인덱스. 부모가 로드 범위(limit) 밖이면 -1
    pub parent_row: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitRow {
    pub sha: String,
    /// 10자리 축약 sha
    pub short_sha: String,
    pub subject: String,
    pub author: String,
    pub author_email: String,
    /// unix seconds
    pub timestamp: i64,
    pub parents: Vec<String>,
    pub lane: usize,
    pub color: usize,
    pub is_head: bool,
    pub is_merge: bool,
    pub refs: Vec<RefInfo>,
    /// 이 row와 다음 row 사이 구간의 모든 엣지 (통과선 포함)
    pub edges: Vec<Edge>,
}

/// 미커밋 변경 요약. `git status --porcelain`의 항목을 센다.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WipInfo {
    /// staged + unstaged + untracked를 파일 단위로 중복 제거한 수
    pub changed_files: usize,
    /// 그중 index에 올라간 수
    pub staged_files: usize,
    /// 그중 추적되지 않는 새 파일 수. v0.18에서 그래프 WIP 배지 3분할용으로 추가했다.
    ///
    /// 셋은 `changed_files`의 부분집합이고 **서로 겹칠 수 있다.** 한 파일이 staged이면서
    /// unstaged일 수 있고(`AM`), `git rm --cached`처럼 staged이면서 untracked일 수도 있다
    /// (`D ` + `??`). 그래서 셋을 더해도 `changed_files`가 되지 않는다.
    /// 프론트는 unstaged를 `changedFiles - stagedFiles`로 계산하므로 앞의 두 필드의
    /// 의미는 바꾸지 않는다.
    pub untracked_files: usize,
}

/// 스태시 항목. 그래프에서 base 커밋 위에 의사 행으로 표시한다.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StashInfo {
    /// 스태시 커밋 sha. 실존 커밋이라 get_commit_details/get_file_diff를 그대로 쓴다
    pub sha: String,
    pub short_sha: String,
    /// "WIP on main: ..." 형태의 스태시 메시지
    pub message: String,
    /// 스태시가 만들어진 기반 커밋(첫 부모) sha
    pub base_sha: String,
    /// unix seconds
    pub timestamp: i64,
}

/// `load_graph` 응답.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphData {
    /// skip을 적용한 [skip, limit) 구간
    pub rows: Vec<CommitRow>,
    /// skip과 무관하게 레이아웃을 계산한 전체 행 수
    pub total_loaded: usize,
    pub has_more: bool,
    pub lane_count: usize,
    /// 미커밋 변경. 깨끗하면 None
    pub wip: Option<WipInfo>,
    /// refs 상태 지문. 페이징 중 값이 바뀌면 프론트가 skip=0으로 전체 리로드한다
    pub graph_token: String,
    /// 스태시 목록. skip과 무관하게 항상 전체
    pub stashes: Vec<StashInfo>,
}

/// `search_commits` 응답 항목.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchMatch {
    pub sha: String,
    /// load_graph와 같은 topo 순서에서의 행 인덱스.
    /// 프론트는 이 값+1 이상으로 limit을 늘려 그 행을 로드한다
    pub index: usize,
}

/// `get_repo_state` 응답. 자동 새로고침 폴링용이라 log를 읽지 않는다.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoState {
    /// `GraphData.graph_token`과 같은 refs 지문
    pub graph_token: String,
    pub wip: Option<WipInfo>,
}

/// `list_refs` 응답 항목. 사이드바용이라 로드된 커밋 범위와 무관하게 전체를 담는다.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RefEntry {
    pub name: String,
    pub kind: RefKind,
    /// 가리키는 커밋 sha (annotated tag는 역참조된 커밋)
    pub sha: String,
    pub is_head: bool,
}

/// short sha 길이. `src/types.ts`의 `shortSha` 주석과 맞춘다.
pub const SHORT_SHA_LEN: usize = 10;

/// 표시용 축약 sha. sha가 더 짧으면 그대로 둔다.
pub fn short_sha(sha: &str) -> String {
    sha.chars().take(SHORT_SHA_LEN).collect()
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub enum FileStatus {
    #[serde(rename = "A")]
    Added,
    #[serde(rename = "M")]
    Modified,
    #[serde(rename = "D")]
    Deleted,
    #[serde(rename = "R")]
    Renamed,
    #[serde(rename = "C")]
    Copied,
    #[serde(rename = "T")]
    TypeChanged,
}

impl FileStatus {
    /// git raw diff의 상태 문자를 매핑한다. 알 수 없는 문자는 Modified로 둔다
    /// (U/X 같은 병합 충돌 표시는 읽기 전용 뷰어에서 의미가 없다).
    pub fn from_letter(letter: char) -> Self {
        match letter.to_ascii_uppercase() {
            'A' => FileStatus::Added,
            'D' => FileStatus::Deleted,
            'R' => FileStatus::Renamed,
            'C' => FileStatus::Copied,
            'T' => FileStatus::TypeChanged,
            _ => FileStatus::Modified,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileChange {
    pub path: String,
    /// rename/copy일 때만 원본 경로
    pub old_path: Option<String>,
    pub status: FileStatus,
    pub additions: u64,
    pub deletions: u64,
}

/// 쓰기 작업 결과.
///
/// git이 0이 아닌 코드로 끝나도 Err가 아니라 `ok: false`다. 인증 실패나
/// non-fast-forward는 사용자가 읽어야 하는 정상적인 결과라서 stderr를 그대로 실어 보낸다.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpResult {
    pub ok: bool,
    /// git stdout. 마지막 200줄만
    pub stdout: String,
    /// git stderr. 마지막 200줄만
    pub stderr: String,
    /// `git diff --name-only --diff-filter=U` 결과. 충돌이 없으면 빈 배열
    pub conflicts: Vec<String>,
    /// 실제로 실행한 git 인자. 프로그램명 "git"과 실행기가 붙이는 `-C <repo>`는 뺀다.
    /// 프론트가 이걸 그대로 내장 터미널에 흘려보내 사용자의 셸에서 다시 실행한다.
    pub command: Vec<String>,
    /// stderr가 인증/권한 실패로 보이면 true. 프론트가 "터미널에서 실행"을 권한다.
    pub needs_auth: bool,
}

/// `get_sync_state` 응답. 툴바의 ↑ahead ↓behind 배지와 Pop 버튼 활성 판정에 쓴다.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncState {
    /// detached HEAD면 None
    pub branch: Option<String>,
    /// "origin/main" 형태. upstream이 없으면 None
    pub upstream: Option<String>,
    pub ahead: u32,
    pub behind: u32,
    pub stash_count: u32,
    /// continue/abort가 필요한 진행 중 작업. 없으면 None
    pub pending: Option<PendingOp>,
}

/// 진행 중인 작업의 종류. `.git` 안의 표식 파일로 판정한다.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum PendingKind {
    Merge,
    Rebase,
    CherryPick,
    Revert,
}

/// 진행 중이라 continue/abort가 필요한 작업.
///
/// git은 이 상태를 별도 API로 알려주지 않는다. `.git/MERGE_HEAD`처럼 작업 중에만
/// 존재하는 파일이 유일한 신호다.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingOp {
    pub kind: PendingKind,
    /// 리베이스 진행도 "3/12". 알 수 없으면 None
    pub progress: Option<String>,
    pub conflict_count: u32,
    /// 리베이스 중인 브랜치 이름 등 부가 설명. 없으면 None
    pub detail: Option<String>,
}

/// 충돌 파일 하나. 어느 쪽이 지웠는지까지 구분해야 UI가 "Use ours"를 올바로 그린다.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ConflictKind {
    BothModified,
    BothAdded,
    DeletedByUs,
    DeletedByThem,
    BothDeleted,
}

/// `get_conflicts` 응답 항목.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConflictFile {
    pub path: String,
    pub kind: ConflictKind,
    /// 충돌 마커가 파일에 남아 있으면 true. 손으로 고치면 false가 된다
    pub has_markers: bool,
}

/// `list_remotes` 응답 항목. fetch와 push URL이 다를 수 있어 둘 다 싣는다.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteInfo {
    pub name: String,
    pub fetch_url: String,
    pub push_url: String,
}

/// `list_worktrees` 응답 항목.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeInfo {
    pub path: String,
    /// 체크아웃된 브랜치. detached면 None
    pub branch: Option<String>,
    pub head: String,
    /// 지금 앱이 열어 둔 워크트리 자신이면 true. UI가 이걸 지우지 못하게 막는다
    pub is_main: bool,
    /// 디렉토리가 사라져 prune 대상이면 true
    pub is_prunable: bool,
}

/// `git_rebase_interactive`의 todo 한 줄.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RebaseStep {
    pub sha: String,
    /// "pick" | "reword" | "edit" | "squash" | "fixup" | "drop"
    pub action: String,
    /// 화면 표시용 원본 subject. todo 주석으로만 쓴다
    #[serde(default)]
    pub subject: String,
    /// action이 "reword"일 때 쓸 새 메시지
    #[serde(default)]
    pub message: Option<String>,
}

/// `git_commit` 인자 묶음. 인자가 여섯 개라 구조체로 받는다.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitOptions {
    pub message: String,
    pub amend: bool,
    pub signoff: bool,
    pub gpg_sign: bool,
    pub allow_empty: bool,
    /// 추적 중인 파일의 변경을 전부 스테이지하고 커밋 (-a)
    pub stage_all: bool,
}

/// `get_wip_details` 응답. 세 영역은 서로 겹칠 수 있다(같은 파일이 staged와 unstaged 양쪽에).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WipDetails {
    /// 인덱스에 올라간 변경 (`git diff --cached`)
    pub staged: Vec<FileChange>,
    /// 워킹 트리 변경 중 인덱스에 안 올라간 것 (`git diff`)
    pub unstaged: Vec<FileChange>,
    /// 추적되지 않는 새 파일. status는 항상 Added, deletions는 0이다
    pub untracked: Vec<FileChange>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Signature {
    pub name: String,
    pub email: String,
    /// unix seconds
    pub timestamp: i64,
}

/// `get_commit_details` 응답.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitDetails {
    pub sha: String,
    pub subject: String,
    /// subject를 제외한 본문. 없으면 ""
    pub body: String,
    pub author: Signature,
    pub committer: Signature,
    pub parents: Vec<String>,
    pub files: Vec<FileChange>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ref_kind는_types_ts의_문자열로_직렬화된다() {
        assert_eq!(
            serde_json::to_string(&RefKind::LocalBranch).unwrap(),
            "\"localBranch\""
        );
        assert_eq!(
            serde_json::to_string(&RefKind::RemoteBranch).unwrap(),
            "\"remoteBranch\""
        );
        assert_eq!(serde_json::to_string(&RefKind::Tag).unwrap(), "\"tag\"");
    }

    #[test]
    fn file_status는_한글자_문자열로_직렬화된다() {
        let all = [
            (FileStatus::Added, "\"A\""),
            (FileStatus::Modified, "\"M\""),
            (FileStatus::Deleted, "\"D\""),
            (FileStatus::Renamed, "\"R\""),
            (FileStatus::Copied, "\"C\""),
            (FileStatus::TypeChanged, "\"T\""),
        ];
        for (status, expected) in all {
            assert_eq!(serde_json::to_string(&status).unwrap(), expected);
        }
    }

    #[test]
    fn wip_info와_ref_entry는_camel_case_키를_쓴다() {
        let wip = WipInfo {
            changed_files: 7,
            staged_files: 4,
            untracked_files: 2,
        };
        assert_eq!(
            serde_json::to_string(&wip).unwrap(),
            r#"{"changedFiles":7,"stagedFiles":4,"untrackedFiles":2}"#
        );

        let entry = RefEntry {
            name: "origin/main".into(),
            kind: RefKind::RemoteBranch,
            sha: "abc".into(),
            is_head: false,
        };
        assert_eq!(
            serde_json::to_string(&entry).unwrap(),
            r#"{"name":"origin/main","kind":"remoteBranch","sha":"abc","isHead":false}"#
        );
    }

    #[test]
    fn search_match와_repo_state는_camel_case_키를_쓴다() {
        let hit = SearchMatch {
            sha: "abc".into(),
            index: 42,
        };
        assert_eq!(
            serde_json::to_string(&hit).unwrap(),
            r#"{"sha":"abc","index":42}"#
        );

        let state = RepoState {
            graph_token: "deadbeef".into(),
            wip: Some(WipInfo {
                changed_files: 2,
                staged_files: 1,
                untracked_files: 0,
            }),
        };
        assert_eq!(
            serde_json::to_string(&state).unwrap(),
            r#"{"graphToken":"deadbeef","wip":{"changedFiles":2,"stagedFiles":1,"untrackedFiles":0}}"#
        );

        let clean = RepoState {
            graph_token: "deadbeef".into(),
            wip: None,
        };
        assert_eq!(
            serde_json::to_string(&clean).unwrap(),
            r#"{"graphToken":"deadbeef","wip":null}"#
        );
    }

    #[test]
    fn stash_info는_camel_case_키를_쓴다() {
        let stash = StashInfo {
            sha: "3505d9ec".into(),
            short_sha: "3505d9ec".into(),
            message: "WIP on main: cbbb765 base".into(),
            base_sha: "cbbb765".into(),
            timestamp: 1788225688,
        };
        let json = serde_json::to_value(&stash).unwrap();
        for key in ["sha", "shortSha", "message", "baseSha", "timestamp"] {
            assert!(json.get(key).is_some(), "{key} 키가 없다");
        }
    }

    #[test]
    fn short_sha는_10자리다() {
        assert_eq!(
            short_sha("ff362da2fa5b5d45b1b53354e085b920039aa4d8"),
            "ff362da2fa"
        );
        assert_eq!(short_sha("abc"), "abc", "짧으면 그대로 둔다");
    }

    #[test]
    fn edge는_camel_case_키로_직렬화된다() {
        let edge = Edge {
            from_lane: 1,
            to_lane: 2,
            color: 3,
            child_row: 4,
            parent_row: -1,
        };
        assert_eq!(
            serde_json::to_string(&edge).unwrap(),
            r#"{"fromLane":1,"toLane":2,"color":3,"childRow":4,"parentRow":-1}"#
        );
    }

    #[test]
    fn file_change의_old_path는_null로_직렬화된다() {
        let change = FileChange {
            path: "a.txt".into(),
            old_path: None,
            status: FileStatus::Modified,
            additions: 1,
            deletions: 2,
        };
        assert_eq!(
            serde_json::to_string(&change).unwrap(),
            r#"{"path":"a.txt","oldPath":null,"status":"M","additions":1,"deletions":2}"#
        );
    }

    #[test]
    fn repo_info와_graph_data는_camel_case_키를_쓴다() {
        let info = RepoInfo {
            path: "/tmp/r".into(),
            name: "r".into(),
            head_branch: "main".into(),
            head_sha: "abc".into(),
        };
        let json = serde_json::to_value(&info).unwrap();
        for key in ["path", "name", "headBranch", "headSha"] {
            assert!(json.get(key).is_some(), "{key} 키가 없다");
        }

        let data = GraphData {
            rows: vec![],
            total_loaded: 0,
            has_more: false,
            lane_count: 1,
            wip: None,
            graph_token: "0".into(),
            stashes: vec![],
        };
        let json = serde_json::to_value(&data).unwrap();
        for key in [
            "rows",
            "totalLoaded",
            "hasMore",
            "laneCount",
            "wip",
            "graphToken",
            "stashes",
        ] {
            assert!(json.get(key).is_some(), "{key} 키가 없다");
        }
        assert!(json.get("wip").unwrap().is_null(), "깨끗하면 null이다");
    }
}

#[cfg(test)]
mod wire_tests {
    use super::*;

    /// 필드 이름 하나가 어긋나면 프론트에서 `undefined`가 되고, 그건 런타임에야 드러난다.
    /// serde 속성은 컴파일러가 검사하지 않으므로 직렬화 결과를 직접 본다.
    #[test]
    fn op_result가_camel_case로_나간다() {
        let json = serde_json::to_value(OpResult {
            ok: false,
            stdout: String::new(),
            stderr: "Permission denied (publickey).".to_string(),
            conflicts: vec!["a.txt".to_string()],
            command: vec!["push".to_string(), "origin".to_string()],
            needs_auth: true,
        })
        .unwrap();

        assert_eq!(json["ok"], false);
        assert_eq!(json["needsAuth"], true);
        assert_eq!(json["command"][0], "push");
        assert_eq!(json["conflicts"][0], "a.txt");
        assert!(json.get("needs_auth").is_none(), "snake_case가 새어 나갔다");
    }

    #[test]
    fn sync_state의_pending이_계약대로_직렬화된다() {
        let json = serde_json::to_value(SyncState {
            branch: None,
            upstream: Some("origin/main".to_string()),
            ahead: 3,
            behind: 1,
            stash_count: 2,
            pending: Some(PendingOp {
                kind: PendingKind::CherryPick,
                progress: Some("3/12".to_string()),
                conflict_count: 1,
                detail: None,
            }),
        })
        .unwrap();

        assert_eq!(json["branch"], serde_json::Value::Null);
        assert_eq!(json["stashCount"], 2);
        // PendingKind는 프론트가 그대로 git_pending_action에 되돌려 보낸다
        assert_eq!(json["pending"]["kind"], "cherryPick");
        assert_eq!(json["pending"]["progress"], "3/12");
        assert_eq!(json["pending"]["conflictCount"], 1);
        assert_eq!(json["pending"]["detail"], serde_json::Value::Null);
    }

    #[test]
    fn 모든_pending_kind_이름이_계약과_같다() {
        let names: Vec<String> = [
            PendingKind::Merge,
            PendingKind::Rebase,
            PendingKind::CherryPick,
            PendingKind::Revert,
        ]
        .iter()
        .map(|kind| {
            serde_json::to_value(kind)
                .unwrap()
                .as_str()
                .unwrap()
                .to_string()
        })
        .collect();
        assert_eq!(names, ["merge", "rebase", "cherryPick", "revert"]);
    }

    #[test]
    fn 모든_conflict_kind_이름이_계약과_같다() {
        let names: Vec<String> = [
            ConflictKind::BothModified,
            ConflictKind::BothAdded,
            ConflictKind::DeletedByUs,
            ConflictKind::DeletedByThem,
            ConflictKind::BothDeleted,
        ]
        .iter()
        .map(|kind| {
            serde_json::to_value(kind)
                .unwrap()
                .as_str()
                .unwrap()
                .to_string()
        })
        .collect();
        assert_eq!(
            names,
            [
                "bothModified",
                "bothAdded",
                "deletedByUs",
                "deletedByThem",
                "bothDeleted"
            ]
        );
    }

    #[test]
    fn remote와_worktree도_camel_case로_나간다() {
        let json = serde_json::to_value(RemoteInfo {
            name: "origin".to_string(),
            fetch_url: "https://example.com/a.git".to_string(),
            push_url: "https://example.com/a.git".to_string(),
        })
        .unwrap();
        assert_eq!(json["fetchUrl"], "https://example.com/a.git");
        assert_eq!(json["pushUrl"], "https://example.com/a.git");

        let json = serde_json::to_value(WorktreeInfo {
            path: "/repo".to_string(),
            branch: Some("main".to_string()),
            head: "abc".to_string(),
            is_main: true,
            is_prunable: false,
        })
        .unwrap();
        assert_eq!(json["isMain"], true);
        assert_eq!(json["isPrunable"], false);

        let json = serde_json::to_value(ConflictFile {
            path: "a.txt".to_string(),
            kind: ConflictKind::BothModified,
            has_markers: true,
        })
        .unwrap();
        assert_eq!(json["hasMarkers"], true);
    }

    /// tauri가 command 인자를 camelCase로 받으므로 구조체 인자도 같은 표기로 들어온다.
    #[test]
    fn commit_options를_camel_case_json에서_읽는다() {
        let options: CommitOptions = serde_json::from_str(
            r#"{"message":"제목","amend":true,"signoff":false,
                "gpgSign":true,"allowEmpty":false,"stageAll":true}"#,
        )
        .unwrap();

        assert_eq!(options.message, "제목");
        assert!(options.amend);
        assert!(options.gpg_sign);
        assert!(options.stage_all);
        assert!(!options.allow_empty);

        // snake_case로 오면 거부해야 한다. 조용히 기본값이 되면 GPG 서명이 사라진다.
        assert!(serde_json::from_str::<CommitOptions>(
            r#"{"message":"x","amend":false,"signoff":false,
                "gpg_sign":true,"allow_empty":false,"stage_all":false}"#
        )
        .is_err());
    }

    #[test]
    fn rebase_step은_subject와_message가_없어도_읽힌다() {
        let step: RebaseStep = serde_json::from_str(r#"{"sha":"abc","action":"pick"}"#).unwrap();
        assert_eq!(step.sha, "abc");
        assert_eq!(step.subject, "");
        assert_eq!(step.message, None);

        let step: RebaseStep = serde_json::from_str(
            r#"{"sha":"abc","action":"reword","subject":"원래 제목","message":"새 제목"}"#,
        )
        .unwrap();
        assert_eq!(step.message.as_deref(), Some("새 제목"));
    }
}
