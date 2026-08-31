//! Tauri command 4개. 계약은 CONTRACTS.md의 "Tauri Commands" 절.
//!
//! @see CONTRACTS.md

use std::path::Path;

use crate::git;
use crate::layout::assign_lanes;
use crate::model::{CommitDetails, CommitRow, FileChange, GraphData, RefInfo, RepoInfo, Signature};
use crate::parse::{
    parse_commit_meta, parse_file_changes, parse_log, parse_refs, LOG_FORMAT, META_FORMAT,
};

/// short sha 길이. `src/types.ts`의 `CommitRow.shortSha` 주석과 맞춘다.
const SHORT_SHA_LEN: usize = 10;

/// for-each-ref 포맷. for-each-ref는 `%x1f`를 해석하지 않아 `%1f`를 쓴다.
const REF_FORMAT: &str = "--format=%(objectname)%1f%(*objectname)%1f%(refname)%1f%(HEAD)";

/// 저장소를 검증하고 루트 경로, 현재 브랜치, HEAD sha를 돌려준다.
#[tauri::command]
pub fn open_repo(path: String) -> Result<RepoInfo, String> {
    if path.trim().is_empty() {
        return Err("저장소 경로가 비어 있습니다".to_string());
    }

    let root = git::run(&path, &["rev-parse", "--show-toplevel"])
        .map_err(|e| format!("git 저장소를 열지 못했습니다: {e}"))?
        .trim()
        .to_string();

    if root.is_empty() {
        return Err(format!(
            "작업 트리가 없는 저장소입니다(bare repository): {path}"
        ));
    }

    // detached HEAD면 symbolic-ref가 -q로 조용히 실패한다
    let head_branch = git::run(&root, &["symbolic-ref", "--short", "-q", "HEAD"])
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "HEAD".to_string());

    let head_sha = git::run(&root, &["rev-parse", "HEAD"])
        .map_err(|_| format!("커밋이 아직 없는 저장소입니다: {root}"))?
        .trim()
        .to_string();

    let name = Path::new(&root)
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| root.clone());

    Ok(RepoInfo {
        path: root,
        name,
        head_branch,
        head_sha,
    })
}

/// 커밋 그래프를 topo 순서로 읽어 레인/색/엣지까지 계산해 돌려준다.
/// git 호출은 log, for-each-ref, rev-parse 3회다.
#[tauri::command]
pub fn load_graph(path: String, limit: usize) -> Result<GraphData, String> {
    if limit == 0 {
        return Ok(GraphData {
            rows: Vec::new(),
            total_loaded: 0,
            has_more: false,
            lane_count: 1,
        });
    }

    // limit을 넘겼는지 알기 위해 한 개 더 요청한다
    let fetch = limit.saturating_add(1).to_string();
    let log_out = git::run(
        &path,
        &[
            "log",
            "--branches",
            "--remotes",
            "--tags",
            "HEAD",
            "--topo-order",
            "-n",
            fetch.as_str(),
            LOG_FORMAT,
        ],
    )
    .map_err(|e| format!("커밋 목록을 읽지 못했습니다: {e}"))?;

    let mut commits = parse_log(&log_out)?;
    let has_more = commits.len() > limit;
    commits.truncate(limit);

    let ref_out = git::run(
        &path,
        &[
            "for-each-ref",
            REF_FORMAT,
            "refs/heads",
            "refs/remotes",
            "refs/tags",
        ],
    )
    .unwrap_or_default();
    let mut refs_by_sha = parse_refs(&ref_out);

    let head_sha = git::run(&path, &["rev-parse", "HEAD"])
        .map(|s| s.trim().to_string())
        .unwrap_or_default();

    let layout = assign_lanes(&commits);

    let rows: Vec<CommitRow> = commits
        .into_iter()
        .zip(layout.rows)
        .map(|(commit, row)| {
            let refs: Vec<RefInfo> = refs_by_sha.remove(&commit.sha).unwrap_or_default();
            CommitRow {
                short_sha: short_sha(&commit.sha),
                is_head: !head_sha.is_empty() && commit.sha == head_sha,
                is_merge: commit.parents.len() > 1,
                sha: commit.sha,
                subject: commit.subject,
                author: commit.author,
                author_email: commit.author_email,
                timestamp: commit.timestamp,
                parents: commit.parents,
                lane: row.lane,
                color: row.color,
                refs,
                edges: row.edges,
            }
        })
        .collect();

    Ok(GraphData {
        total_loaded: rows.len(),
        has_more,
        lane_count: layout.lane_count,
        rows,
    })
}

