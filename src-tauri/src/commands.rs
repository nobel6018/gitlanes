//! 저장소와 워킹 트리를 읽는 Tauri command 13개. 계약은 CONTRACTS.md의 "Tauri Commands" 절.
//! 파일관리자/터미널/최근 목록 command 3개는 [`crate::native`]에 있다.
//!
//! @see CONTRACTS.md

use std::path::{Path, PathBuf};

use crate::git;
use crate::layout::assign_lanes;
use crate::model::{
    short_sha, CommitDetails, CommitRow, FileChange, FileStatus, GraphData, RefEntry, RefInfo,
    RepoInfo, RepoState, SearchMatch, Signature, WipDetails,
};
use crate::parse::{
    graph_token, parse_commit_meta, parse_file_changes, parse_log_record, parse_ref_entries,
    parse_refs, parse_stashes, parse_status, RawCommit, LOG_FORMAT, META_FORMAT, RECORD_SEPARATOR,
    STASH_FORMAT,
};
use crate::remote::normalize_remote_url;
use crate::search::Matcher;

/// for-each-ref 포맷. for-each-ref는 `%x1f`를 해석하지 않아 `%1f`를 쓴다.
const REF_FORMAT: &str = "--format=%(objectname)%1f%(*objectname)%1f%(refname)%1f%(HEAD)";

/// 모든 ref를 훑는 for-each-ref 인자. load_graph, list_refs, get_repo_state가 함께 쓴다.
const REF_ARGS: [&str; 5] = [
    "for-each-ref",
    REF_FORMAT,
    "refs/heads",
    "refs/remotes",
    "refs/tags",
];
const STATUS_ARGS: [&str; 3] = ["status", "--porcelain", "-z"];
const HEAD_ARGS: [&str; 2] = ["rev-parse", "HEAD"];

/// `get_file_content`의 상한. 넘으면 내용을 읽지 않고 거절한다.
/// 뷰어가 한 화면에 올릴 수 있는 크기를 한참 넘고, 문법 강조도 의미가 없어진다.
const MAX_FILE_BYTES: usize = 5 * 1024 * 1024;

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
    let want = limit.saturating_add(1);
    let fetch = want.to_string();
    let log_args: [&str; 9] = [
        "log",
        "--branches",
        "--remotes",
        "--tags",
        "HEAD",
        "--topo-order",
        "-n",
        fetch.as_str(),
        LOG_FORMAT,
    ];
    let stash_args: [&str; 3] = ["stash", "list", STASH_FORMAT];

    // 다섯 호출은 서로 값을 주고받지 않아 동시에 돌린다. log는 읽으면서 바로 파싱해
    // git 실행 시간과 파싱 시간을 겹친다. 벽시계는 가장 무거운 log가 결정한다.
    let (log_result, outputs) = std::thread::scope(|scope| {
        let log = scope.spawn(|| stream_commits(&path, &log_args, want));
        let outputs = git::run_all(
            &path,
            &[
                &REF_ARGS[..],
                &HEAD_ARGS[..],
                &STATUS_ARGS[..],
                &stash_args[..],
            ],
        );
        let log_result = log
            .join()
            .unwrap_or_else(|_| Err("커밋 목록을 읽는 중 내부 오류가 발생했습니다".to_string()));
        (log_result, outputs)
    });

    let [ref_out, head_out, status_out, stash_out] =
        <[_; 4]>::try_from(outputs).expect("run_all은 넘긴 수만큼 결과를 돌려준다");

    let mut commits = log_result?;
    let has_more = commits.len() > limit;
    commits.truncate(limit);
    let total_loaded = commits.len();

    // for-each-ref 결과 하나로 refs 맵과 지문을 함께 만든다 (git 호출 추가 없음)
    let ref_out = ref_out.unwrap_or_default();
    let ref_entries = parse_ref_entries(&ref_out);
    let mut refs_by_sha = parse_refs(&ref_out);

    let head_sha = head_out.map(|s| s.trim().to_string()).unwrap_or_default();
    let token = graph_token(&ref_entries, &head_sha);

    // status가 실패해도(잠긴 인덱스 등) 그래프는 보여준다
    let wip = status_out.ok().and_then(|out| parse_status(&out));

    // 스태시가 없거나 명령이 실패하면 빈 배열이다
    let stashes = stash_out.map(|out| parse_stashes(&out)).unwrap_or_default();

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
    let out = git::run(&path, &REF_ARGS).map_err(|e| format!("ref 목록을 읽지 못했습니다: {e}"))?;

    Ok(parse_ref_entries(&out))
}

