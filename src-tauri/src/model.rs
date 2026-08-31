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
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Edge {
    pub from_lane: usize,
    pub to_lane: usize,
    /// LANE_COLORS 인덱스 (0..9)
    pub color: usize,
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

/// `load_graph` 응답.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphData {
    pub rows: Vec<CommitRow>,
    pub total_loaded: usize,
    pub has_more: bool,
    pub lane_count: usize,
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
    fn edge는_camel_case_키로_직렬화된다() {
        let edge = Edge {
            from_lane: 1,
            to_lane: 2,
            color: 3,
        };
        assert_eq!(
            serde_json::to_string(&edge).unwrap(),
            r#"{"fromLane":1,"toLane":2,"color":3}"#
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
        };
        let json = serde_json::to_value(&data).unwrap();
        for key in ["rows", "totalLoaded", "hasMore", "laneCount"] {
            assert!(json.get(key).is_some(), "{key} 키가 없다");
        }
    }
}