/// 커밋 메타데이터와 변경 파일 목록을 돌려준다. git 호출은 2회다.
/// merge commit은 first-parent 기준 diff를 쓴다.
#[tauri::command]
pub fn get_commit_details(path: String, sha: String) -> Result<CommitDetails, String> {
    let sha = validate_rev(&sha)?;

    let meta_out = git::run(&path, &["show", "-s", META_FORMAT, sha.as_str()])
        .map_err(|e| format!("커밋 정보를 읽지 못했습니다: {e}"))?;
    let meta = parse_commit_meta(&meta_out)?;

    let files = load_file_changes(&path, &meta.sha, meta.parents.len() > 1)?;

    Ok(CommitDetails {
        sha: meta.sha,
        subject: meta.subject,
        body: meta.body,
        author: Signature {
            name: meta.author_name,
            email: meta.author_email,
            timestamp: meta.author_timestamp,
        },
        committer: Signature {
            name: meta.committer_name,
            email: meta.committer_email,
            timestamp: meta.committer_timestamp,
        },
        parents: meta.parents,
        files,
    })
}

/// 커밋 안에서 파일 하나의 unified diff 원문을 돌려준다.
/// 루트 커밋은 빈 트리와 비교되도록 `git show`를 쓴다.
#[tauri::command]
pub fn get_file_diff(path: String, sha: String, file: String) -> Result<String, String> {
    let sha = validate_rev(&sha)?;
    if file.trim().is_empty() {
        return Err("파일 경로가 비어 있습니다".to_string());
    }

    let parents = first_line_parents(&path, &sha)?;

    if parents.is_empty() {
        // 루트 커밋: git show가 빈 트리와의 diff를 만들어 준다
        return git::run(
            &path,
            &[
                "show",
                "--format=",
                "--no-color",
                "--no-ext-diff",
                "-M",
                sha.as_str(),
                "--",
                file.as_str(),
            ],
        )
        .map_err(|e| format!("diff를 읽지 못했습니다: {e}"));
    }

    let first_parent = format!("{sha}^1");
    git::run(
        &path,
        &[
            "diff",
            "--no-color",
            "--no-ext-diff",
            "-M",
            first_parent.as_str(),
            sha.as_str(),
            "--",
            file.as_str(),
        ],
    )
    .map_err(|e| format!("diff를 읽지 못했습니다: {e}"))
}

fn load_file_changes(path: &str, sha: &str, is_merge: bool) -> Result<Vec<FileChange>, String> {
    // --raw로 status(A/M/D/R/C/T)를, --numstat으로 증감 줄 수를 한 번에 받는다.
    // raw 레코드는 ':'로 시작해 두 섹션을 한 번의 스캔으로 구분한다.
    let out = if is_merge {
        let first_parent = format!("{sha}^1");
        git::run(
            path,
            &[
                "diff",
                "--raw",
                "--numstat",
                "--no-ext-diff",
                "-M",
                "-z",
                first_parent.as_str(),
                sha,
            ],
        )
    } else {
        git::run(
            path,
            &[
                "show",
                "--format=",
                "--raw",
                "--numstat",
                "--no-ext-diff",
                "-M",
                "-z",
                sha,
            ],
        )
    }
    .map_err(|e| format!("변경 파일 목록을 읽지 못했습니다: {e}"))?;

    Ok(parse_file_changes(&out))
}

/// `git rev-list --parents -n 1`로 부모 목록만 얻는다.
fn first_line_parents(path: &str, sha: &str) -> Result<Vec<String>, String> {
    let out = git::run(path, &["rev-list", "--parents", "--max-count=1", sha])
        .map_err(|e| format!("커밋을 찾지 못했습니다: {e}"))?;
    let mut tokens = out.split_whitespace();
    tokens.next(); // 첫 토큰은 커밋 자신
    Ok(tokens.map(str::to_string).collect())
}

/// rev 문자열이 옵션으로 해석되지 않도록 막는다.
fn validate_rev(sha: &str) -> Result<String, String> {
    let sha = sha.trim();
    if sha.is_empty() {
        return Err("커밋 sha가 비어 있습니다".to_string());
    }
    if sha.starts_with('-') {
        return Err(format!("커밋 sha 형식이 올바르지 않습니다: {sha}"));
    }
    Ok(sha.to_string())
}

