//! 파일 히스토리, blame, 브랜치/커밋 비교 (v0.18). 전부 읽기 전용이다.
//!
//! 경로 인자는 [`git`] 실행기가 리터럴 pathspec으로 다룬다(`GIT_LITERAL_PATHSPECS=1`).
//! 여기서 따로 이스케이프하지 않는다.
//!
//! @see CONTRACTS.md (v0.18.0)

use std::collections::HashMap;

use crate::commands::{
    decode_text, push_file_pathspecs, resolve_in_repo, validate_pathspec, validate_rev,
    DIFF_PREFIX_ARGS, MAX_FILE_BYTES, SUBMODULE_SHORT_ARG,
};
use crate::git;
use crate::model::{
    short_sha, BlameHunk, BlameResult, CommitSummary, CompareResult, FileHistoryEntry, FileStatus,
};
use crate::parse::parse_file_changes;

/// 파일 히스토리 한 커밋의 머리. 레코드 앞에 `\x1e`를 둬서 뒤따르는 name-status와 한 덩어리로 자른다.
const HISTORY_FORMAT: &str = "--format=%x1e%H%x1f%an%x1f%ae%x1f%at%x1f%s";

/// 비교 화면 커밋 목록. 레코드 끝에 `\x1e`를 둔다.
pub(crate) const SUMMARY_FORMAT: &str = "--format=%H%x1f%an%x1f%at%x1f%s%x1e";

/// blame 출력을 사용자 설정에서 떼어 낸다(v0.15.1 원칙: 파싱하는 출력은 설정에 기대지 않는다).
///
/// - `--no-ignore-revs-file`: `blame.ignoreRevsFile`이 있으면 그 커밋의 줄이 다른 커밋으로
///   넘어간다. `-c blame.ignoreRevsFile=`로는 비워지지 않고(실측), 설정된 파일이 없으면 blame
///   자체가 실패한다. 이 옵션은 두 경우를 모두 막는다
/// - `--no-textconv`: textconv가 걸리면 blame 줄이 디스크 내용과 달라져 `lines`와 어긋난다
const BLAME_ARGS: [&str; 4] = [
    "blame",
    "--porcelain",
    "--no-ignore-revs-file",
    "--no-textconv",
];

/// 무시 목록이 비어 있으면 의미가 없지만, 혹시 남더라도 출력에 표식이 섞이지 않게 둔다.
const BLAME_CONFIG_ARGS: [&str; 4] = [
    "-c",
    "blame.markIgnoredLines=false",
    "-c",
    "blame.markUnblamableLines=false",
];

/// 커밋되지 않은 줄의 요약. git이 주는 "Version of a.txt from a.txt"는 사용자에게 뜻이 없다.
const UNCOMMITTED_SUMMARY: &str = "Uncommitted changes";

/// 파일 하나를 바꾼 커밋 목록. rename을 따라가며 최신이 먼저다.
#[tauri::command(async)]
pub fn get_file_history(
    path: String,
    file: String,
    rev: Option<String>,
    limit: usize,
) -> Result<Vec<FileHistoryEntry>, String> {
    let file = validate_pathspec(&file)?;
    let rev = match rev.as_deref() {
        Some(rev) => validate_rev(rev)?,
        None => "HEAD".to_string(),
    };
    if limit == 0 {
        return Ok(Vec::new());
    }

    let max_count = format!("--max-count={limit}");
    let args = [
        "log",
        "--follow",
        "--name-status",
        "-M",
        "-z",
        "--no-color",
        // log.showSignature가 켜져 있으면 gpg 출력이 레코드 사이에 섞인다
        "--no-show-signature",
        HISTORY_FORMAT,
        max_count.as_str(),
        rev.as_str(),
        "--",
        file.as_str(),
    ];
    let out =
        git::run(&path, &args).map_err(|e| format!("Could not read the file history: {e}"))?;
    Ok(parse_file_history(&out, &file))
}

/// blame. `rev`가 None이면 워킹트리 기준이라 커밋 안 된 줄은 `uncommitted`다.
///
/// 오류 문자열 `"binary"`, `"too large"`는 `get_file_content`와 같은 계약이다.
#[tauri::command(async)]
pub fn get_blame(path: String, file: String, rev: Option<String>) -> Result<BlameResult, String> {
    let file = validate_pathspec(&file)?;
    let rev = rev.as_deref().map(validate_rev).transpose()?;

    let content = match rev.as_deref() {
        Some(rev) => committed_text(&path, rev, &file)?,
        None => working_text(&path, &file)?,
    };
    let lines: Vec<String> = content.lines().map(str::to_string).collect();
    if lines.is_empty() {
        return Ok(BlameResult {
            lines,
            hunks: Vec::new(),
        });
    }

    let mut args: Vec<&str> = BLAME_CONFIG_ARGS.to_vec();
    args.extend(BLAME_ARGS);
    if let Some(rev) = rev.as_deref() {
        args.push(rev);
    }
    args.extend(["--", file.as_str()]);

    let out = match git::run(&path, &args) {
        Ok(out) => out,
        // 워킹트리 blame은 HEAD에 없는 파일(새로 만든 파일, 커밋이 없는 저장소)을 거절한다.
        // 그 파일은 줄 전체가 아직 커밋되지 않은 것이라 한 구간으로 돌려준다.
        Err(_) if rev.is_none() && !exists_in_head(&path, &file) => {
            return Ok(BlameResult {
                hunks: vec![uncommitted_hunk(1, lines.len() as u32)],
                lines,
            });
        }
        Err(e) => return Err(format!("Could not read the blame: {e}")),
    };
    Ok(BlameResult {
        hunks: parse_blame_porcelain(&out),
        lines,
    })
}