/// 전체 히스토리에서 커밋을 찾는다. 로드된 행 범위와 무관하다.
///
/// 레이아웃은 계산하지 않고 log를 스트리밍으로 파싱만 한다. 상한에 닿으면 그 자리에서
/// git을 끊어 남은 히스토리를 읽지 않는다. `index`는 `load_graph`와 같은 topo 순서의
/// 행 번호라 프론트가 그 깊이까지 추가 로드한 뒤 점프하면 된다.
/// 결과는 최대 [`crate::search::MAX_RESULTS`]개다.
#[tauri::command]
pub fn search_commits(
    path: String,
    query: String,
    limit: usize,
) -> Result<Vec<SearchMatch>, String> {
    let Some(matcher) = Matcher::new(&query, limit) else {
        return Ok(Vec::new());
    };

    // load_graph와 같은 ref 집합, 같은 정렬이라 index가 그대로 대응한다. -n만 없다
    let args: [&str; 7] = [
        "log",
        "--branches",
        "--remotes",
        "--tags",
        "HEAD",
        "--topo-order",
        LOG_FORMAT,
    ];

    let mut matches: Vec<SearchMatch> = Vec::new();
    let mut index = 0usize;
    let mut failure: Option<String> = None;

    git::stream_records(
        &path,
        &args,
        RECORD_SEPARATOR,
        |record| match parse_log_record(record) {
            Ok(None) => git::Flow::Continue,
            Ok(Some(commit)) => {
                if matcher.matches(&commit) {
                    matches.push(SearchMatch {
                        sha: commit.sha,
                        index,
                    });
                }
                index += 1;
                if matches.len() >= matcher.cap() {
                    git::Flow::Stop
                } else {
                    git::Flow::Continue
                }
            }
            Err(message) => {
                failure = Some(message);
                git::Flow::Stop
            }
        },
    )
    .map_err(|e| format!("커밋을 검색하지 못했습니다: {e}"))?;

    match failure {
        Some(message) => Err(message),
        None => Ok(matches),
    }
}

/// origin remote(없으면 첫 remote)의 웹 URL. 열 주소가 없으면 None이다.
///
/// 저장소가 아니거나 remote가 없거나 로컬 경로 remote면 모두 None으로 떨어진다.
/// 컨텍스트 메뉴의 "Open on GitHub" 표시 여부를 정하는 용도라 오류를 따로 올리지 않는다.
#[tauri::command]
pub fn get_remote_url(path: String) -> Option<String> {
    if let Some(url) = remote_url_of(&path, "origin") {
        return Some(url);
    }

    // origin이 없으면 등록된 첫 remote를 쓴다
    let first = git::run(&path, &["remote"]).ok()?;
    let first = first.lines().map(str::trim).find(|name| !name.is_empty())?;
    remote_url_of(&path, first)
}

fn remote_url_of(path: &str, name: &str) -> Option<String> {
    let raw = git::run(path, &["remote", "get-url", name]).ok()?;
    normalize_remote_url(raw.trim())
}

/// git log를 스트리밍으로 읽어 커밋 `want`개까지 모은다.
///
/// 출력을 통째로 받지 않고 레코드 단위로 파싱해 git 실행과 파싱을 겹친다.
/// `want`에 닿으면 남은 출력을 버리고 프로세스를 정리한다.
fn stream_commits(path: &str, args: &[&str], want: usize) -> Result<Vec<RawCommit>, String> {
    let mut commits: Vec<RawCommit> = Vec::with_capacity(want.min(8192));
    let mut failure: Option<String> = None;

    git::stream_records(
        path,
        args,
        RECORD_SEPARATOR,
        |record| match parse_log_record(record) {
            Ok(None) => git::Flow::Continue,
            Ok(Some(commit)) => {
                commits.push(commit);
                if commits.len() >= want {
                    git::Flow::Stop
                } else {
                    git::Flow::Continue
                }
            }
            Err(message) => {
                failure = Some(message);
                git::Flow::Stop
            }
        },
    )
    .map_err(|e| format!("커밋 목록을 읽지 못했습니다: {e}"))?;

    match failure {
        Some(message) => Err(message),
        None => Ok(commits),
    }
}

