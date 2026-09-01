//! Tauri command 6개. 계약은 CONTRACTS.md의 "Tauri Commands" 절.
//!
//! @see CONTRACTS.md

use std::path::Path;

use crate::git;
use crate::layout::assign_lanes;
use crate::model::{
    short_sha, CommitDetails, CommitRow, FileChange, GraphData, RefEntry, RefInfo, RepoInfo,
    Signature,
};
use crate::parse::{
    graph_token, parse_commit_meta, parse_file_changes, parse_log, parse_ref_entries, parse_refs,
    parse_stashes, parse_status, LOG_FORMAT, META_FORMAT, STASH_FORMAT,
};

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
///
/// 레이아웃은 언제나 처음부터 `limit`까지 계산하고, `rows`만 `[skip, limit)` 구간을 담는다.
/// 레인과 엣지가 앞 커밋들에 의존하기 때문에 중간부터 계산할 수 없다.
/// `total_loaded`, `has_more`, `lane_count`, `wip`, `graph_token`, `stashes`는 전체 기준이다.
///
/// git 호출은 log, for-each-ref, rev-parse, status, stash list 5회다.
#[tauri::command]
pub fn load_graph(path: String, limit: usize, skip: usize) -> Result<GraphData, String> {
    if limit == 0 {
        return Ok(GraphData {
            rows: Vec::new(),
            total_loaded: 0,
            has_more: false,
            lane_count: 1,
            wip: None,
            graph_token: String::new(),
            stashes: Vec::new(),
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
    let total_loaded = commits.len();

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
    // for-each-ref 결과 하나로 refs 맵과 지문을 함께 만든다 (git 호출 추가 없음)
    let ref_entries = parse_ref_entries(&ref_out);
    let mut refs_by_sha = parse_refs(&ref_out);

    let head_sha = git::run(&path, &["rev-parse", "HEAD"])
        .map(|s| s.trim().to_string())
        .unwrap_or_default();

    let token = graph_token(&ref_entries, &head_sha);

    // status가 실패해도(잠긴 인덱스 등) 그래프는 보여준다
    let wip = git::run(&path, &["status", "--porcelain", "-z"])
        .ok()
        .and_then(|out| parse_status(&out));

    // 스태시가 없거나 명령이 실패하면 빈 배열이다
    let stashes = git::run(&path, &["stash", "list", STASH_FORMAT])
        .map(|out| parse_stashes(&out))
        .unwrap_or_default();

    let layout = assign_lanes(&commits);

    let rows: Vec<CommitRow> = commits
        .into_iter()
        .zip(layout.rows)
        .skip(skip)
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
        rows,
        total_loaded,
        has_more,
        lane_count: layout.lane_count,
        wip,
        graph_token: token,
        stashes,
    })
}

/// 사이드바용 전체 refs. 로드된 커밋 범위와 무관하게 저장소의 모든 ref를 돌려준다.
/// git 호출은 for-each-ref 1회다.
#[tauri::command]
pub fn list_refs(path: String) -> Result<Vec<RefEntry>, String> {
    let out = git::run(
        &path,
        &[
            "for-each-ref",
            REF_FORMAT,
            "refs/heads",
            "refs/remotes",
            "refs/tags",
        ],
    )
    .map_err(|e| format!("ref 목록을 읽지 못했습니다: {e}"))?;

    Ok(parse_ref_entries(&out))
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
pub fn get_file_diff(
    path: String,
    sha: String,
    file: String,
    old_file: Option<String>,
) -> Result<String, String> {
    let sha = validate_rev(&sha)?;
    if file.trim().is_empty() {
        return Err("파일 경로가 비어 있습니다".to_string());
    }

    let parents = first_line_parents(&path, &sha)?;
    let first_parent = format!("{sha}^1");

    let mut args: Vec<&str> = if parents.is_empty() {
        // 루트 커밋: git show가 빈 트리와의 diff를 만들어 준다
        vec![
            "show",
            "--format=",
            "--no-color",
            "--no-ext-diff",
            "-M",
            sha.as_str(),
        ]
    } else {
        vec![
            "diff",
            "--no-color",
            "--no-ext-diff",
            "-M",
            first_parent.as_str(),
            sha.as_str(),
        ]
    };

    args.push("--");
    // rename/copy는 원본 경로도 pathspec에 걸어야 한다. 새 경로만 걸면 rename 원본이
    // 필터에서 빠져 git이 rename을 못 찾고 "new file"로 보여준다.
    if let Some(old) = old_file
        .as_deref()
        .map(str::trim)
        .filter(|old| !old.is_empty() && *old != file)
    {
        args.push(old);
    }
    args.push(file.as_str());

    git::run(&path, &args).map_err(|e| format!("diff를 읽지 못했습니다: {e}"))
}

/// 시작 시 열 저장소 경로. CLI 첫 위치 인자 → `GITLANES_REPO` 환경변수 순으로 찾는다.
/// 경로 존재 검증은 하지 않는다. 검증은 [`open_repo`]가 한다.
#[tauri::command]
pub fn get_startup_repo() -> Option<String> {
    pick_startup_repo(
        std::env::args().skip(1),
        std::env::var("GITLANES_REPO").ok(),
    )
}

fn pick_startup_repo<I>(args: I, env: Option<String>) -> Option<String>
where
    I: IntoIterator<Item = String>,
{
    let args: Vec<String> = args.into_iter().collect();
    // --dump 모드의 <repo-path>, [limit]을 시작 레포로 착각하지 않게 한다
    if args.iter().any(|arg| arg == crate::dump::DUMP_FLAG) {
        return None;
    }

    // macOS가 붙이는 -psn_0_... 같은 플래그성 인자는 위치 인자가 아니다
    let positional = args
        .into_iter()
        .find(|arg| !arg.is_empty() && !arg.starts_with('-'));

    positional
        .or(env)
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 옵션처럼_생긴_rev는_거부한다() {
        assert!(validate_rev("--upload-pack=evil").is_err());
        assert!(validate_rev("  ").is_err());
        assert_eq!(validate_rev(" abc123 ").unwrap(), "abc123");
    }

    #[test]
    fn 시작_레포는_첫_위치_인자를_먼저_쓴다() {
        let args = [
            "--flag".to_string(),
            "/repo/a".to_string(),
            "/repo/b".to_string(),
        ];
        assert_eq!(
            pick_startup_repo(args, Some("/env/repo".to_string())),
            Some("/repo/a".to_string())
        );
    }

    #[test]
    fn 위치_인자가_없으면_환경변수를_쓴다() {
        assert_eq!(
            pick_startup_repo(["-psn_0_12345".to_string()], Some("/env/repo".to_string())),
            Some("/env/repo".to_string())
        );
    }

    #[test]
    fn dump_모드에서는_시작_레포를_읽지_않는다() {
        let args = [
            "--dump".to_string(),
            "/repo/a".to_string(),
            "500".to_string(),
        ];
        assert_eq!(pick_startup_repo(args, Some("/env/repo".to_string())), None);
    }

    #[test]
    fn 둘_다_없거나_공백이면_none이다() {
        assert_eq!(pick_startup_repo(Vec::<String>::new(), None), None);
        assert_eq!(
            pick_startup_repo(Vec::<String>::new(), Some("   ".into())),
            None
        );
        assert_eq!(pick_startup_repo(["".to_string()], None), None);
    }

    #[test]
    fn 빈_경로로는_저장소를_열지_않는다() {
        assert!(open_repo("   ".to_string()).is_err());
    }

    #[test]
    fn limit이_0이면_빈_그래프를_돌려준다() {
        let data = load_graph(".".to_string(), 0, 0).unwrap();
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
    use crate::model::{FileStatus, RefKind};
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
        // 줄 하나를 갈아치워 rename + modify가 되게 한다 (유사도 66%로 -M이 잡는다)
        repo.write("b.txt", "a\nb\nd\n");
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
        let data = load_graph(repo.path(), 100, 0).unwrap();

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
        let data = load_graph(repo.path(), 2, 0).unwrap();
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
        assert_eq!(renamed.deletions, 1);

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
        let diff = get_file_diff(repo.path(), sha, "m.txt".to_string(), None).unwrap();
        assert!(diff.contains("+++ b/m.txt"), "{diff}");
        assert!(diff.contains("@@"), "{diff}");
        assert!(diff.contains("+m"), "{diff}");
    }

    #[test]
    fn 루트_커밋의_diff도_동작한다() {
        let repo = fixture();
        let sha = repo.rev("HEAD~3");
        let diff = get_file_diff(repo.path(), sha, "a.txt".to_string(), None).unwrap();
        assert!(diff.contains("new file mode"), "{diff}");
        assert!(diff.contains("+++ b/a.txt"), "{diff}");
        assert!(diff.contains("+a"), "{diff}");
    }

    #[test]
    fn merge_커밋의_diff는_first_parent_기준이다() {
        let repo = fixture();
        let diff =
            get_file_diff(repo.path(), "HEAD".to_string(), "f.txt".to_string(), None).unwrap();
        assert!(diff.contains("+++ b/f.txt"), "{diff}");
        assert!(diff.contains("+f"), "{diff}");

        // first parent에 이미 있던 m.txt는 머지 diff에 나오지 않는다
        let empty =
            get_file_diff(repo.path(), "HEAD".to_string(), "m.txt".to_string(), None).unwrap();
        assert!(empty.trim().is_empty(), "{empty}");
    }

    #[test]
    fn skip은_레이아웃을_유지한_채_구간만_잘라_돌려준다() {
        let repo = fixture();
        let full = load_graph(repo.path(), 100, 0).unwrap();
        assert_eq!(full.rows.len(), 5);
        assert_eq!(full.total_loaded, 5);

        // 중간부터: 레인/색/엣지가 전체 계산 결과와 같아야 한다
        let tail = load_graph(repo.path(), 100, 2).unwrap();
        assert_eq!(tail.rows.len(), 3);
        assert_eq!(tail.rows, full.rows[2..]);

        // skip과 무관한 필드는 전체 기준을 유지한다
        assert_eq!(tail.total_loaded, 5, "totalLoaded는 계산된 전체 행 수다");
        assert_eq!(tail.lane_count, full.lane_count);
        assert_eq!(tail.has_more, full.has_more);
        assert_eq!(tail.graph_token, full.graph_token);
        assert_eq!(tail.wip, full.wip);
    }

    #[test]
    fn skip_경계값을_처리한다() {
        let repo = fixture();
        let full = load_graph(repo.path(), 100, 0).unwrap();

        // 마지막 한 행
        let last = load_graph(repo.path(), 100, 4).unwrap();
        assert_eq!(last.rows.len(), 1);
        assert_eq!(last.rows[0], full.rows[4]);

        // 전체 행 수와 같으면 빈 목록
        let exact = load_graph(repo.path(), 100, 5).unwrap();
        assert!(exact.rows.is_empty());
        assert_eq!(exact.total_loaded, 5);

        // 넘어서면 빈 목록 (패닉 없이)
        let over = load_graph(repo.path(), 100, 9999).unwrap();
        assert!(over.rows.is_empty());
        assert_eq!(over.total_loaded, 5);
        assert_eq!(over.lane_count, full.lane_count);
    }

    #[test]
    fn skip은_limit과_함께_동작한다() {
        let repo = fixture();
        // limit 3으로 자른 뒤 뒤쪽 2행만
        let page = load_graph(repo.path(), 3, 1).unwrap();
        assert_eq!(page.rows.len(), 2);
        assert_eq!(page.total_loaded, 3);
        assert!(page.has_more, "limit에 걸렸으니 hasMore다");

        let whole_page = load_graph(repo.path(), 3, 0).unwrap();
        assert_eq!(page.rows, whole_page.rows[1..]);
    }

    #[test]
    fn graph_token은_브랜치_추가_전후로_달라진다() {
        let repo = fixture();
        let before = load_graph(repo.path(), 100, 0).unwrap().graph_token;
        assert!(!before.is_empty());

        // 같은 커밋을 가리키는 브랜치를 새로 만들어도 지문이 바뀐다
        repo.git(&["branch", "another"]);
        let after = load_graph(repo.path(), 100, 0).unwrap().graph_token;
        assert_ne!(after, before);

        // 지우면 원래대로 돌아온다
        repo.git(&["branch", "-D", "another"]);
        assert_eq!(load_graph(repo.path(), 100, 0).unwrap().graph_token, before);

        // tip이 움직여도 바뀐다
        repo.write("tokentest.txt", "x\n");
        repo.git(&["add", "-A"]);
        repo.git(&["commit", "-qm", "move tip"]);
        assert_ne!(load_graph(repo.path(), 100, 0).unwrap().graph_token, before);
    }

    #[test]
    fn 스태시가_없으면_빈_배열이다() {
        let repo = fixture();
        assert!(load_graph(repo.path(), 100, 0).unwrap().stashes.is_empty());
    }

    #[test]
    fn 스태시_목록을_채운다() {
        let repo = fixture();
        let base = repo.rev("HEAD");

        repo.write("m.txt", "m\nstashed\n");
        repo.git(&["stash", "push", "-qm", "fix: 한글 메시지 콜론 포함"]);

        let data = load_graph(repo.path(), 100, 0).unwrap();
        assert_eq!(data.stashes.len(), 1);

        let stash = &data.stashes[0];
        assert_eq!(stash.base_sha, base, "첫 부모가 기반 커밋이다");
        assert_eq!(stash.short_sha.len(), 10);
        assert!(stash.sha.starts_with(&stash.short_sha));
        assert!(stash.timestamp > 0);
        assert!(
            stash.message.contains("fix: 한글 메시지 콜론 포함"),
            "{}",
            stash.message
        );

        // 스태시 커밋은 실존 커밋이라 상세 조회가 그대로 된다
        let details = get_commit_details(repo.path(), stash.sha.clone()).unwrap();
        assert!(details.files.iter().any(|f| f.path == "m.txt"));

        // 스태시가 늘면 최신이 앞에 온다
        repo.write("m.txt", "m\nsecond\n");
        repo.git(&["stash", "push", "-qm", "두 번째"]);
        let data = load_graph(repo.path(), 100, 0).unwrap();
        assert_eq!(data.stashes.len(), 2);
        assert!(
            data.stashes[0].message.contains("두 번째"),
            "{:?}",
            data.stashes
        );
    }

    #[test]
    fn 깨끗한_저장소는_wip이_없다() {
        let repo = fixture();
        let data = load_graph(repo.path(), 100, 0).unwrap();
        assert_eq!(data.wip, None);
    }

    #[test]
    fn 미커밋_변경이_있으면_wip을_채운다() {
        let repo = fixture();

        repo.write("m.txt", "m\nchanged\n"); // unstaged 수정
        repo.write("untracked.txt", "new\n"); // untracked
        repo.write("staged.txt", "s\n");
        repo.git(&["add", "staged.txt"]); // staged 추가
        repo.git(&["rm", "-q", "--cached", "f.txt"]); // staged 삭제 + untracked로 남음

        let wip = load_graph(repo.path(), 100, 0)
            .unwrap()
            .wip
            .expect("wip이 있어야 한다");
        assert_eq!(
            wip.changed_files, 4,
            "m.txt, untracked.txt, staged.txt, f.txt"
        );
        assert_eq!(wip.staged_files, 2, "staged.txt(A), f.txt(D)");

        // 되돌리면 다시 깨끗해진다
        repo.git(&["reset", "-q", "--hard", "HEAD"]);
        repo.git(&["clean", "-qfd"]);
        assert_eq!(load_graph(repo.path(), 100, 0).unwrap().wip, None);
    }

    #[test]
    fn staged_rename은_파일_하나로_센다() {
        let repo = fixture();
        repo.git(&["mv", "m.txt", "moved.txt"]);
        let wip = load_graph(repo.path(), 100, 0).unwrap().wip.unwrap();
        assert_eq!(wip.changed_files, 1);
        assert_eq!(wip.staged_files, 1);
    }

    #[test]
    fn list_refs는_브랜치와_태그를_모두_돌려준다() {
        let repo = fixture();
        let refs = list_refs(repo.path()).unwrap();

        assert_eq!(
            refs.iter()
                .map(|r| (r.kind, r.name.as_str()))
                .collect::<Vec<_>>(),
            vec![
                (RefKind::LocalBranch, "feature"),
                (RefKind::LocalBranch, "main"),
                (RefKind::Tag, "light"),
                (RefKind::Tag, "v1.0"),
            ]
        );

        let head = repo.rev("HEAD");
        let main = refs.iter().find(|r| r.name == "main").unwrap();
        assert_eq!(main.sha, head);
        assert!(main.is_head);

        // annotated tag도 tag 객체가 아니라 커밋 sha를 담는다
        let annotated = refs.iter().find(|r| r.name == "v1.0").unwrap();
        assert_eq!(annotated.sha, head);
        assert_ne!(
            repo.rev("v1.0^{}"),
            repo.rev("refs/tags/v1.0"),
            "annotated tag가 맞다"
        );

        assert!(refs.iter().filter(|r| r.is_head).count() == 1);
        assert_eq!(
            refs.iter().find(|r| r.name == "feature").unwrap().sha,
            repo.rev("feature")
        );
    }

    #[test]
    fn list_refs는_저장소가_아니면_오류다() {
        let err = list_refs("/definitely/not/a/repo/gitlanes".to_string()).unwrap_err();
        assert!(err.contains("ref 목록을 읽지 못했습니다"), "{err}");
    }

    #[test]
    fn dump_모드는_요약과_행_목록을_출력한다() {
        let repo = fixture();
        let request = crate::dump::DumpRequest {
            repo: repo.path(),
            limit: 5000,
        };
        let mut out = Vec::new();
        crate::dump::run(&request, &mut out).unwrap();
        let text = String::from_utf8(out).unwrap();
        let lines: Vec<&str> = text.lines().collect();

        assert!(lines[0].starts_with("load_graph: "), "{text}");
        assert!(lines[0].contains("ms totalLoaded=5"), "{text}");
        assert!(lines[0].contains("laneCount=2"), "{text}");
        assert!(lines[0].contains("hasMore=false"), "{text}");
        assert!(
            lines[0].contains("wip=none"),
            "깨끗한 저장소는 wip=none이다: {text}"
        );
        assert!(lines[0].contains("stashes=0"), "{text}");

        // 25행 이하라 생략 줄이 없다
        assert_eq!(lines.len(), 6, "{text}");

        // 첫 행은 머지 커밋이고 main/tag ref가 붙는다
        let head = lines[1];
        assert!(head.contains(" lane=0 color=0 merge=1 "), "{head}");
        assert!(head.contains("edges=[0>0:0, 0>1:1]"), "{head}");
        assert!(head.contains("refs=[main, light, v1.0]"), "{head}");
        assert!(head.ends_with("Merge feature"), "{head}");

        // 루트 커밋은 아래로 이어지는 선이 없다
        assert!(lines[5].contains("edges=[]"), "{}", lines[5]);
        assert!(lines[5].contains("merge=0"), "{}", lines[5]);
    }

    #[test]
    fn rename된_파일은_old_경로를_함께_걸어_수정_diff로_보인다() {
        let repo = fixture();
        let sha = repo.rev("HEAD~2"); // a.txt -> b.txt (rename + modify)

        let diff = get_file_diff(
            repo.path(),
            sha.clone(),
            "b.txt".to_string(),
            Some("a.txt".to_string()),
        )
        .unwrap();

        assert!(diff.contains("rename from a.txt"), "{diff}");
        assert!(diff.contains("rename to b.txt"), "{diff}");
        assert!(
            diff.contains("\n-c\n"),
            "old 경로의 사라진 줄이 -줄로 보여야 한다: {diff}"
        );
        assert!(diff.contains("\n+d\n"), "{diff}");
        assert!(
            !diff.contains("new file mode"),
            "rename이 새 파일 추가로 보이면 안 된다: {diff}"
        );

        // old_file 없이 부르면 pathspec이 새 경로만 걸려 rename 정보를 잃는다
        let without_old = get_file_diff(repo.path(), sha, "b.txt".to_string(), None).unwrap();
        assert!(without_old.contains("new file mode"), "{without_old}");
    }

    #[test]
    fn old_file이_새_경로와_같으면_pathspec을_중복해서_걸지_않는다() {
        let repo = fixture();
        let sha = repo.rev("HEAD~1"); // main work
        let diff = get_file_diff(
            repo.path(),
            sha,
            "m.txt".to_string(),
            Some("m.txt".to_string()),
        )
        .unwrap();
        assert!(diff.contains("+++ b/m.txt"), "{diff}");
        assert_eq!(diff.matches("diff --git").count(), 1, "{diff}");
    }

    #[test]
    fn 공백과_한글이_섞인_경로도_diff를_읽는다() {
        let repo = fixture();
        let sha = repo.rev("HEAD~3");
        let diff = get_file_diff(repo.path(), sha, "docs/설계 문서.md".to_string(), None).unwrap();
        assert!(diff.contains("docs/설계 문서.md"), "{diff}");
    }
}