/// 두 ref 비교. 커밋 목록은 양쪽에만 있는 것, 파일 목록은 공통 조상 기준 세 점 diff다.
///
/// 관계없는 히스토리면 공통 조상이 없어 세 점 diff가 성립하지 않는다(git이 "no merge base"로
/// 거절한다). 그때는 두 트리를 바로 비교한 결과를 돌려준다. 빈 목록보다 쓸모가 있다.
#[tauri::command(async)]
pub fn compare_refs(
    path: String,
    base: String,
    head: String,
    limit: usize,
) -> Result<CompareResult, String> {
    let base_rev = validate_rev(&base)?;
    let head_rev = validate_rev(&head)?;
    let merge_base = merge_base(&path, &base_rev, &head_rev)?;

    // 잘렸는지 알려면 limit보다 하나 더 읽는다
    let max_count = format!("--max-count={}", limit.saturating_add(1));
    let head_only = format!("{base_rev}..{head_rev}");
    let base_only = format!("{head_rev}..{base_rev}");
    let log_args = |range: &str| -> Vec<String> {
        [
            "log",
            "--no-color",
            "--no-show-signature",
            SUMMARY_FORMAT,
            max_count.as_str(),
            range,
            // 범위가 경로로 해석되지 않게 막는다
            "--",
        ]
        .map(str::to_string)
        .to_vec()
    };
    let mut diff_args: Vec<String> = ["diff", "--raw", "--numstat", "--no-ext-diff", "-M", "-z"]
        .map(str::to_string)
        .to_vec();
    diff_args.extend(diff_range(&base_rev, &head_rev, merge_base.as_deref()));
    diff_args.push("--".to_string());

    let head_log = log_args(&head_only);
    let base_log = log_args(&base_only);
    let outputs = git::run_all(&path, &[&head_log[..], &base_log[..], &diff_args[..]]);
    let [head_out, base_out, diff_out] =
        <[_; 3]>::try_from(outputs).expect("run_all은 넘긴 수만큼 결과를 돌려준다");

    let mut only_in_head = parse_summaries(
        &head_out.map_err(|e| format!("Could not list the commits to compare: {e}"))?,
    );
    let mut only_in_base = parse_summaries(
        &base_out.map_err(|e| format!("Could not list the commits to compare: {e}"))?,
    );
    let files = parse_file_changes(
        &diff_out.map_err(|e| format!("Could not read the changed files: {e}"))?,
    );

    let only_in_head_truncated = only_in_head.len() > limit;
    let only_in_base_truncated = only_in_base.len() > limit;
    only_in_head.truncate(limit);
    only_in_base.truncate(limit);

    Ok(CompareResult {
        base,
        head,
        merge_base,
        only_in_head,
        only_in_base,
        only_in_head_truncated,
        only_in_base_truncated,
        files,
    })
}

/// 비교 화면에서 파일 하나의 diff. 범위는 [`compare_refs`]의 파일 목록과 같다.
#[tauri::command(async)]
pub fn get_compare_file_diff(
    path: String,
    base: String,
    head: String,
    file: String,
    old_file: Option<String>,
) -> Result<String, String> {
    let base = validate_rev(&base)?;
    let head = validate_rev(&head)?;
    let file = validate_pathspec(&file)?;
    let merge_base = merge_base(&path, &base, &head)?;
    let range = diff_range(&base, &head, merge_base.as_deref());

    let mut args: Vec<&str> = vec!["diff", "--no-color", "--no-ext-diff", "-M"];
    args.extend(range.iter().map(String::as_str));
    args.extend(DIFF_PREFIX_ARGS);
    args.push(SUBMODULE_SHORT_ARG);
    push_file_pathspecs(&mut args, &file, old_file.as_deref());

    git::run(&path, &args).map_err(|e| format!("Could not read the diff: {e}"))
}

/// 공통 조상. 관계없는 히스토리면 None.
///
/// `merge-base`는 공통 조상이 없으면 출력 없이 종료 코드 1로 끝난다. 잘못된 ref는 128이라
/// 1까지 성공으로 보는 실행기를 쓰고 출력이 비었는지로 가른다.
pub(crate) fn merge_base(path: &str, base: &str, head: &str) -> Result<Option<String>, String> {
    let out = git::run_bytes_allow_diff(path, &["merge-base", base, head])
        .map_err(|e| format!("Could not compare: {e}"))?;
    let sha = String::from_utf8_lossy(&out).trim().to_string();
    Ok(Some(sha).filter(|sha| !sha.is_empty()))
}

