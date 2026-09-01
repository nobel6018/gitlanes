//! 프론트엔드 접점 타입. `src/types.ts`와 1:1로 대응한다.
//!
//! @see CONTRACTS.md

use serde::Serialize;

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
        };
        assert_eq!(
            serde_json::to_string(&wip).unwrap(),
            r#"{"changedFiles":7,"stagedFiles":4}"#
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
            }),
        };
        assert_eq!(
            serde_json::to_string(&state).unwrap(),
            r#"{"graphToken":"deadbeef","wip":{"changedFiles":2,"stagedFiles":1}}"#
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