/// 자동 새로고침 폴링용 경량 상태. log를 읽지 않아 대형 저장소에서도 싸다.
/// git 호출은 for-each-ref, rev-parse, status 3회이고 동시에 돌린다.
#[tauri::command]
pub fn get_repo_state(path: String) -> Result<RepoState, String> {
    let outputs = git::run_all(&path, &[&REF_ARGS[..], &HEAD_ARGS[..], &STATUS_ARGS[..]]);
    let [ref_out, head_out, status_out] =
        <[_; 3]>::try_from(outputs).expect("run_all은 넘긴 수만큼 결과를 돌려준다");

    // 저장소 자체가 아니면 for-each-ref가 실패한다. 폴링이 조용히 성공하면 안 된다
    let ref_out = ref_out.map_err(|e| format!("저장소 상태를 읽지 못했습니다: {e}"))?;
    let head_sha = head_out.map(|s| s.trim().to_string()).unwrap_or_default();

    Ok(RepoState {
        graph_token: graph_token(&parse_ref_entries(&ref_out), &head_sha),
        wip: status_out.ok().and_then(|out| parse_status(&out)),
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

/// 커밋 시점의 파일 전문. `git show <sha>:<file>`이다.
///
/// 오류 문자열 두 개는 프론트가 분기에 쓰는 계약이다(CONTRACTS.md v0.12).
/// 바이너리는 `"binary"`, 상한 초과는 `"too large"`를 그대로 돌려준다. 그 밖의 실패는
/// git stderr를 그대로 올려서 "path 'x' does not exist in '<sha>'" 같은 원문이 보이게 한다.
#[tauri::command]
pub fn get_file_content(path: String, sha: String, file: String) -> Result<String, String> {
    let sha = validate_rev(&sha)?;
    let file = validate_pathspec(&file)?;
    let spec = format!("{sha}:{file}");

    // 크기를 먼저 묻는다. cat-file -s는 blob 헤더만 읽어서, 상한을 넘는 파일을 메모리에
    // 올리지 않고 거절할 수 있다. 파일이 그 커밋에 없으면 이 호출이 먼저 실패한다.
    let size = git::run_bytes(&path, &["cat-file", "-s", spec.as_str()])
        .map(|out| String::from_utf8_lossy(&out).trim().to_string())?;
    let size: usize = size
        .parse()
        .map_err(|_| format!("파일 크기를 읽지 못했습니다: {size}"))?;
    if size > MAX_FILE_BYTES {
        return Err("too large".to_string());
    }

    // lossy 변환을 쓰는 git::run으로는 잘못된 바이트가 U+FFFD로 바뀌어 판정이 불가능하다
    decode_text(git::run_bytes(&path, &["show", spec.as_str()])?)
}

/// 워킹 디렉토리의 변경 파일 목록. staged/unstaged/untracked 세 영역으로 나눠 돌려준다.
///
/// git 호출 3회를 병렬로 돈다. 서로 값을 주고받지 않아 순서가 필요 없다.
#[tauri::command]
pub fn get_wip_details(path: String) -> Result<WipDetails, String> {
    const STAGED_ARGS: [&str; 7] = [
        "diff",
        "--cached",
        "--raw",
        "--numstat",
        "--no-ext-diff",
        "-M",
        "-z",
    ];
    const UNSTAGED_ARGS: [&str; 6] = ["diff", "--raw", "--numstat", "--no-ext-diff", "-M", "-z"];
    const UNTRACKED_ARGS: [&str; 4] = ["ls-files", "--others", "--exclude-standard", "-z"];

    let outputs = git::run_all(
        &path,
        &[&STAGED_ARGS[..], &UNSTAGED_ARGS[..], &UNTRACKED_ARGS[..]],
    );
    let [staged_out, unstaged_out, untracked_out] =
        <[_; 3]>::try_from(outputs).expect("run_all은 넘긴 수만큼 결과를 돌려준다");

    let staged = staged_out.map_err(|e| format!("staged 변경을 읽지 못했습니다: {e}"))?;
    let unstaged = unstaged_out.map_err(|e| format!("unstaged 변경을 읽지 못했습니다: {e}"))?;
    let untracked = untracked_out.map_err(|e| format!("untracked 목록을 읽지 못했습니다: {e}"))?;

    Ok(WipDetails {
        staged: parse_file_changes(&staged),
        unstaged: parse_file_changes(&unstaged),
        untracked: untracked_changes(&path, &untracked),
    })
}

/// WIP 파일 하나의 unified diff. `area`는 `WipArea`("staged"/"unstaged"/"untracked").
#[tauri::command]
pub fn get_wip_file_diff(path: String, file: String, area: String) -> Result<String, String> {
    let file = validate_pathspec(&file)?;

    match area.as_str() {
        "staged" => git::run(
            &path,
            &[
                "diff",
                "--cached",
                "--no-color",
                "--no-ext-diff",
                "-M",
                "--",
                file.as_str(),
            ],
        )
        .map_err(|e| format!("staged diff를 읽지 못했습니다: {e}")),
        "unstaged" => git::run(
            &path,
            &[
                "diff",
                "--no-color",
                "--no-ext-diff",
                "-M",
                "--",
                file.as_str(),
            ],
        )
        .map_err(|e| format!("unstaged diff를 읽지 못했습니다: {e}")),
        // 추적되지 않는 파일은 인덱스에 없어 일반 diff로 안 나온다. 빈 파일과 비교해
        // 전체를 추가로 보여준다. 차이가 있으면 종료 코드가 1이라 run_allow_diff를 쓴다.
        "untracked" => git::run_allow_diff(
            &path,
            &[
                "diff",
                "--no-index",
                "--no-color",
                "--no-ext-diff",
                "--",
                "/dev/null",
                file.as_str(),
            ],
        )
        .map_err(|e| format!("untracked diff를 읽지 못했습니다: {e}")),
        other => Err(format!("알 수 없는 WIP 영역입니다: {other}")),
    }
}

/// 워킹 트리의 현재 파일 내용. 커밋이 아니라 디스크를 읽는다.
#[tauri::command]
pub fn get_wip_file_content(path: String, file: String) -> Result<String, String> {
    let target = resolve_in_repo(&path, &file)?;

    // 상한을 넘는 파일을 메모리에 올리지 않으려고 크기를 먼저 본다
    let size = std::fs::metadata(&target)
        .map_err(|e| format!("파일 정보를 읽지 못했습니다: {e}"))?
        .len();
    if size > MAX_FILE_BYTES as u64 {
        return Err("too large".to_string());
    }

    decode_text(std::fs::read(&target).map_err(|e| format!("파일을 읽지 못했습니다: {e}"))?)
}

/// `ls-files -z` 출력을 FileChange 목록으로 바꾼다. 줄 수는 디스크에서 직접 센다.
fn untracked_changes(repo: &str, out: &str) -> Vec<FileChange> {
    out.split('\0')
        .filter(|path| !path.is_empty())
        .map(|path| FileChange {
            additions: count_lines(repo, path),
            deletions: 0,
            status: FileStatus::Added,
            old_path: None,
            path: path.to_string(),
        })
        .collect()
}

/// 워킹 트리 파일의 줄 수. 바이너리, 상한 초과, 읽기 실패는 모두 0이다.
///
/// numstat이 바이너리에 "-"를 주는 것과 같은 취급이다. 프론트는 0을 "± 표시 없음"으로 읽는다.
fn count_lines(repo: &str, file: &str) -> u64 {
    let Ok(target) = resolve_in_repo(repo, file) else {
        return 0;
    };
    let Ok(meta) = std::fs::metadata(&target) else {
        return 0;
    };
    if meta.len() > MAX_FILE_BYTES as u64 {
        return 0;
    }
    let Ok(bytes) = std::fs::read(&target) else {
        return 0;
    };
    match decode_text(bytes) {
        Ok(text) => text.lines().count() as u64,
        Err(_) => 0,
    }
}

/// 레포 루트 안의 경로로만 해석한다.
///
/// 양쪽을 canonicalize해서 비교하기 때문에 `../`뿐 아니라 레포 안에 있는 심링크가 밖을
/// 가리키는 경우도 걸린다. `file`이 절대 경로면 join이 루트를 대체하는데, 그것도 prefix
/// 검사에서 막힌다.
fn resolve_in_repo(repo: &str, file: &str) -> Result<PathBuf, String> {
    let file = file.trim();
    if file.is_empty() {
        return Err("파일 경로가 비어 있습니다".to_string());
    }

    let root = Path::new(repo)
        .canonicalize()
        .map_err(|e| format!("저장소 경로를 확인하지 못했습니다: {e}"))?;
    let target = root
        .join(file)
        .canonicalize()
        .map_err(|_| format!("파일을 찾을 수 없습니다: {file}"))?;

    if !target.starts_with(&root) {
        return Err(format!("저장소 밖의 경로입니다: {file}"));
    }
    Ok(target)
}

/// 바이트열을 텍스트로 판정한다. 오류 문자열은 프론트가 분기에 쓰는 계약이다.
///
/// NUL이 있으면 git이 바이너리로 보는 것과 같은 기준으로 거절하고, NUL이 없어도 UTF-8이
/// 아니면(latin-1 등) 화면에 올릴 수 없어 같이 거절한다.
fn decode_text(bytes: Vec<u8>) -> Result<String, String> {
    if bytes.len() > MAX_FILE_BYTES {
        return Err("too large".to_string());
    }
    if bytes.contains(&0) {
        return Err("binary".to_string());
    }
    String::from_utf8(bytes).map_err(|_| "binary".to_string())
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

/// 파일 경로가 옵션으로 해석되지 않도록 막는다. `<sha>:<file>` 조립 전에 거른다.
fn validate_pathspec(file: &str) -> Result<String, String> {
    let file = file.trim();
    if file.is_empty() {
        return Err("파일 경로가 비어 있습니다".to_string());
    }
    if file.starts_with('-') {
        return Err(format!("파일 경로 형식이 올바르지 않습니다: {file}"));
    }
    Ok(file.to_string())
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
    use crate::testrepo::TempRepo;
    use std::process::Command;

    /// root -> rename -> (feature | main) -> merge 구조의 저장소를 만든다.
    fn fixture() -> TempRepo {
        let repo = TempRepo::init("gitlanes-test");

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

    /// 스트리밍 조기 중단을 눈으로 확인할 만큼 커밋을 쌓은 저장소.
    fn deep_fixture(count: usize) -> TempRepo {
        TempRepo::linear("gitlanes-deep", count)
    }

    #[test]
    fn 스트리밍은_필요한_만큼만_읽고_git을_끊는다() {
        let repo = deep_fixture(60);

        // stream_commits가 want에 닿는 순간 멈추는지: 60개짜리 히스토리에서 3개만 읽는다
        let args: [&str; 9] = [
            "log",
            "--branches",
            "--remotes",
            "--tags",
            "HEAD",
            "--topo-order",
            "-n",
            "61",
            LOG_FORMAT,
        ];
        let few = stream_commits(&repo.path(), &args, 3).unwrap();
        assert_eq!(few.len(), 3, "want를 넘겨 읽지 않는다");
        assert_eq!(few[0].subject, "commit 59", "topo 순서 선두부터다");

        // 조기 중단 뒤에도 같은 저장소를 다시 온전히 읽을 수 있다 (프로세스 정리 확인)
        let all = stream_commits(&repo.path(), &args, 1000).unwrap();
        assert_eq!(all.len(), 60);
        assert_eq!(all[..3], few[..], "앞부분은 같은 결과다");

        // 반복해도 좀비나 핸들이 쌓여 실패하지 않는다
        for _ in 0..30 {
            assert_eq!(stream_commits(&repo.path(), &args, 2).unwrap().len(), 2);
        }
    }

    #[test]
    fn limit이_작으면_load_graph도_그만큼만_읽는다() {
        let repo = deep_fixture(60);
        let page = load_graph(repo.path(), 2, 0).unwrap();

        assert_eq!(page.rows.len(), 2);
        assert_eq!(page.total_loaded, 2);
        assert!(page.has_more);
        assert_eq!(page.rows[0].subject, "commit 59");

        // 전체를 읽으면 60개가 그대로 나온다
        let full = load_graph(repo.path(), 1000, 0).unwrap();
        assert_eq!(full.total_loaded, 60);
        assert!(!full.has_more);
        assert_eq!(
            full.rows[..2].iter().map(|r| &r.sha).collect::<Vec<_>>(),
            page.rows.iter().map(|r| &r.sha).collect::<Vec<_>>()
        );

        // 잘린 끝에서는 링크의 부모가 로드 범위 밖이라 -1이고, 전체 로드에서는 실제 행이다
        assert_eq!(page.rows[1].edges[0].parent_row, -1);
        assert_eq!(full.rows[1].edges[0].parent_row, 2);
    }

    #[test]
    fn search_commits는_상한에_닿으면_거기서_멈춘다() {
        let repo = deep_fixture(60);

        // 60개 전부 매치하지만 5개만 받는다
        let capped = search_commits(repo.path(), "commit".to_string(), 5).unwrap();
        assert_eq!(capped.len(), 5);
        assert_eq!(
            capped.iter().map(|m| m.index).collect::<Vec<_>>(),
            vec![0, 1, 2, 3, 4],
            "index는 topo 순서 그대로다"
        );

        // 상한을 안 걸면 전부 나온다
        let all = search_commits(repo.path(), "commit".to_string(), 0).unwrap();
        assert_eq!(all.len(), 60);
        assert_eq!(all[..5], capped[..]);
    }

    #[test]
    fn get_remote_url은_origin을_웹_주소로_정규화한다() {
        let repo = fixture();
        // remote가 없으면 None
        assert_eq!(get_remote_url(repo.path()), None);

        repo.git(&[
            "remote",
            "add",
            "origin",
            "git@github.com:nobel6018/gitlanes.git",
        ]);
        assert_eq!(
            get_remote_url(repo.path()).as_deref(),
            Some("https://github.com/nobel6018/gitlanes")
        );

        // origin이 없으면 첫 remote를 쓴다
        repo.git(&["remote", "remove", "origin"]);
        repo.git(&[
            "remote",
            "add",
            "upstream",
            "https://gitlab.com/team/app.git",
        ]);
        assert_eq!(
            get_remote_url(repo.path()).as_deref(),
            Some("https://gitlab.com/team/app")
        );

        // 로컬 경로 remote는 열 웹 주소가 없다
        repo.git(&["remote", "remove", "upstream"]);
        repo.git(&["remote", "add", "origin", "/tmp/some/local/repo"]);
        assert_eq!(get_remote_url(repo.path()), None);
    }

    #[test]
    fn get_remote_url은_저장소가_아니면_none이다() {
        assert_eq!(
            get_remote_url("/definitely/not/a/repo/gitlanes".to_string()),
            None
        );
    }

    #[test]
    fn search_commits는_전체_히스토리를_훑고_topo_index를_돌려준다() {
        let repo = fixture();
        let full = load_graph(repo.path(), 100, 0).unwrap();

        // 로드 범위를 1행으로 좁혀도 전체에서 찾는다
        let hits = search_commits(repo.path(), "root".to_string(), 0).unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].index, 4, "루트 커밋은 topo 순서 마지막이다");
        assert_eq!(hits[0].sha, full.rows[4].sha);

        // index+1까지 로드하면 실제로 그 행이 존재한다
        let page = load_graph(repo.path(), hits[0].index + 1, 0).unwrap();
        assert_eq!(page.rows[hits[0].index].sha, hits[0].sha);
    }

    #[test]
    fn search_commits는_대소문자와_한글과_sha_prefix를_모두_다룬다() {
        let repo = fixture();
        let head = repo.rev("HEAD");

        // subject 대소문자 무시 (공백이 낀 구절도 그대로)
        let shouting = search_commits(repo.path(), "MERGE FEATURE".to_string(), 0).unwrap();
        assert_eq!(shouting.len(), 1, "subject가 'Merge feature'다");
        assert_eq!(shouting[0].index, 0);

        let hits = search_commits(repo.path(), "merge".to_string(), 0).unwrap();
        assert_eq!(hits, shouting);

        // author 이름(한글)
        let by_author = search_commits(repo.path(), "테스터".to_string(), 0).unwrap();
        assert_eq!(by_author.len(), 5, "모든 커밋의 author가 테스터다");

        // sha prefix
        let by_sha = search_commits(repo.path(), head[..8].to_uppercase(), 0).unwrap();
        assert_eq!(by_sha.len(), 1);
        assert_eq!(by_sha[0].sha, head);
    }

    #[test]
    fn search_commits는_빈_질의와_무매치를_빈_목록으로_돌려준다() {
        let repo = fixture();
        assert!(search_commits(repo.path(), "   ".to_string(), 0)
            .unwrap()
            .is_empty());
        assert!(search_commits(repo.path(), "없는문구".to_string(), 0)
            .unwrap()
            .is_empty());
    }

    #[test]
    fn search_commits는_limit으로_결과를_줄인다() {
        let repo = fixture();
        let all = search_commits(repo.path(), "테스터".to_string(), 0).unwrap();
        assert_eq!(all.len(), 5);

        let capped = search_commits(repo.path(), "테스터".to_string(), 2).unwrap();
        assert_eq!(capped.len(), 2);
        assert_eq!(capped[0], all[0], "앞에서부터 자른다");
        assert_eq!(capped[1], all[1]);
    }

    #[test]
    fn get_repo_state는_load_graph와_같은_지문과_wip을_돌려준다() {
        let repo = fixture();
        let graph = load_graph(repo.path(), 100, 0).unwrap();
        let state = get_repo_state(repo.path()).unwrap();

        assert_eq!(state.graph_token, graph.graph_token);
        assert_eq!(state.wip, graph.wip);
        assert_eq!(state.wip, None, "깨끗한 저장소다");

        // 작업 트리가 더러워지면 wip만 바뀐다
        repo.write("m.txt", "m\ndirty\n");
        let dirty = get_repo_state(repo.path()).unwrap();
        assert_eq!(dirty.graph_token, state.graph_token, "refs는 그대로다");
        assert_eq!(dirty.wip.unwrap().changed_files, 1);

        // 브랜치가 생기면 지문이 바뀐다
        repo.git(&["branch", "polling"]);
        let branched = get_repo_state(repo.path()).unwrap();
        assert_ne!(branched.graph_token, state.graph_token);
    }

    #[test]
    fn get_repo_state는_저장소가_아니면_오류다() {
        let err = get_repo_state("/definitely/not/a/repo/gitlanes".to_string()).unwrap_err();
        assert!(err.contains("저장소 상태를 읽지 못했습니다"), "{err}");
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
        assert!(head.contains("edges=[0>0:0[0,2], 0>1:1[0,1]]"), "{head}");
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

    #[test]
    fn 커밋_시점의_파일_전문을_그대로_돌려준다() {
        let repo = fixture();
        // a.txt는 root 커밋에만 있고, 다음 커밋에서 b.txt로 rename + 세 번째 줄이 바뀐다
        let root = repo.rev("HEAD~3");
        let content = get_file_content(repo.path(), root, "a.txt".to_string()).unwrap();
        assert_eq!(content, "a\nb\nc\n");

        let head = repo.rev("HEAD");
        let renamed = get_file_content(repo.path(), head, "b.txt".to_string()).unwrap();
        assert_eq!(renamed, "a\nb\nd\n");
    }

    #[test]
    fn 공백과_한글이_섞인_경로도_전문을_읽는다() {
        let repo = fixture();
        let sha = repo.rev("HEAD~3");
        let content = get_file_content(repo.path(), sha, "docs/설계 문서.md".to_string()).unwrap();
        assert_eq!(content, "제목\n");
    }

    #[test]
    fn nul이_섞인_파일은_binary다() {
        let repo = TempRepo::init("gitlanes-binary");
        repo.write_bytes("blob.dat", b"PNG\x00\x01\x02text");
        repo.git(&["add", "-A"]);
        repo.git(&["commit", "-qm", "binary"]);

        let sha = repo.rev("HEAD");
        let error = get_file_content(repo.path(), sha, "blob.dat".to_string()).unwrap_err();
        assert_eq!(error, "binary");
    }

    #[test]
    fn utf8이_아닌_파일도_binary다() {
        let repo = TempRepo::init("gitlanes-latin1");
        // NUL은 없지만 UTF-8로 해석할 수 없는 바이트열(latin-1 "é")
        repo.write_bytes("latin1.txt", b"caf\xe9\n");
        repo.git(&["add", "-A"]);
        repo.git(&["commit", "-qm", "latin1"]);

        let sha = repo.rev("HEAD");
        let error = get_file_content(repo.path(), sha, "latin1.txt".to_string()).unwrap_err();
        assert_eq!(error, "binary");
    }

    #[test]
    fn 상한을_넘는_파일은_too_large다() {
        let repo = TempRepo::init("gitlanes-huge");
        repo.write_bytes("huge.txt", &vec![b'a'; MAX_FILE_BYTES + 1]);
        repo.write("small.txt", "ok\n");
        repo.git(&["add", "-A"]);
        repo.git(&["commit", "-qm", "huge"]);

        let sha = repo.rev("HEAD");
        let error = get_file_content(repo.path(), sha.clone(), "huge.txt".to_string()).unwrap_err();
        assert_eq!(error, "too large");
        // 같은 커밋의 작은 파일은 정상이다
        assert_eq!(
            get_file_content(repo.path(), sha, "small.txt".to_string()).unwrap(),
            "ok\n"
        );
    }

    #[test]
    fn 그_커밋에_없는_파일은_git_오류를_올린다() {
        let repo = fixture();
        let sha = repo.rev("HEAD");
        let error = get_file_content(repo.path(), sha, "없는파일.txt".to_string()).unwrap_err();
        assert!(error.contains("없는파일.txt"), "{error}");
        assert_ne!(error, "binary");
        assert_ne!(error, "too large");
    }

    /// base 커밋 위에 staged(rename + modify), unstaged, untracked를 한 번에 만든다.
    fn wip_fixture() -> TempRepo {
        let repo = TempRepo::init("gitlanes-wip");
        repo.write("keep.txt", "1\n2\n3\n");
        repo.write("old.txt", "old\n");
        repo.write("mod.txt", "m\n");
        repo.git(&["add", "-A"]);
        repo.git(&["commit", "-qm", "base"]);

        // staged: 내용을 그대로 둔 순수 rename(유사도 100%)과 별도 파일 수정
        repo.git(&["mv", "old.txt", "new.txt"]);
        repo.write("mod.txt", "m\nstaged\n");
        repo.git(&["add", "-A"]);

        // unstaged: 추적 파일을 고치고 인덱스에는 올리지 않는다
        repo.write("keep.txt", "1\n2\n3\n4\n");

        // untracked
        repo.write("fresh.txt", "a\nb\n");
        repo
    }

    #[test]
    fn wip을_staged_unstaged_untracked로_나눈다() {
        let repo = wip_fixture();
        let wip = get_wip_details(repo.path()).unwrap();

        let staged: Vec<&str> = wip.staged.iter().map(|f| f.path.as_str()).collect();
        assert_eq!(staged, ["mod.txt", "new.txt"], "{:?}", wip.staged);

        let renamed = wip.staged.iter().find(|f| f.path == "new.txt").unwrap();
        assert_eq!(renamed.status, FileStatus::Renamed);
        assert_eq!(renamed.old_path.as_deref(), Some("old.txt"));

        let modified = wip.staged.iter().find(|f| f.path == "mod.txt").unwrap();
        assert_eq!(modified.status, FileStatus::Modified);
        assert_eq!((modified.additions, modified.deletions), (1, 0));

        assert_eq!(wip.unstaged.len(), 1, "{:?}", wip.unstaged);
        assert_eq!(wip.unstaged[0].path, "keep.txt");
        assert_eq!(wip.unstaged[0].status, FileStatus::Modified);
        assert_eq!(
            (wip.unstaged[0].additions, wip.unstaged[0].deletions),
            (1, 0)
        );
    }

    #[test]
    fn untracked는_status_a와_줄_수를_채운다() {
        let repo = wip_fixture();
        let wip = get_wip_details(repo.path()).unwrap();

        assert_eq!(wip.untracked.len(), 1, "{:?}", wip.untracked);
        let fresh = &wip.untracked[0];
        assert_eq!(fresh.path, "fresh.txt");
        assert_eq!(fresh.status, FileStatus::Added);
        assert_eq!(fresh.additions, 2);
        assert_eq!(fresh.deletions, 0);
        assert_eq!(fresh.old_path, None);
    }

    #[test]
    fn 바이너리_untracked는_줄_수를_0으로_둔다() {
        let repo = TempRepo::init("gitlanes-wip-binary");
        repo.write("seed.txt", "seed\n");
        repo.git(&["add", "-A"]);
        repo.git(&["commit", "-qm", "base"]);
        repo.write_bytes("blob.dat", b"PNG\x00\x01text\n");

        let wip = get_wip_details(repo.path()).unwrap();
        assert_eq!(wip.untracked.len(), 1);
        assert_eq!(wip.untracked[0].path, "blob.dat");
        assert_eq!(wip.untracked[0].additions, 0);

        let error = get_wip_file_content(repo.path(), "blob.dat".to_string()).unwrap_err();
        assert_eq!(error, "binary");
    }

    #[test]
    fn wip_diff는_area마다_다른_명령을_쓴다() {
        let repo = wip_fixture();

        let staged =
            get_wip_file_diff(repo.path(), "mod.txt".to_string(), "staged".to_string()).unwrap();
        assert!(staged.contains("+staged"), "{staged}");

        // 같은 파일이라도 unstaged 영역에는 변경이 없다
        let unstaged_of_staged =
            get_wip_file_diff(repo.path(), "mod.txt".to_string(), "unstaged".to_string()).unwrap();
        assert!(unstaged_of_staged.is_empty(), "{unstaged_of_staged}");

        let unstaged =
            get_wip_file_diff(repo.path(), "keep.txt".to_string(), "unstaged".to_string()).unwrap();
        assert!(unstaged.contains("+4"), "{unstaged}");
        assert!(unstaged.contains("keep.txt"), "{unstaged}");
    }

    #[test]
    fn untracked_diff는_종료_코드_1을_오류로_보지_않는다() {
        let repo = wip_fixture();
        // --no-index는 차이가 있으면 1로 끝난다. 그걸 오류로 처리하면 여기서 Err가 된다.
        let diff = get_wip_file_diff(
            repo.path(),
            "fresh.txt".to_string(),
            "untracked".to_string(),
        )
        .unwrap();
        assert!(diff.contains("fresh.txt"), "{diff}");
        assert!(diff.contains("+a"), "{diff}");
        assert!(diff.contains("+b"), "{diff}");
    }

    #[test]
    fn 알_수_없는_area는_거부한다() {
        let repo = wip_fixture();
        assert!(get_wip_file_diff(repo.path(), "keep.txt".to_string(), "".to_string()).is_err());
        assert!(
            get_wip_file_diff(repo.path(), "keep.txt".to_string(), "cached".to_string()).is_err()
        );
    }

    #[test]
    fn wip_전문은_워킹_트리의_현재_내용이다() {
        let repo = wip_fixture();
        // HEAD의 keep.txt는 세 줄, 워킹 트리는 네 줄이다
        let content = get_wip_file_content(repo.path(), "keep.txt".to_string()).unwrap();
        assert_eq!(content, "1\n2\n3\n4\n");
    }

    #[test]
    fn 상한을_넘는_워킹_트리_파일은_too_large다() {
        let repo = wip_fixture();
        repo.write_bytes("huge.txt", &vec![b'a'; MAX_FILE_BYTES + 1]);
        let error = get_wip_file_content(repo.path(), "huge.txt".to_string()).unwrap_err();
        assert_eq!(error, "too large");
    }

    #[test]
    fn 레포_밖의_경로는_거부한다() {
        let repo = wip_fixture();
        let outside = std::env::temp_dir().join("gitlanes-outside.txt");
        std::fs::write(&outside, "secret\n").unwrap();

        for candidate in [
            "../gitlanes-outside.txt",
            "keep.txt/../../gitlanes-outside.txt",
            outside.to_string_lossy().as_ref(),
        ] {
            let error = get_wip_file_content(repo.path(), candidate.to_string()).unwrap_err();
            // Linux는 파일 뒤의 `..`(keep.txt/..)를 ENOTDIR로 먼저 실패시키고 macOS realpath는
            // 통과시켜 prefix 검사에서 걸린다. 둘 다 안전한 거부이므로 어느 메시지든 허용한다
            assert!(
                error.contains("저장소 밖의 경로") || error.contains("찾을 수 없습니다"),
                "{candidate}: {error}"
            );
        }

        let _ = std::fs::remove_file(&outside);
    }

    #[cfg(unix)]
    #[test]
    fn 밖을_가리키는_심링크도_거부한다() {
        let repo = wip_fixture();
        let outside = std::env::temp_dir().join("gitlanes-symlink-target.txt");
        std::fs::write(&outside, "secret\n").unwrap();
        std::os::unix::fs::symlink(&outside, format!("{}/escape.txt", repo.path())).unwrap();

        let error = get_wip_file_content(repo.path(), "escape.txt".to_string()).unwrap_err();
        assert!(error.contains("저장소 밖의 경로"), "{error}");

        // 목록에는 올라오지만 줄 수는 셀 수 없어 0이다
        let wip = get_wip_details(repo.path()).unwrap();
        let link = wip.untracked.iter().find(|f| f.path == "escape.txt");
        assert_eq!(link.map(|f| f.additions), Some(0));

        let _ = std::fs::remove_file(&outside);
    }

    #[test]
    fn 옵션처럼_생긴_인자는_전문을_읽기_전에_거부한다() {
        let repo = fixture();
        let sha = repo.rev("HEAD");
        assert!(get_file_content(repo.path(), sha.clone(), "  ".to_string()).is_err());
        assert!(get_file_content(repo.path(), sha, "-x".to_string()).is_err());
        assert!(get_file_content(
            repo.path(),
            "--upload-pack=evil".to_string(),
            "a.txt".to_string()
        )
        .is_err());
    }
}