/// diff 범위 인자. 공통 조상이 있으면 `<조상> <head>`로 `base...head`와 같은 diff를 만든다.
///
/// `base...head`를 그대로 넘기지 않는 이유: 공통 조상이 여럿(criss-cross)이면 git이 그중 하나를
/// 다시 고른다. 화면에 보이는 mergeBase와 파일 목록, 파일 diff가 같은 조상을 쓰게 못 박는다.
pub(crate) fn diff_range(base: &str, head: &str, merge_base: Option<&str>) -> Vec<String> {
    match merge_base {
        Some(ancestor) => vec![ancestor.to_string(), head.to_string()],
        None => vec![base.to_string(), head.to_string()],
    }
}

/// 커밋 시점 파일 내용. 크기를 먼저 물어 상한을 넘는 blob은 읽지 않는다.
fn committed_text(path: &str, rev: &str, file: &str) -> Result<String, String> {
    let spec = format!("{rev}:{file}");
    let size = git::run(path, &["cat-file", "-s", spec.as_str()])?;
    let size: usize = size
        .trim()
        .parse()
        .map_err(|_| format!("Could not read the file size: {}", size.trim()))?;
    if size > MAX_FILE_BYTES {
        return Err("too large".to_string());
    }
    decode_text(git::run_bytes(path, &["show", spec.as_str()])?)
}

/// 워킹트리 파일 내용. 레포 밖을 가리키는 경로는 [`resolve_in_repo`]가 막는다.
fn working_text(path: &str, file: &str) -> Result<String, String> {
    let target = resolve_in_repo(path, file)?;
    let size = std::fs::metadata(&target)
        .map_err(|e| format!("Could not read file info: {e}"))?
        .len();
    if size > MAX_FILE_BYTES as u64 {
        return Err("too large".to_string());
    }
    decode_text(std::fs::read(&target).map_err(|e| format!("Could not read the file: {e}"))?)
}

fn exists_in_head(path: &str, file: &str) -> bool {
    git::run(path, &["cat-file", "-e", &format!("HEAD:{file}")]).is_ok()
}

fn uncommitted_hunk(start_line: u32, line_count: u32) -> BlameHunk {
    let timestamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or_default();
    let sha = "0".repeat(40);
    BlameHunk {
        short_sha: short_sha(&sha),
        sha,
        author: "Not Committed Yet".to_string(),
        author_email: "not.committed.yet".to_string(),
        timestamp,
        summary: UNCOMMITTED_SUMMARY.to_string(),
        start_line,
        line_count,
        uncommitted: true,
    }
}

/// `log --follow --name-status -z`와 [`HISTORY_FORMAT`] 출력을 항목으로 바꾼다.
///
/// 레코드 하나는 `<머리>\0\n<상태>\0<경로>\0[<새 경로>\0]` 꼴이다. rename이면 경로가 둘이다.
/// 머지 커밋처럼 name-status가 없는 레코드는 바로 앞(더 최신) 항목이 가리키던 경로를 쓴다.
fn parse_file_history(out: &str, file: &str) -> Vec<FileHistoryEntry> {
    let mut entries = Vec::new();
    // 최신부터 내려가므로 "이 커밋 이후의 경로"는 앞 항목의 원 경로다
    let mut current_path = file.to_string();

    for record in out.split('\x1e').filter(|record| !record.is_empty()) {
        let (head, changes) = record.split_once('\0').unwrap_or((record, ""));
        let fields: Vec<&str> = head.splitn(5, '\x1f').collect();
        let [sha, author, email, timestamp, subject] = fields[..] else {
            continue;
        };

        let tokens: Vec<&str> = changes
            .trim_start_matches('\n')
            .split('\0')
            .filter(|token| !token.is_empty())
            .collect();
        let (status, old_path, path) = match tokens[..] {
            [letter, old, new, ..] if letter.starts_with(['R', 'C']) => (
                FileStatus::from_letter(letter.chars().next().unwrap_or('M')),
                Some(old.to_string()),
                new.to_string(),
            ),
            [letter, path, ..] => (
                FileStatus::from_letter(letter.chars().next().unwrap_or('M')),
                None,
                path.to_string(),
            ),
            _ => (FileStatus::Modified, None, current_path.clone()),
        };

        current_path = old_path.clone().unwrap_or_else(|| path.clone());
        entries.push(FileHistoryEntry {
            commit: CommitSummary {
                sha: sha.to_string(),
                short_sha: short_sha(sha),
                subject: subject.to_string(),
                author: author.to_string(),
                timestamp: timestamp.trim().parse().unwrap_or_default(),
            },
            author_email: email.to_string(),
            path,
            old_path,
            status,
        });
    }
    entries
}