fn short_sha(sha: &str) -> String {
    sha.chars().take(SHORT_SHA_LEN).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn short_sha는_10자리다() {
        assert_eq!(
            short_sha("ff362da2fa5b5d45b1b53354e085b920039aa4d8"),
            "ff362da2fa"
        );
        assert_eq!(short_sha("abc"), "abc");
    }

    #[test]
    fn 옵션처럼_생긴_rev는_거부한다() {
        assert!(validate_rev("--upload-pack=evil").is_err());
        assert!(validate_rev("  ").is_err());
        assert_eq!(validate_rev(" abc123 ").unwrap(), "abc123");
    }

    #[test]
    fn 빈_경로로는_저장소를_열지_않는다() {
        assert!(open_repo("   ".to_string()).is_err());
    }

    #[test]
    fn limit이_0이면_빈_그래프를_돌려준다() {
        let data = load_graph(".".to_string(), 0).unwrap();
        assert!(data.rows.is_empty());
        assert_eq!(data.total_loaded, 0);
        assert!(!data.has_more);
        assert_eq!(data.lane_count, 1);
    }
}

/// 실제 git을 돌려 command 4개를 통째로 검증한다.
/// 파서/레이아웃 유닛 테스트가 못 잡는 git 옵션 조합 오류를 잡는 자리다.
#[cfg(test)]
mod integration_tests {
    use super::*;
    use crate::model::FileStatus;
    use std::path::PathBuf;
    use std::process::Command;
    use std::sync::atomic::{AtomicUsize, Ordering};

    static COUNTER: AtomicUsize = AtomicUsize::new(0);

    struct TempRepo {
        root: PathBuf,
    }