/// [`SUMMARY_FORMAT`] 출력을 커밋 요약으로 바꾼다.
pub(crate) fn parse_summaries(out: &str) -> Vec<CommitSummary> {
    out.split('\x1e')
        .map(|record| record.trim_start_matches('\n'))
        .filter_map(|record| {
            let fields: Vec<&str> = record.splitn(4, '\x1f').collect();
            let [sha, author, timestamp, subject] = fields[..] else {
                return None;
            };
            Some(CommitSummary {
                sha: sha.to_string(),
                short_sha: short_sha(sha),
                subject: subject.to_string(),
                author: author.to_string(),
                timestamp: timestamp.trim().parse().unwrap_or_default(),
            })
        })
        .collect()
}

#[derive(Default)]
struct BlameCommit {
    author: String,
    author_email: String,
    timestamp: i64,
    summary: String,
}

/// `blame --porcelain` 출력을 구간으로 묶는다.
///
/// 줄마다 `<sha> <원래 줄> <결과 줄> [<그룹 줄 수>]` 머리가 오고, 그 커밋이 처음 나올 때만
/// `author` 같은 키 줄이 이어진 뒤 탭으로 시작하는 내용 줄이 온다. 결과 줄 번호로 자리를
/// 잡아서 묶으므로 출력 순서에 기대지 않는다.
fn parse_blame_porcelain(out: &str) -> Vec<BlameHunk> {
    let mut commits: HashMap<String, BlameCommit> = HashMap::new();
    let mut line_shas: Vec<Option<String>> = Vec::new();
    let mut current: Option<(String, usize)> = None;
    let mut expect_header = true;

    for line in out.split('\n') {
        if line.starts_with('\t') {
            if let Some((sha, final_line)) = current.as_ref() {
                if line_shas.len() < *final_line {
                    line_shas.resize(*final_line, None);
                }
                line_shas[final_line - 1] = Some(sha.clone());
            }
            expect_header = true;
            continue;
        }
        if expect_header {
            let mut tokens = line.split(' ');
            let (Some(sha), Some(_), Some(final_line)) =
                (tokens.next(), tokens.next(), tokens.next())
            else {
                continue;
            };
            let Ok(final_line) = final_line.parse::<usize>() else {
                continue;
            };
            if final_line == 0 {
                continue;
            }
            commits.entry(sha.to_string()).or_default();
            current = Some((sha.to_string(), final_line));
            expect_header = false;
            continue;
        }
        let Some((sha, _)) = current.as_ref() else {
            continue;
        };
        let commit = commits.entry(sha.clone()).or_default();
        let (key, value) = line.split_once(' ').unwrap_or((line, ""));
        match key {
            "author" => commit.author = value.to_string(),
            "author-mail" => {
                commit.author_email = value
                    .trim_start_matches('<')
                    .trim_end_matches('>')
                    .to_string()
            }
            "author-time" => commit.timestamp = value.trim().parse().unwrap_or_default(),
            "summary" => commit.summary = value.to_string(),
            _ => {}
        }
    }

    let mut hunks: Vec<BlameHunk> = Vec::new();
    for (index, sha) in line_shas.iter().enumerate() {
        let Some(sha) = sha else { continue };
        let line_number = index as u32 + 1;
        if let Some(last) = hunks.last_mut() {
            if last.sha == *sha && last.start_line + last.line_count == line_number {
                last.line_count += 1;
                continue;
            }
        }
        let commit = commits.get(sha);
        let uncommitted = sha.bytes().all(|b| b == b'0');
        hunks.push(BlameHunk {
            sha: sha.clone(),
            short_sha: short_sha(sha),
            author: commit.map(|c| c.author.clone()).unwrap_or_default(),
            author_email: commit.map(|c| c.author_email.clone()).unwrap_or_default(),
            timestamp: commit.map(|c| c.timestamp).unwrap_or_default(),
            summary: if uncommitted {
                UNCOMMITTED_SUMMARY.to_string()
            } else {
                commit.map(|c| c.summary.clone()).unwrap_or_default()
            },
            start_line: line_number,
            line_count: 1,
            uncommitted,
        });
    }
    hunks
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testrepo::TempRepo;

    fn subjects(entries: &[FileHistoryEntry]) -> Vec<&str> {
        entries.iter().map(|e| e.commit.subject.as_str()).collect()
    }

    /// a.txt를 두 번 고치고 b.txt로 옮긴 뒤 한 번 더 고친다.
    fn renamed_fixture() -> TempRepo {
        let repo = TempRepo::init("gitlanes-history");
        repo.write("a.txt", "1\n2\n3\n");
        repo.write("other.txt", "x\n");
        repo.git(&["add", "-A"]);
        repo.git(&["commit", "-qm", "one"]);
        repo.write("a.txt", "1\n2\n3\n4\n");
        repo.git(&["commit", "-qam", "two"]);
        repo.write("other.txt", "y\n");
        repo.git(&["commit", "-qam", "unrelated"]);
        repo.git(&["mv", "a.txt", "b.txt"]);
        repo.git(&["commit", "-qm", "move"]);
        repo.write("b.txt", "1\n2\n3\n4\n5\n");
        repo.git(&["commit", "-qam", "four"]);
        repo
    }

    #[test]
    fn 파일_히스토리는_rename_전_커밋까지_최신순으로_따라간다() {
        let repo = renamed_fixture();
        let entries = get_file_history(repo.path(), "b.txt".into(), None, 50).unwrap();

        assert_eq!(subjects(&entries), ["four", "move", "two", "one"]);
        let moved = &entries[1];
        assert_eq!(moved.status, FileStatus::Renamed);
        assert_eq!(moved.old_path.as_deref(), Some("a.txt"));
        assert_eq!(moved.path, "b.txt");
        assert_eq!(entries[2].path, "a.txt");
        assert_eq!(entries[2].status, FileStatus::Modified);
        assert_eq!(entries[3].status, FileStatus::Added);
        assert_eq!(entries[0].commit.sha, repo.rev("HEAD"));
        assert_eq!(entries[0].commit.author, "테스터");
        assert_eq!(entries[0].author_email, "tester@example.com");
    }

    #[test]
    fn 파일_히스토리는_limit만큼_자른다() {
        let repo = renamed_fixture();
        let entries = get_file_history(repo.path(), "b.txt".into(), None, 2).unwrap();
        assert_eq!(subjects(&entries), ["four", "move"]);
        assert!(get_file_history(repo.path(), "b.txt".into(), None, 0)
            .unwrap()
            .is_empty());
    }

    #[test]
    fn 파일_히스토리는_rev부터_읽는다() {
        let repo = renamed_fixture();
        let entries =
            get_file_history(repo.path(), "a.txt".into(), Some("HEAD~3".into()), 50).unwrap();
        assert_eq!(subjects(&entries), ["two", "one"]);
    }

    #[test]
    fn 파일_히스토리는_옵션처럼_생긴_인자를_거부한다() {
        let repo = renamed_fixture();
        assert!(get_file_history(repo.path(), "--all".into(), None, 5).is_err());
        assert!(get_file_history(repo.path(), "b.txt".into(), Some("-p".into()), 5).is_err());
    }

    #[test]
    fn 히스토리_항목은_커밋_요약_키를_펼쳐서_보낸다() {
        let repo = renamed_fixture();
        let entries = get_file_history(repo.path(), "b.txt".into(), None, 2).unwrap();
        let json = serde_json::to_value(&entries[1]).unwrap();
        for key in [
            "sha",
            "shortSha",
            "subject",
            "author",
            "timestamp",
            "authorEmail",
            "path",
            "oldPath",
            "status",
        ] {
            assert!(json.get(key).is_some(), "{key} 키가 없다: {json}");
        }
        assert!(json.get("commit").is_none(), "중첩 객체로 보내지 않는다");
        assert_eq!(json["status"], "R");
    }

    #[test]
    fn 머리만_있는_히스토리_레코드는_앞_항목의_원_경로를_쓴다() {
        let out = "\x1eaaa\x1fA\x1fa@x\x1f1\x1fmove\0\nR100\0old.txt\0new.txt\0\
                   \x1ebbb\x1fA\x1fa@x\x1f1\x1fmerge\0";
        let entries = parse_file_history(out, "new.txt");
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[1].path, "old.txt");
        assert_eq!(entries[1].status, FileStatus::Modified);
    }

    /// one: a,b,c / two: 2번 줄을 B로 바꾸고 d를 붙인다.
    ///
    /// 글자를 쓰는 이유: ignore-revs는 무시한 커밋의 줄을 비슷한 옛 줄에 넘기는데, `2`와 `B`처럼
    /// 닮지 않은 줄은 넘기지 않는다(실측). 그러면 설정이 새어 들어와도 결과가 같아 검증이 안 된다.
    fn blame_fixture() -> (TempRepo, String, String) {
        let repo = TempRepo::init("gitlanes-blame");
        repo.write("a.txt", "a\nb\nc\n");
        repo.git(&["add", "-A"]);
        repo.git(&["commit", "-qm", "one"]);
        let one = repo.rev("HEAD");
        repo.write("a.txt", "a\nB\nc\nd\n");
        repo.git(&["commit", "-qam", "two"]);
        let two = repo.rev("HEAD");
        (repo, one, two)
    }

    fn spans(result: &BlameResult) -> Vec<(String, u32, u32, bool)> {
        hunk_spans(&result.hunks)
    }

    fn hunk_spans(hunks: &[BlameHunk]) -> Vec<(String, u32, u32, bool)> {
        hunks
            .iter()
            .map(|h| (h.sha.clone(), h.start_line, h.line_count, h.uncommitted))
            .collect()
    }

    #[test]
    fn blame은_같은_커밋의_연속_줄을_구간으로_묶는다() {
        let (repo, one, two) = blame_fixture();
        repo.write("a.txt", "a\nB\nc\nd\ne\nf\n");
        repo.git(&["commit", "-qam", "three"]);
        let three = repo.rev("HEAD");

        let result = get_blame(repo.path(), "a.txt".into(), None).unwrap();
        assert_eq!(result.lines, ["a", "B", "c", "d", "e", "f"]);
        assert_eq!(
            spans(&result),
            [
                (one.clone(), 1, 1, false),
                (two.clone(), 2, 1, false),
                (one, 3, 1, false),
                (two.clone(), 4, 1, false),
                (three, 5, 2, false),
            ]
        );
        let hunk = &result.hunks[1];
        assert_eq!(hunk.summary, "two");
        assert_eq!(hunk.author, "테스터");
        assert_eq!(hunk.author_email, "tester@example.com");
        assert_eq!(hunk.short_sha, short_sha(&two));
        assert!(hunk.timestamp > 0);
    }

    #[test]
    fn 워킹트리_blame은_고친_줄을_uncommitted로_표시한다() {
        let (repo, one, two) = blame_fixture();
        repo.write("a.txt", "a\nB\nc\nX\n");

        let result = get_blame(repo.path(), "a.txt".into(), None).unwrap();
        let zero = "0".repeat(40);
        assert_eq!(
            spans(&result),
            [
                (one.clone(), 1, 1, false),
                (two.clone(), 2, 1, false),
                (one.clone(), 3, 1, false),
                (zero, 4, 1, true),
            ]
        );
        assert_eq!(result.hunks[3].summary, UNCOMMITTED_SUMMARY);

        // rev를 주면 워킹트리 수정은 보이지 않는다
        let at_head = get_blame(repo.path(), "a.txt".into(), Some("HEAD".into())).unwrap();
        assert_eq!(at_head.lines, ["a", "B", "c", "d"]);
        assert!(at_head.hunks.iter().all(|h| !h.uncommitted));
        assert_eq!(at_head.hunks[3].sha, two);
    }

    #[test]
    fn 추적되지_않는_파일의_blame은_전부_uncommitted다() {
        let (repo, _, _) = blame_fixture();
        repo.write("new.txt", "a\nb\n");
        let result = get_blame(repo.path(), "new.txt".into(), None).unwrap();
        assert_eq!(result.hunks.len(), 1);
        assert_eq!(result.hunks[0].start_line, 1);
        assert_eq!(result.hunks[0].line_count, 2);
        assert!(result.hunks[0].uncommitted);
    }

    #[test]
    fn blame은_사용자_ignore_revs_설정에_흔들리지_않는다() {
        let (repo, _, two) = blame_fixture();
        let clean = get_blame(repo.path(), "a.txt".into(), None).unwrap();

        // two를 무시하면 git은 2번 줄을 one으로 넘긴다
        repo.write(".git/ignore-revs", &format!("{two}\n"));
        repo.git(&["config", "blame.ignoreRevsFile", ".git/ignore-revs"]);
        repo.git(&["config", "blame.markIgnoredLines", "true"]);
        // 설정이 실제로 결과를 바꾸는 픽스처인지 먼저 확인한다
        let raw = git::run(repo.path(), &["blame", "--porcelain", "--", "a.txt"]).unwrap();
        assert_ne!(hunk_spans(&parse_blame_porcelain(&raw)), spans(&clean));

        let configured = get_blame(repo.path(), "a.txt".into(), None).unwrap();
        assert_eq!(spans(&configured), spans(&clean));
        assert_eq!(configured.hunks[1].sha, two);
    }

    #[test]
    fn 설정된_ignore_revs_파일이_없어도_blame이_된다() {
        let (repo, _, _) = blame_fixture();
        repo.git(&["config", "blame.ignoreRevsFile", "does-not-exist"]);
        let result = get_blame(repo.path(), "a.txt".into(), None).unwrap();
        assert_eq!(result.hunks.len(), 4);
    }

    #[test]
    fn 바이너리_blame은_binary_오류다() {
        let (repo, _, _) = blame_fixture();
        repo.write_bytes("bin.dat", b"a\0b\n");
        repo.git(&["add", "-A"]);
        repo.git(&["commit", "-qm", "bin"]);
        assert_eq!(
            get_blame(repo.path(), "bin.dat".into(), None).unwrap_err(),
            "binary"
        );
        assert_eq!(
            get_blame(repo.path(), "bin.dat".into(), Some("HEAD".into())).unwrap_err(),
            "binary"
        );
    }

    #[test]
    fn 상한을_넘는_파일의_blame은_too_large다() {
        let (repo, _, _) = blame_fixture();
        repo.write("big.txt", &"a\n".repeat(MAX_FILE_BYTES / 2 + 1));
        assert_eq!(
            get_blame(repo.path(), "big.txt".into(), None).unwrap_err(),
            "too large"
        );
    }

    #[test]
    fn 빈_파일의_blame은_빈_결과다() {
        let (repo, _, _) = blame_fixture();
        repo.write("empty.txt", "");
        repo.git(&["add", "-A"]);
        repo.git(&["commit", "-qm", "empty"]);
        let result = get_blame(repo.path(), "empty.txt".into(), None).unwrap();
        assert!(result.lines.is_empty());
        assert!(result.hunks.is_empty());
    }

    #[test]
    fn porcelain_순서가_섞여도_결과_줄_번호로_묶는다() {
        let a = "a".repeat(40);
        let b = "b".repeat(40);
        let out = format!(
            "{b} 1 2 1\nauthor B\nauthor-mail <b@x>\nauthor-time 2\nsummary sb\n\tline2\n\
             {a} 1 1 1\nauthor A\nauthor-mail <a@x>\nauthor-time 1\nsummary sa\n\tline1\n\
             {a} 2 3 1\n\tline3\n"
        );
        let hunks = parse_blame_porcelain(&out);
        let got: Vec<(&str, u32, u32)> = hunks
            .iter()
            .map(|h| (h.summary.as_str(), h.start_line, h.line_count))
            .collect();
        assert_eq!(got, [("sa", 1, 1), ("sb", 2, 1), ("sa", 3, 1)]);
        assert_eq!(hunks[1].author_email, "b@x");
    }

    /// main: root → m1(main.txt). feature: root → f1(feature.txt) → f2(shared.txt 수정).
    fn diverged_fixture() -> TempRepo {
        let repo = TempRepo::init("gitlanes-compare");
        repo.write("shared.txt", "base\n");
        repo.git(&["add", "-A"]);
        repo.git(&["commit", "-qm", "root"]);
        repo.git(&["checkout", "-q", "-b", "feature"]);
        repo.write("feature.txt", "f\n");
        repo.git(&["add", "-A"]);
        repo.git(&["commit", "-qm", "f1"]);
        repo.write("shared.txt", "base\nfeature\n");
        repo.git(&["commit", "-qam", "f2"]);
        repo.git(&["checkout", "-q", "main"]);
        repo.write("main.txt", "m\n");
        repo.git(&["add", "-A"]);
        repo.git(&["commit", "-qm", "m1"]);
        repo
    }

    fn commit_subjects(commits: &[CommitSummary]) -> Vec<&str> {
        commits.iter().map(|c| c.subject.as_str()).collect()
    }

    #[test]
    fn 비교는_양쪽에만_있는_커밋과_세_점_파일_목록을_돌려준다() {
        let repo = diverged_fixture();
        let result = compare_refs(repo.path(), "main".into(), "feature".into(), 50).unwrap();

        assert_eq!(result.base, "main");
        assert_eq!(result.head, "feature");
        assert_eq!(result.merge_base, Some(repo.rev("main~1")));
        assert_eq!(commit_subjects(&result.only_in_head), ["f2", "f1"]);
        assert_eq!(commit_subjects(&result.only_in_base), ["m1"]);
        assert!(!result.only_in_head_truncated);
        assert!(!result.only_in_base_truncated);

        // base가 앞서 나간 main.txt는 섞이지 않는다
        let mut files: Vec<(&str, FileStatus, u64)> = result
            .files
            .iter()
            .map(|f| (f.path.as_str(), f.status, f.additions))
            .collect();
        files.sort_by_key(|f| f.0);
        assert_eq!(
            files,
            [
                ("feature.txt", FileStatus::Added, 1),
                ("shared.txt", FileStatus::Modified, 1),
            ]
        );
        assert_eq!(result.only_in_head[0].sha, repo.rev("feature"));
    }

    #[test]
    fn 비교는_limit을_넘은_목록만_자르고_그_목록의_truncated만_켠다() {
        let repo = diverged_fixture();
        // head 쪽 2개, base 쪽 1개. limit 1이면 head만 잘린다
        let result = compare_refs(repo.path(), "main".into(), "feature".into(), 1).unwrap();
        assert_eq!(commit_subjects(&result.only_in_head), ["f2"]);
        assert_eq!(commit_subjects(&result.only_in_base), ["m1"]);
        assert!(result.only_in_head_truncated);
        assert!(!result.only_in_base_truncated);

        // 방향을 바꾸면 잘리는 쪽도 바뀐다
        let flipped = compare_refs(repo.path(), "feature".into(), "main".into(), 1).unwrap();
        assert!(!flipped.only_in_head_truncated);
        assert!(flipped.only_in_base_truncated);
    }

    #[test]
    fn 비교_결과는_목록별_truncated를_camel_case로_직렬화한다() {
        let repo = diverged_fixture();
        let result = compare_refs(repo.path(), "main".into(), "feature".into(), 1).unwrap();
        let json = serde_json::to_value(&result).unwrap();
        assert_eq!(json["onlyInHeadTruncated"], true);
        assert_eq!(json["onlyInBaseTruncated"], false);
        assert!(json.get("truncated").is_none());
    }

    #[test]
    fn 관계없는_히스토리는_merge_base가_없고_두_트리를_바로_비교한다() {
        let repo = diverged_fixture();
        repo.git(&["checkout", "-q", "--orphan", "lone"]);
        repo.git(&["rm", "-rqf", "."]);
        repo.write("lone.txt", "z\n");
        repo.git(&["add", "-A"]);
        repo.git(&["commit", "-qm", "lone"]);

        let result = compare_refs(repo.path(), "main".into(), "lone".into(), 50).unwrap();
        assert_eq!(result.merge_base, None);
        assert_eq!(commit_subjects(&result.only_in_head), ["lone"]);
        assert_eq!(commit_subjects(&result.only_in_base), ["m1", "root"]);
        let mut files: Vec<(&str, FileStatus)> = result
            .files
            .iter()
            .map(|f| (f.path.as_str(), f.status))
            .collect();
        files.sort_by_key(|f| f.0);
        assert_eq!(
            files,
            [
                ("lone.txt", FileStatus::Added),
                ("main.txt", FileStatus::Deleted),
                ("shared.txt", FileStatus::Deleted),
            ]
        );

        let diff = get_compare_file_diff(
            repo.path(),
            "main".into(),
            "lone".into(),
            "lone.txt".into(),
            None,
        )
        .unwrap();
        assert!(diff.contains("+z"), "{diff}");
    }

    #[test]
    fn 없는_ref_비교는_오류다() {
        let repo = diverged_fixture();
        assert!(compare_refs(repo.path(), "main".into(), "nope".into(), 5).is_err());
        assert!(compare_refs(repo.path(), "--all".into(), "main".into(), 5).is_err());
    }

    #[test]
    fn 비교_파일_diff는_세_점_기준이고_접두가_고정된다() {
        let repo = diverged_fixture();
        // 사용자 설정이 접두를 바꿔도 a/ b/ 로 나온다
        repo.git(&["config", "diff.noprefix", "true"]);

        let diff = get_compare_file_diff(
            repo.path(),
            "main".into(),
            "feature".into(),
            "shared.txt".into(),
            None,
        )
        .unwrap();
        assert!(diff.contains("--- a/shared.txt"), "{diff}");
        assert!(diff.contains("+++ b/shared.txt"), "{diff}");
        assert!(diff.contains("+feature"), "{diff}");

        // base에서만 바뀐 파일은 세 점 diff에 없다
        let main_only = get_compare_file_diff(
            repo.path(),
            "main".into(),
            "feature".into(),
            "main.txt".into(),
            None,
        )
        .unwrap();
        assert!(main_only.is_empty(), "{main_only}");
    }

    #[test]
    fn 비교_파일_diff는_rename_원_경로를_함께_건다() {
        let repo = diverged_fixture();
        repo.git(&["checkout", "-q", "feature"]);
        repo.git(&["mv", "feature.txt", "renamed.txt"]);
        repo.git(&["commit", "-qm", "rename"]);

        let result = compare_refs(repo.path(), "main".into(), "feature".into(), 50).unwrap();
        // feature.txt는 merge-base에 없으므로 세 점 기준으로는 새 파일이다
        assert!(result.files.iter().any(|f| f.path == "renamed.txt"));

        repo.git(&["checkout", "-q", "main"]);
        let renamed_on_main = {
            repo.git(&["mv", "shared.txt", "moved.txt"]);
            repo.git(&["commit", "-qm", "move shared"]);
            compare_refs(repo.path(), "feature".into(), "main".into(), 50).unwrap()
        };
        let moved = renamed_on_main
            .files
            .iter()
            .find(|f| f.path == "moved.txt")
            .expect("rename이 목록에 있다");
        assert_eq!(moved.status, FileStatus::Renamed);
        assert_eq!(moved.old_path.as_deref(), Some("shared.txt"));

        let diff = get_compare_file_diff(
            repo.path(),
            "feature".into(),
            "main".into(),
            "moved.txt".into(),
            Some("shared.txt".into()),
        )
        .unwrap();
        assert!(diff.contains("rename from shared.txt"), "{diff}");
    }

    #[test]
    fn 비교_파일_diff는_대괄호_경로를_glob으로_풀지_않는다() {
        let repo = diverged_fixture();
        repo.git(&["checkout", "-q", "feature"]);
        repo.write("pages/[id].tsx", "real\n");
        repo.write("pages/i.tsx", "decoy\n");
        repo.git(&["add", "-A"]);
        repo.git(&["commit", "-qm", "pages"]);

        let diff = get_compare_file_diff(
            repo.path(),
            "main".into(),
            "feature".into(),
            "pages/[id].tsx".into(),
            None,
        )
        .unwrap();
        assert!(diff.contains("+real"), "{diff}");
        assert!(!diff.contains("decoy"), "{diff}");
    }
}