    impl Drop for TempRepo {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.root);
        }
    }

    impl TempRepo {
        fn path(&self) -> String {
            self.root.to_string_lossy().into_owned()
        }

        fn git(&self, args: &[&str]) {
            let status = Command::new("git")
                .current_dir(&self.root)
                .env("GIT_AUTHOR_NAME", "테스터")
                .env("GIT_AUTHOR_EMAIL", "tester@example.com")
                .env("GIT_COMMITTER_NAME", "커미터")
                .env("GIT_COMMITTER_EMAIL", "committer@example.com")
                .args(args)
                .output()
                .expect("git 실행 실패");
            assert!(
                status.status.success(),
                "git {args:?} 실패: {}",
                String::from_utf8_lossy(&status.stderr)
            );
        }

        fn write(&self, name: &str, content: &str) {
            let target = self.root.join(name);
            if let Some(parent) = target.parent() {
                std::fs::create_dir_all(parent).unwrap();
            }
            std::fs::write(target, content).unwrap();
        }

        fn rev(&self, rev: &str) -> String {
            let out = Command::new("git")
                .current_dir(&self.root)
                .args(["rev-parse", rev])
                .output()
                .unwrap();
            String::from_utf8_lossy(&out.stdout).trim().to_string()
        }
    }

    /// root -> rename -> (feature | main) -> merge 구조의 저장소를 만든다.
    fn fixture() -> TempRepo {
        let id = COUNTER.fetch_add(1, Ordering::SeqCst);
        let root = std::env::temp_dir().join(format!("gitlanes-test-{}-{id}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        let repo = TempRepo { root };

        repo.git(&["init", "-q", "-b", "main"]);
        repo.git(&["config", "user.name", "테스터"]);
        repo.git(&["config", "user.email", "tester@example.com"]);
        repo.git(&["config", "commit.gpgsign", "false"]);

        repo.write("a.txt", "a\nb\nc\n");
        repo.write("docs/설계 문서.md", "제목\n");
        repo.git(&["add", "-A"]);
        repo.git(&["commit", "-qm", "root commit"]);

        repo.git(&["mv", "a.txt", "b.txt"]);
        repo.write("b.txt", "a\nb\nc\nd\n");
        repo.write("gone.txt", "temp\n");
        repo.git(&["add", "-A"]);
        repo.git(&[
            "commit",
            "-qm",
            "rename and modify\n\n두 번째 줄\n세 번째 줄\n",
        ]);

        repo.git(&["checkout", "-qb", "feature"]);
        repo.write("f.txt", "f\n");
        repo.git(&["add", "-A"]);
        repo.git(&["commit", "-qm", "feature work"]);

        repo.git(&["checkout", "-q", "main"]);
        repo.write("m.txt", "m\n");
        repo.git(&["rm", "-q", "gone.txt"]);
        repo.git(&["add", "-A"]);
        repo.git(&["commit", "-qm", "main work"]);

        repo.git(&["merge", "--no-ff", "-q", "feature", "-m", "Merge feature"]);
        repo.git(&["tag", "-a", "v1.0", "-m", "release"]);
        repo.git(&["tag", "light"]);

        repo
    }

    #[test]
    fn open_repo는_루트와_브랜치와_head_sha를_돌려준다() {
        let repo = fixture();
        let info = open_repo(repo.path()).expect("저장소를 열어야 한다");

        assert_eq!(info.head_branch, "main");
        assert_eq!(info.head_sha, repo.rev("HEAD"));
        assert!(info.path.ends_with(&info.name), "{info:?}");
        assert!(!info.name.is_empty());

        // 하위 디렉토리로 열어도 루트로 정규화된다
        let sub = format!("{}/docs", info.path);
        let from_sub = open_repo(sub).unwrap();
        assert_eq!(from_sub.path, info.path);
    }

    #[test]
    fn detached_head는_브랜치_이름을_head로_돌려준다() {
        let repo = fixture();
        repo.git(&["checkout", "-q", "--detach", "HEAD~1"]);
        let info = open_repo(repo.path()).unwrap();
        assert_eq!(info.head_branch, "HEAD");
        assert_eq!(info.head_sha, repo.rev("HEAD"));
    }

    #[test]
    fn 저장소가_아닌_경로는_오류_메시지를_돌려준다() {
        let dir = std::env::temp_dir().join(format!("gitlanes-not-repo-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        // 임시 디렉토리가 저장소 안일 수도 있으니 부모 검색을 막고 확인한다
        let out = Command::new("git")
            .current_dir(&dir)
            .args(["rev-parse", "--show-toplevel"])
            .output()
            .unwrap();
        if !out.status.success() {
            let err = open_repo(dir.to_string_lossy().into_owned()).unwrap_err();
            assert!(err.contains("git 저장소를 열지 못했습니다"), "{err}");
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn load_graph는_refs와_레인과_엣지를_채운다() {
        let repo = fixture();
        let data = load_graph(repo.path(), 100).unwrap();

        assert_eq!(data.total_loaded, 5);
        assert!(!data.has_more);
        assert_eq!(data.rows.len(), 5);
        assert!(data.lane_count >= 2, "브랜치가 갈라져 레인이 2개 이상이다");

        // topo 순서라 첫 row가 머지 커밋(HEAD)이다
        let head = &data.rows[0];
        assert!(head.is_head);
        assert!(head.is_merge);
        assert_eq!(head.parents.len(), 2);
        assert_eq!(head.short_sha.len(), 10);
        assert!(head.sha.starts_with(&head.short_sha));
        assert_eq!(head.author, "테스터");
        assert_eq!(head.author_email, "tester@example.com");
        assert!(head.timestamp > 0);

        // main(HEAD), origin 없음, tag 2개가 머지 커밋에 붙는다
        let names: Vec<&str> = head.refs.iter().map(|r| r.name.as_str()).collect();
        assert!(names.contains(&"main"), "{names:?}");
        assert!(
            names.contains(&"v1.0"),
            "annotated tag가 커밋에 붙어야 한다"
        );
        assert!(names.contains(&"light"));
        assert!(head.refs.iter().any(|r| r.name == "main" && r.is_head));

        // feature 브랜치 ref
        assert!(data
            .rows
            .iter()
            .any(|r| r.refs.iter().any(|f| f.name == "feature")));

        // 루트 커밋 아래로는 선이 없고, 나머지 row에는 선분이 있다
        let root = data.rows.last().unwrap();
        assert!(root.parents.is_empty());
        assert!(root.edges.is_empty());
        assert!(data.rows[..4].iter().all(|r| !r.edges.is_empty()));

        // 엣지 레인은 lane_count 범위 안이다
        for row in &data.rows {
            assert!(row.lane < data.lane_count);
            for e in &row.edges {
                assert!(e.from_lane < data.lane_count && e.to_lane < data.lane_count);
                assert!(e.color < crate::layout::COLOR_COUNT);
            }
        }
    }

    #[test]
    fn limit을_넘기면_잘라내고_has_more를_켠다() {
        let repo = fixture();
        let data = load_graph(repo.path(), 2).unwrap();
        assert_eq!(data.rows.len(), 2);
        assert_eq!(data.total_loaded, 2);
        assert!(data.has_more);
    }

    #[test]
    fn get_commit_details는_rename과_증감을_함께_돌려준다() {
        let repo = fixture();
        let sha = repo.rev("HEAD~2"); // rename and modify
        let details = get_commit_details(repo.path(), sha.clone()).unwrap();

        assert_eq!(details.sha, sha);
        assert_eq!(details.subject, "rename and modify");
        assert_eq!(details.body, "두 번째 줄\n세 번째 줄");
        assert_eq!(details.author.name, "테스터");
        assert_eq!(details.committer.name, "커미터");
        assert!(details.author.timestamp > 0);
        assert_eq!(details.parents.len(), 1);

        let renamed = details
            .files
            .iter()
            .find(|f| f.path == "b.txt")
            .expect("rename된 b.txt가 있어야 한다");
        assert_eq!(renamed.status, FileStatus::Renamed);
        assert_eq!(renamed.old_path.as_deref(), Some("a.txt"));
        assert_eq!(renamed.additions, 1);
        assert_eq!(renamed.deletions, 0);

        let added = details
            .files
            .iter()
            .find(|f| f.path == "gone.txt")
            .expect("추가된 gone.txt가 있어야 한다");
        assert_eq!(added.status, FileStatus::Added);
        assert_eq!(added.old_path, None);
        assert_eq!(added.additions, 1);
    }

    #[test]
    fn 루트_커밋도_파일_목록을_돌려준다() {
        let repo = fixture();
        let sha = repo.rev("HEAD~3");
        let details = get_commit_details(repo.path(), sha).unwrap();

        assert!(details.parents.is_empty());
        assert_eq!(details.subject, "root commit");
        assert_eq!(details.body, "");
        assert_eq!(details.files.len(), 2);
        assert!(details.files.iter().all(|f| f.status == FileStatus::Added));
        // 공백과 한글이 섞인 경로도 이스케이프 없이 온다
        assert!(details.files.iter().any(|f| f.path == "docs/설계 문서.md"));
    }

    #[test]
    fn merge_커밋은_first_parent_기준_diff를_돌려준다() {
        let repo = fixture();
        let details = get_commit_details(repo.path(), "HEAD".to_string()).unwrap();

        assert_eq!(details.parents.len(), 2);
        // first parent가 main work이므로 feature가 넣은 f.txt만 남는다
        let paths: Vec<&str> = details.files.iter().map(|f| f.path.as_str()).collect();
        assert_eq!(paths, vec!["f.txt"], "{paths:?}");
        assert_eq!(details.files[0].status, FileStatus::Added);
        assert_eq!(details.files[0].additions, 1);
    }

    #[test]
    fn 삭제된_파일도_상태와_삭제_줄_수를_돌려준다() {
        let repo = fixture();
        let sha = repo.rev("HEAD~1"); // main work
        let details = get_commit_details(repo.path(), sha).unwrap();
        let deleted = details
            .files
            .iter()
            .find(|f| f.path == "gone.txt")
            .expect("삭제된 gone.txt가 있어야 한다");
        assert_eq!(deleted.status, FileStatus::Deleted);
        assert_eq!(deleted.deletions, 1);
        assert_eq!(deleted.additions, 0);
    }

    #[test]
    fn 없는_커밋은_오류_메시지를_돌려준다() {
        let repo = fixture();
        let err = get_commit_details(repo.path(), "deadbeefdeadbeef".to_string()).unwrap_err();
        assert!(err.contains("커밋 정보를 읽지 못했습니다"), "{err}");
    }

    #[test]
    fn get_file_diff는_unified_diff_원문을_돌려준다() {
        let repo = fixture();
        let sha = repo.rev("HEAD~1"); // main work
        let diff = get_file_diff(repo.path(), sha, "m.txt".to_string()).unwrap();
        assert!(diff.contains("+++ b/m.txt"), "{diff}");
        assert!(diff.contains("@@"), "{diff}");
        assert!(diff.contains("+m"), "{diff}");
    }

    #[test]
    fn 루트_커밋의_diff도_동작한다() {
        let repo = fixture();
        let sha = repo.rev("HEAD~3");
        let diff = get_file_diff(repo.path(), sha, "a.txt".to_string()).unwrap();
        assert!(diff.contains("new file mode"), "{diff}");
        assert!(diff.contains("+++ b/a.txt"), "{diff}");
        assert!(diff.contains("+a"), "{diff}");
    }

    #[test]
    fn merge_커밋의_diff는_first_parent_기준이다() {
        let repo = fixture();
        let diff = get_file_diff(repo.path(), "HEAD".to_string(), "f.txt".to_string()).unwrap();
        assert!(diff.contains("+++ b/f.txt"), "{diff}");
        assert!(diff.contains("+f"), "{diff}");

        // first parent에 이미 있던 m.txt는 머지 diff에 나오지 않는다
        let empty = get_file_diff(repo.path(), "HEAD".to_string(), "m.txt".to_string()).unwrap();
        assert!(empty.trim().is_empty(), "{empty}");
    }

    #[test]
    fn 공백과_한글이_섞인_경로도_diff를_읽는다() {
        let repo = fixture();
        let sha = repo.rev("HEAD~3");
        let diff = get_file_diff(repo.path(), sha, "docs/설계 문서.md".to_string()).unwrap();
        assert!(diff.contains("docs/설계 문서.md"), "{diff}");
    }
}
