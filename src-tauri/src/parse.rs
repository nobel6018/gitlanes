//! git CLI 출력 파서. 프로세스를 띄우지 않는 순수 함수만 둔다.
//!
//! 구분자는 git pretty format의 `%x1f`(필드) / `%x1e`(레코드)와
//! `-z` 옵션의 NUL을 그대로 쓴다. 경로에 등장할 수 없는 바이트라 따옴표 처리가 필요 없다.
//!
//! @see CONTRACTS.md

use std::collections::{HashMap, HashSet};

use crate::model::{
    short_sha, FileChange, FileStatus, RefEntry, RefInfo, RefKind, StashInfo, WipInfo,
};

/// `git log` 한 레코드. 레인 배치 입력이기도 하다.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RawCommit {
    pub sha: String,
    pub parents: Vec<String>,
    pub author: String,
    pub author_email: String,
    pub timestamp: i64,
    pub subject: String,
}

/// `git log`에 넘기는 pretty format. 필드 순서가 [`parse_log`]와 짝을 이룬다.
pub const LOG_FORMAT: &str = "--format=%H%x1f%P%x1f%an%x1f%ae%x1f%at%x1f%s%x1e";

/// `git show -s`에 넘기는 pretty format. 필드 순서가 [`parse_commit_meta`]와 짝을 이룬다.
pub const META_FORMAT: &str =
    "--format=%H%x1f%an%x1f%ae%x1f%at%x1f%cn%x1f%ce%x1f%ct%x1f%P%x1f%s%x1f%b";

/// `git stash list`에 넘기는 pretty format. stash list는 git log라 `%x1f`가 그대로 통한다.
pub const STASH_FORMAT: &str = "--format=%H%x1f%P%x1f%at%x1f%gs%x1e";

const FIELD: char = '\u{1f}';
const RECORD: char = '\u{1e}';

/// git log 레코드 구분자. 스트리밍 파서가 이 바이트 단위로 끊어 읽는다.
pub const RECORD_SEPARATOR: u8 = 0x1e;

/// 서브모듈 포인터(gitlink)의 트리 모드. `--raw`, `ls-files --stage`, `ls-tree` 모두 이 값이다
pub const GITLINK_MODE: &str = "160000";

/// [`LOG_FORMAT`] 레코드 하나를 파싱한다. 빈 레코드는 `Ok(None)`이다.
///
/// 레코드 앞에는 직전 레코드의 개행이 남아 있을 수 있어 먼저 털어낸다.
/// 스트리밍 파서와 [`parse_log`]가 같은 함수를 쓴다.
pub fn parse_log_record(record: &str) -> Result<Option<RawCommit>, String> {
    let record = record.trim_start_matches(['\n', '\r']);
    if record.is_empty() {
        return Ok(None);
    }

    let mut fields = record.splitn(6, FIELD);
    let sha = fields.next().unwrap_or_default();
    let parents = fields.next();
    let author = fields.next();
    let email = fields.next();
    let ts = fields.next();
    let subject = fields.next();

    let (Some(parents), Some(author), Some(email), Some(ts), Some(subject)) =
        (parents, author, email, ts, subject)
    else {
        return Err(format!("Could not parse git log output: {record:?}"));
    };
    if sha.is_empty() {
        return Err("git log output has no commit hash.".to_string());
    }
    let timestamp = ts
        .trim()
        .parse::<i64>()
        .map_err(|_| format!("git log author timestamp is not a number: {ts:?}"))?;

    Ok(Some(RawCommit {
        sha: sha.to_string(),
        parents: parents.split_whitespace().map(str::to_string).collect(),
        author: author.to_string(),
        author_email: email.to_string(),
        timestamp,
        subject: subject.to_string(),
    }))
}

/// [`META_FORMAT`] 출력 한 건.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CommitMeta {
    pub sha: String,
    pub author_name: String,
    pub author_email: String,
    pub author_timestamp: i64,
    pub committer_name: String,
    pub committer_email: String,
    pub committer_timestamp: i64,
    pub parents: Vec<String>,
    pub subject: String,
    pub body: String,
}

pub fn parse_commit_meta(out: &str) -> Result<CommitMeta, String> {
    let record = out.trim_start_matches(['\n', '\r']);
    let fields: Vec<&str> = record.splitn(10, FIELD).collect();
    if fields.len() < 10 || fields[0].is_empty() {
        return Err("Could not parse commit metadata from git show.".to_string());
    }
    let author_timestamp = parse_ts(fields[3], "author")?;
    let committer_timestamp = parse_ts(fields[6], "committer")?;

    Ok(CommitMeta {
        sha: fields[0].to_string(),
        author_name: fields[1].to_string(),
        author_email: fields[2].to_string(),
        author_timestamp,
        committer_name: fields[4].to_string(),
        committer_email: fields[5].to_string(),
        committer_timestamp,
        parents: fields[7].split_whitespace().map(str::to_string).collect(),
        subject: fields[8].to_string(),
        body: fields[9].trim_end_matches(['\n', '\r']).to_string(),
    })
}

fn parse_ts(raw: &str, which: &str) -> Result<i64, String> {
    raw.trim()
        .parse::<i64>()
        .map_err(|_| format!("{which} timestamp is not a number: {raw:?}"))
}

/// `git for-each-ref` 출력을 대상 커밋 sha → refs 맵으로 만든다.
///
/// 포맷: `%(objectname)%1f%(*objectname)%1f%(refname)%1f%(HEAD)`
/// (for-each-ref는 `%x1f`를 해석하지 않아 `%1f`를 쓴다.)
/// annotated tag는 tag 객체 sha가 아니라 역참조한 커밋 sha에 매달아야 한다.
pub fn parse_ref_entries(out: &str) -> Vec<RefEntry> {
    let mut entries: Vec<RefEntry> = Vec::new();
    for line in out.lines() {
        if line.trim().is_empty() {
            continue;
        }
        let fields: Vec<&str> = line.splitn(4, FIELD).collect();
        if fields.len() < 3 {
            continue;
        }
        let object = fields[0];
        let peeled = fields[1];
        let refname = fields[2];
        let head_marker = fields.get(3).copied().unwrap_or("").trim();

        let target = if peeled.is_empty() { object } else { peeled };
        if target.is_empty() {
            continue;
        }

        let (kind, name) = if let Some(name) = refname.strip_prefix("refs/heads/") {
            (RefKind::LocalBranch, name)
        } else if let Some(name) = refname.strip_prefix("refs/remotes/") {
            // origin/HEAD는 다른 브랜치를 가리키는 심볼릭 ref라 표시하지 않는다.
            if name == "HEAD" || name.ends_with("/HEAD") {
                continue;
            }
            (RefKind::RemoteBranch, name)
        } else if let Some(name) = refname.strip_prefix("refs/tags/") {
            (RefKind::Tag, name)
        } else {
            continue;
        };
        if name.is_empty() {
            continue;
        }

        entries.push(RefEntry {
            name: name.to_string(),
            kind,
            sha: target.to_string(),
            is_head: kind == RefKind::LocalBranch && head_marker == "*",
        });
    }

    entries.sort_by(|a, b| a.kind.cmp(&b.kind).then_with(|| a.name.cmp(&b.name)));
    entries
}

/// [`parse_ref_entries`] 결과를 커밋 sha로 묶는다. 각 sha 안의 순서는 정렬을 물려받는다.
pub fn parse_refs(out: &str) -> HashMap<String, Vec<RefInfo>> {
    let mut map: HashMap<String, Vec<RefInfo>> = HashMap::new();
    for entry in parse_ref_entries(out) {
        map.entry(entry.sha).or_default().push(RefInfo {
            name: entry.name,
            kind: entry.kind,
            is_head: entry.is_head,
        });
    }
    map
}

/// [`STASH_FORMAT`] 출력을 스태시 목록으로 만든다. `git stash list` 순서(최신 우선)를 유지한다.
///
/// 스태시 커밋은 부모가 2~3개다(base, index 상태, untracked). 첫 부모가 기반 커밋이다.
pub fn parse_stashes(out: &str) -> Vec<StashInfo> {
    let mut stashes = Vec::new();
    for record in out.split(RECORD) {
        let record = record.trim_start_matches(['\n', '\r']);
        if record.is_empty() {
            continue;
        }
        // message(%gs)에 콜론이 흔해 필드 구분자는 \x1f를 쓴다. 메시지는 마지막 필드라 그대로 남는다
        let fields: Vec<&str> = record.splitn(4, FIELD).collect();
        if fields.len() < 4 || fields[0].is_empty() {
            continue;
        }
        let Ok(timestamp) = fields[2].trim().parse::<i64>() else {
            continue;
        };

        stashes.push(StashInfo {
            short_sha: short_sha(fields[0]),
            sha: fields[0].to_string(),
            message: fields[3].to_string(),
            base_sha: fields[1]
                .split_whitespace()
                .next()
                .unwrap_or_default()
                .to_string(),
            timestamp,
        });
    }
    stashes
}

/// FNV-1a 64비트. 의존성을 늘리지 않으려고 직접 쓴다. 충돌 내성은 필요 없고
/// "바뀌었는가"만 보면 되는 지문 용도다([`graph_token`], WIP `content_token`).
pub struct Fnv(u64);

impl Fnv {
    const OFFSET: u64 = 0xcbf2_9ce4_8422_2325;
    const PRIME: u64 = 0x0000_0100_0000_01b3;

    pub fn new() -> Self {
        Self(Self::OFFSET)
    }

    pub fn absorb(&mut self, bytes: &[u8]) {
        for &byte in bytes {
            self.0 ^= u64::from(byte);
            self.0 = self.0.wrapping_mul(Self::PRIME);
        }
    }

    pub fn hex(&self) -> String {
        format!("{:016x}", self.0)
    }
}

/// 그래프 지문. 아래 중 하나라도 바뀌면 값이 달라진다.
///
/// - ref 하나하나의 이름, 종류, 가리키는 커밋, 체크아웃 여부(`is_head`)
/// - HEAD가 가리키는 커밋
/// - 스태시 목록(sha, `stash@{0}`부터 순서대로)
///
/// `is_head`가 없으면 같은 커밋을 가리키는 다른 브랜치로 checkout해도 값이 그대로라 사이드바의
/// 현재 브랜치 표시가 낡는다. 스태시는 `refs/stash`가 `stash@{0}`만 가리켜서 ref 목록으로는
/// `stash@{1}` drop을 못 본다. 그래서 목록 전체를 섞는다.
///
/// 프론트는 skip 페이징 도중 이 값이 바뀌면 누적분을 버리고 전체를 다시 읽는다. `load_graph`와
/// `get_repo_state`가 같은 입력으로 이 함수를 불러야 폴링이 헛 재로드를 하지 않는다.
/// ref 입력 순서는 [`parse_ref_entries`]의 정렬(종류 → 이름)이라 실행마다 고정된다.
pub fn graph_token<S: AsRef<str>>(refs: &[RefEntry], head_sha: &str, stash_shas: &[S]) -> String {
    let mut hash = Fnv::new();
    for entry in refs {
        // 종류까지 섞어야 같은 이름의 로컬/원격 브랜치가 구분된다
        hash.absorb(format!("{:?}", entry.kind).as_bytes());
        hash.absorb(b"\x1f");
        hash.absorb(entry.name.as_bytes());
        hash.absorb(b"\x1f");
        hash.absorb(entry.sha.as_bytes());
        hash.absorb(b"\x1f");
        hash.absorb(if entry.is_head { b"*" } else { b"-" });
        hash.absorb(b"\x1e");
    }
    hash.absorb(b"HEAD\x1f");
    hash.absorb(head_sha.as_bytes());
    hash.absorb(b"\x1estash");
    for sha in stash_shas {
        hash.absorb(b"\x1f");
        hash.absorb(sha.as_ref().as_bytes());
    }
    hash.hex()
}

/// `git status --porcelain -z` 출력을 세어 미커밋 변경 요약을 만든다. 깨끗하면 None.
///
/// 레코드는 `XY <path>\0`이고 rename/copy면 원본 경로가 청크 하나로 뒤따른다.
/// X는 index(staged) 상태, Y는 작업 트리 상태다. `??`는 untracked라 staged가 아니다.
///
/// 한 파일이 레코드 두 개로 나오는 경우가 있어(예: `git rm --cached`는 `D `와 `??`를
/// 함께 낸다) 경로로 중복을 제거한다.
///
/// `content_token`은 레코드 순서대로 모은 워킹 트리 경로를 받아 [`WipInfo::content_token`]을
/// 만든다. 지문은 파일 시스템을 읽어야 해서 이 모듈(순수 함수만)에 두지 않고 호출자가 넘긴다.
/// 깨끗하면 부르지 않는다.
pub fn parse_status<F>(out: &str, content_token: F) -> Option<WipInfo>
where
    F: FnOnce(&[&str]) -> String,
{
    let mut paths: Vec<&str> = Vec::new();
    let mut changed: HashSet<&str> = HashSet::new();
    let mut staged: HashSet<&str> = HashSet::new();
    // 세 집합은 서로 겹칠 수 있다. WipInfo 필드 주석 참고.
    let mut untracked: HashSet<&str> = HashSet::new();

    let mut chunks = out.split('\0');
    while let Some(chunk) = chunks.next() {
        // "XY " 뒤에 경로가 붙는다. 그보다 짧으면 레코드가 아니다
        if chunk.len() < 4 {
            continue;
        }
        let mut marks = chunk.chars();
        let (Some(index_mark), Some(tree_mark)) = (marks.next(), marks.next()) else {
            continue;
        };
        let path = &chunk[3..];

        // rename/copy는 원본 경로가 별도 청크로 따라온다. 한 파일로 세야 하니 건너뛴다
        if matches!(index_mark, 'R' | 'C') || matches!(tree_mark, 'R' | 'C') {
            chunks.next();
        }

        if changed.insert(path) {
            paths.push(path);
        }
        if index_mark == '?' {
            untracked.insert(path);
        } else if index_mark != ' ' {
            staged.insert(path);
        }
    }

    if changed.is_empty() {
        return None;
    }
    Some(WipInfo {
        changed_files: changed.len(),
        staged_files: staged.len(),
        untracked_files: untracked.len(),
        content_token: content_token(&paths),
    })
}

/// `--raw --numstat -M -z` 출력을 파일 변경 목록으로 만든다.
///
/// raw 섹션이 먼저 나오고 numstat 섹션이 뒤따른다. raw 레코드는 `:`로 시작하므로
/// 한 번의 스캔으로 두 섹션을 구분한다. 순서는 raw 섹션 순서를 따른다.
pub fn parse_file_changes(out: &str) -> Vec<FileChange> {
    let chunks: Vec<&str> = out.split('\0').collect();
    let mut entries: Vec<(String, Option<String>, FileStatus, bool)> = Vec::new();
    let mut counts: HashMap<String, (u64, u64)> = HashMap::new();

    let mut i = 0;
    while i < chunks.len() {
        let chunk = chunks[i];
        if chunk.is_empty() {
            i += 1;
            continue;
        }

        if let Some(rest) = chunk.strip_prefix(':') {
            // ":100644 100644 <src sha> <dst sha> <status>"
            let letter = rest
                .split_whitespace()
                .next_back()
                .and_then(|token| token.chars().next())
                .unwrap_or('M');
            let status = FileStatus::from_letter(letter);
            // 한쪽이라도 gitlink면 서브모듈 항목이다. 추가(000000 → 160000)와 삭제도 포함한다
            let submodule = rest
                .split_whitespace()
                .take(2)
                .any(|mode| mode == GITLINK_MODE);
            if matches!(status, FileStatus::Renamed | FileStatus::Copied) {
                let old = chunks.get(i + 1).copied().unwrap_or_default();
                let new = chunks.get(i + 2).copied().unwrap_or_default();
                entries.push((new.to_string(), Some(old.to_string()), status, submodule));
                i += 3;
            } else {
                let path = chunks.get(i + 1).copied().unwrap_or_default();
                entries.push((path.to_string(), None, status, submodule));
                i += 2;
            }
            continue;
        }

        if let Some((additions, deletions, path)) = split_numstat(chunk) {
            if path.is_empty() {
                // rename/copy: "adds\tdels\t" 뒤로 old, new 청크가 따라온다
                let new = chunks.get(i + 2).copied().unwrap_or_default();
                counts.insert(new.to_string(), (additions, deletions));
                i += 3;
            } else {
                counts.insert(path.to_string(), (additions, deletions));
                i += 1;
            }
            continue;
        }

        i += 1;
    }

    entries
        .into_iter()
        .map(|(path, old_path, status, submodule)| {
            let (additions, deletions) = counts.get(&path).copied().unwrap_or((0, 0));
            FileChange {
                path,
                old_path,
                status,
                additions,
                deletions,
                submodule,
            }
        })
        .collect()
}

/// "12\t3\tpath" 또는 "12\t3\t"를 (추가, 삭제, 경로)로 쪼갠다.
/// 바이너리 파일은 숫자 대신 "-"라 0으로 둔다.
fn split_numstat(chunk: &str) -> Option<(u64, u64, &str)> {
    let mut parts = chunk.splitn(3, '\t');
    let additions = parse_count(parts.next()?)?;
    let deletions = parse_count(parts.next()?)?;
    let path = parts.next()?;
    Some((additions, deletions, path))
}

fn parse_count(raw: &str) -> Option<u64> {
    if raw == "-" {
        return Some(0);
    }
    raw.parse::<u64>().ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 출력 전체를 한 번에 파싱한다. 프로덕션은 [`parse_log_record`]에 스트리밍으로
    /// 레코드를 공급하지만, 파싱 규칙 자체는 이 경로로도 똑같이 검증된다.
    fn parse_log(out: &str) -> Result<Vec<RawCommit>, String> {
        let mut commits = Vec::new();
        for record in out.split(RECORD) {
            if let Some(commit) = parse_log_record(record)? {
                commits.push(commit);
            }
        }
        Ok(commits)
    }

    /// 실제 git 출력과 같게 필드는 \x1f, 레코드는 \x1e + 개행으로 잇는다.
    fn log_record(fields: &[&str]) -> String {
        format!("{}\u{1e}\n", fields.join("\u{1f}"))
    }

    #[test]
    fn git_log_출력을_topo_순서대로_파싱한다() {
        let out = [
            log_record(&[
                "ff362da2fa5b5d45b1b53354e085b920039aa4d8",
                "23df1a833990d7c206defdfbe41f5a7b20886aaa 6da487fed92ed27e07b0e098f9298e8688f87e3b",
                "홍길동",
                "gildong@example.com",
                "1788192508",
                "Merge branch 'feature'",
            ]),
            log_record(&[
                "23df1a833990d7c206defdfbe41f5a7b20886aaa",
                "5db85318013757 4ac9b66fbba516af2805fe6750",
                "T",
                "t@t.com",
                "1788192500",
                "main work",
            ]),
            log_record(&[
                "0400f6900000000000000000000000000000aaaa",
                "",
                "T",
                "t@t.com",
                "1788100000",
                "root commit",
            ]),
        ]
        .concat();

        let commits = parse_log(&out).unwrap();
        assert_eq!(commits.len(), 3);

        assert_eq!(commits[0].sha, "ff362da2fa5b5d45b1b53354e085b920039aa4d8");
        assert_eq!(
            commits[0].parents,
            vec![
                "23df1a833990d7c206defdfbe41f5a7b20886aaa".to_string(),
                "6da487fed92ed27e07b0e098f9298e8688f87e3b".to_string(),
            ]
        );
        assert_eq!(commits[0].author, "홍길동");
        assert_eq!(commits[0].author_email, "gildong@example.com");
        assert_eq!(commits[0].timestamp, 1788192508);
        assert_eq!(commits[0].subject, "Merge branch 'feature'");

        // 루트 커밋은 부모가 없다
        assert!(commits[2].parents.is_empty());
        assert_eq!(commits[2].subject, "root commit");
    }

    #[test]
    fn subject에_구분자가_아닌_특수문자가_있어도_잘리지_않는다() {
        let out = log_record(&[
            "a".repeat(40).as_str(),
            "",
            "T",
            "t@t.com",
            "1",
            "fix: a => b, 100% done | 끝",
        ]);
        let commits = parse_log(&out).unwrap();
        assert_eq!(commits[0].subject, "fix: a => b, 100% done | 끝");
    }

    #[test]
    fn 빈_출력은_빈_목록이다() {
        assert!(parse_log("").unwrap().is_empty());
        assert!(parse_log("\n").unwrap().is_empty());
    }

    #[test]
    fn 필드가_모자란_레코드는_오류다() {
        let err = parse_log("abc\u{1f}\u{1f}T\u{1e}\n").unwrap_err();
        assert!(err.contains("Could not parse"), "{err}");
    }

    #[test]
    fn for_each_ref_출력에서_ref_종류와_head_표시를_읽는다() {
        let out = concat!(
            "6da487fe\u{1f}\u{1f}refs/heads/feature\u{1f} \n",
            "ff362da2\u{1f}\u{1f}refs/heads/main\u{1f}*\n",
            "ff362da2\u{1f}\u{1f}refs/remotes/origin/main\u{1f} \n",
            "ff362da2\u{1f}\u{1f}refs/remotes/origin/HEAD\u{1f} \n",
            "ff362da2\u{1f}\u{1f}refs/tags/light\u{1f} \n",
            "d2e5496e\u{1f}ff362da2\u{1f}refs/tags/v1.0\u{1f} \n",
        );
        let map = parse_refs(out);

        let head = map.get("ff362da2").expect("HEAD 커밋의 refs가 있어야 한다");
        // localBranch → remoteBranch → tag 순으로 정렬된다
        assert_eq!(
            head.iter().map(|r| r.name.as_str()).collect::<Vec<_>>(),
            vec!["main", "origin/main", "light", "v1.0"]
        );
        assert_eq!(head[0].kind, RefKind::LocalBranch);
        assert!(head[0].is_head, "체크아웃된 브랜치는 is_head가 true다");
        assert_eq!(head[1].kind, RefKind::RemoteBranch);
        assert!(!head[1].is_head);
        assert_eq!(head[2].kind, RefKind::Tag);
        assert_eq!(head[3].kind, RefKind::Tag);

        // annotated tag는 tag 객체 sha가 아니라 역참조한 커밋에 붙는다
        assert!(!map.contains_key("d2e5496e"));

        let feature = map.get("6da487fe").unwrap();
        assert_eq!(feature.len(), 1);
        assert!(!feature[0].is_head, "체크아웃 안 된 브랜치는 false다");

        // origin/HEAD는 심볼릭 ref라 제외한다
        assert!(!head.iter().any(|r| r.name.contains("HEAD")));
    }

    #[test]
    fn list_refs용_항목은_종류와_이름순으로_정렬된다() {
        let out = concat!(
            "d2e5496e\u{1f}ff362da2\u{1f}refs/tags/v1.0\u{1f} \n",
            "ff362da2\u{1f}\u{1f}refs/remotes/origin/main\u{1f} \n",
            "6da487fe\u{1f}\u{1f}refs/heads/feature\u{1f} \n",
            "ff362da2\u{1f}\u{1f}refs/heads/main\u{1f}*\n",
            "ff362da2\u{1f}\u{1f}refs/remotes/origin/HEAD\u{1f} \n",
        );
        let entries = parse_ref_entries(out);

        assert_eq!(
            entries
                .iter()
                .map(|e| (e.kind, e.name.as_str()))
                .collect::<Vec<_>>(),
            vec![
                (RefKind::LocalBranch, "feature"),
                (RefKind::LocalBranch, "main"),
                (RefKind::RemoteBranch, "origin/main"),
                (RefKind::Tag, "v1.0"),
            ]
        );
        // annotated tag는 역참조된 커밋 sha를 담는다
        assert_eq!(entries[3].sha, "ff362da2");
        assert_eq!(entries[0].sha, "6da487fe");
        assert!(entries[1].is_head, "체크아웃된 main만 is_head다");
        assert!(!entries[0].is_head);
        assert!(!entries[2].is_head);
    }

    #[test]
    fn stash_list_출력을_파싱한다() {
        // git stash list --format=%H%x1f%P%x1f%at%x1f%gs%x1e 실측 형태
        let out = [
            [
                "3505d9ecae466f207e9b0b2057c383ab8f1f0cba",
                "cbbb7657b34c5ae0eb345684c7826d0597911918 9b135c5f2e1cf3cbdafc58490c3fbeea14f26163",
                "1788225688",
                "WIP on main: cbbb765 base commit",
            ]
            .join("\u{1f}"),
            [
                "a218d2cac1125df48edbc9f4d0000000000000aa",
                "cbbb7657b34c5ae0eb345684c7826d0597911918 1111111111111111111111111111111111111111",
                "1788225700",
                "On main: fix: 한글 메시지 콜론 포함",
            ]
            .join("\u{1f}"),
        ]
        .join("\u{1e}\n")
            + "\u{1e}\n";

        let stashes = parse_stashes(&out);
        assert_eq!(stashes.len(), 2);

        assert_eq!(stashes[0].sha, "3505d9ecae466f207e9b0b2057c383ab8f1f0cba");
        assert_eq!(stashes[0].short_sha, "3505d9ecae");
        assert_eq!(stashes[0].message, "WIP on main: cbbb765 base commit");
        assert_eq!(
            stashes[0].base_sha, "cbbb7657b34c5ae0eb345684c7826d0597911918",
            "첫 부모가 기반 커밋이다"
        );
        assert_eq!(stashes[0].timestamp, 1788225688);

        // 메시지에 콜론이 여러 개고 한글이 섞여도 잘리지 않는다
        assert_eq!(stashes[1].message, "On main: fix: 한글 메시지 콜론 포함");
        assert_eq!(stashes[1].base_sha, stashes[0].base_sha);
    }

    #[test]
    fn 스태시가_없으면_빈_목록이다() {
        assert!(parse_stashes("").is_empty());
        assert!(parse_stashes("\n").is_empty());
    }

    const NO_STASH: &[&str] = &[];

    #[test]
    fn graph_token은_ref가_바뀌면_달라진다() {
        let base = vec![
            RefEntry {
                name: "main".into(),
                kind: RefKind::LocalBranch,
                sha: "aaa".into(),
                is_head: true,
            },
            RefEntry {
                name: "v1.0".into(),
                kind: RefKind::Tag,
                sha: "aaa".into(),
                is_head: false,
            },
        ];
        let token = graph_token(&base, "aaa", NO_STASH);

        assert_eq!(token.len(), 16, "16자리 hex다");
        assert_eq!(
            graph_token(&base, "aaa", NO_STASH),
            token,
            "같은 입력은 같은 값이다"
        );

        // 브랜치 추가 (기존 커밋을 가리켜도 달라져야 한다)
        let mut added = base.clone();
        added.push(RefEntry {
            name: "feature".into(),
            kind: RefKind::LocalBranch,
            sha: "aaa".into(),
            is_head: false,
        });
        assert_ne!(graph_token(&added, "aaa", NO_STASH), token);

        // tip 이동
        let mut moved = base.clone();
        moved[0].sha = "bbb".into();
        assert_ne!(graph_token(&moved, "aaa", NO_STASH), token);

        // 브랜치 이름 변경
        let mut renamed = base.clone();
        renamed[0].name = "master".into();
        assert_ne!(graph_token(&renamed, "aaa", NO_STASH), token);

        // 같은 이름의 로컬/원격 구분
        let mut kind_swapped = base.clone();
        kind_swapped[0].kind = RefKind::RemoteBranch;
        assert_ne!(graph_token(&kind_swapped, "aaa", NO_STASH), token);

        // detached HEAD 이동
        assert_ne!(graph_token(&base, "ccc", NO_STASH), token);

        // 같은 커밋을 가리키는 다른 브랜치로 checkout
        let mut switched = added.clone();
        switched[0].is_head = false;
        switched[2].is_head = true;
        assert_ne!(
            graph_token(&switched, "aaa", NO_STASH),
            graph_token(&added, "aaa", NO_STASH)
        );
    }

    #[test]
    fn graph_token은_스태시_목록과_순서가_바뀌면_달라진다() {
        let refs: Vec<RefEntry> = Vec::new();
        let two = graph_token(&refs, "aaa", &["s0", "s1"]);
        assert_ne!(graph_token(&refs, "aaa", NO_STASH), two);
        assert_ne!(graph_token(&refs, "aaa", &["s0"]), two, "안쪽 drop");
        assert_ne!(graph_token(&refs, "aaa", &["s1", "s0"]), two, "순서");
        assert_eq!(graph_token(&refs, "aaa", &["s0", "s1"]), two);
    }

    fn no_token(_paths: &[&str]) -> String {
        String::new()
    }

    #[test]
    fn 지문_함수는_중복_없는_워킹_트리_경로를_레코드_순서로_받는다() {
        let out = "R  new.txt\0old.txt\0D  f.txt\0?? f.txt\0 M b.txt\0";
        let wip = parse_status(out, |paths| paths.join("|")).unwrap();
        // rename 원본(old.txt)은 워킹 트리에 없으니 넣지 않는다. f.txt는 한 번만
        assert_eq!(wip.content_token, "new.txt|f.txt|b.txt");
    }

    #[test]
    fn status_출력에서_변경과_staged를_센다() {
        // git status --porcelain -z 실측 출력 형태
        let out = concat!(
            "AM both.txt\0",                  // staged + 이후 수정
            "D  del.txt\0",                   // staged 삭제
            "R  renamed.txt\0renameme.txt\0", // staged rename, 파일 1개로 센다
            "A  staged.txt\0",                // staged 추가
            " M tracked.txt\0",               // unstaged 수정
            "?? sub/\0",                      // untracked
            "?? untracked.txt\0",
        );
        let wip = parse_status(out, no_token).expect("변경이 있으면 Some이다");
        assert_eq!(wip.changed_files, 7);
        assert_eq!(wip.staged_files, 4, "AM, D, R, A만 index에 올라가 있다");
        assert_eq!(wip.untracked_files, 2, "?? 두 줄");
    }

    #[test]
    fn unstaged_rename도_파일_하나로_센다() {
        let out = " R new.txt\0old.txt\0";
        let wip = parse_status(out, no_token).unwrap();
        assert_eq!(wip.changed_files, 1);
        assert_eq!(wip.staged_files, 0);
        assert_eq!(wip.untracked_files, 0);
    }

    #[test]
    fn 같은_경로가_두_레코드로_나오면_한_번만_센다() {
        // git rm --cached는 index 삭제(D )와 작업 트리 잔존(??)을 함께 낸다
        let wip = parse_status("D  f.txt\0?? f.txt\0", no_token).unwrap();
        assert_eq!(wip.changed_files, 1);
        assert_eq!(wip.staged_files, 1);
        // 같은 파일이 staged이면서 untracked다. 세 수를 더해도 changed가 되지 않는다.
        assert_eq!(wip.untracked_files, 1);
    }

    #[test]
    fn 깨끗한_작업_트리는_none이다() {
        assert!(parse_status("", no_token).is_none());
        assert!(parse_status("\0", no_token).is_none());
    }

    #[test]
    fn 충돌_항목도_변경으로_센다() {
        let wip = parse_status("UU conflict.txt\0", no_token).unwrap();
        assert_eq!(wip.changed_files, 1);
        assert_eq!(wip.staged_files, 1);
        assert_eq!(wip.untracked_files, 0, "충돌은 추적 중인 파일이다");
    }

    #[test]
    fn 알_수_없는_ref_공간은_무시한다() {
        let out = "abc\u{1f}\u{1f}refs/stash\u{1f} \nabc\u{1f}\u{1f}refs/notes/commits\u{1f} \n";
        assert!(parse_refs(out).is_empty());
    }

    #[test]
    fn raw와_numstat이_섞인_출력에서_상태와_증감을_결합한다() {
        // git show --format= --raw --numstat -M -z 실측 출력 형태
        let out = concat!(
            ":100644 100644 de98044 d68dd40 R075\0a.txt\0b.txt\0",
            ":100644 100644 587be6b b77b4eb M\0keep.txt\0",
            ":000000 100644 0000000 6a69f92 A\0new.txt\0",
            ":100644 000000 abc1234 0000000 D\0gone.txt\0",
            ":100644 100755 abc1234 abc1234 T\0mode.sh\0",
            ":000000 100644 0000000 aaaaaaa A\0logo.png\0",
            "1\t0\t\0a.txt\0b.txt\0",
            "1\t0\tkeep.txt\0",
            "12\t0\tnew.txt\0",
            "0\t7\tgone.txt\0",
            "0\t0\tmode.sh\0",
            "-\t-\tlogo.png\0",
        );

        let files = parse_file_changes(out);
        assert_eq!(files.len(), 6);

        assert_eq!(files[0].path, "b.txt");
        assert_eq!(files[0].old_path.as_deref(), Some("a.txt"));
        assert_eq!(files[0].status, FileStatus::Renamed);
        assert_eq!((files[0].additions, files[0].deletions), (1, 0));

        assert_eq!(files[1].path, "keep.txt");
        assert_eq!(files[1].old_path, None);
        assert_eq!(files[1].status, FileStatus::Modified);
        assert_eq!((files[1].additions, files[1].deletions), (1, 0));

        assert_eq!(files[2].status, FileStatus::Added);
        assert_eq!(files[2].additions, 12);

        assert_eq!(files[3].status, FileStatus::Deleted);
        assert_eq!((files[3].additions, files[3].deletions), (0, 7));

        assert_eq!(files[4].status, FileStatus::TypeChanged);

        // 바이너리 파일의 "-\t-"는 0으로 떨어진다
        assert_eq!(files[5].path, "logo.png");
        assert_eq!((files[5].additions, files[5].deletions), (0, 0));
    }

    #[test]
    fn 경로에_공백과_한글이_있어도_파싱된다() {
        let out = concat!(
            ":100644 100644 aaa bbb M\0docs/설계 문서.md\0",
            "3\t1\tdocs/설계 문서.md\0",
        );
        let files = parse_file_changes(out);
        assert_eq!(files.len(), 1);
        assert_eq!(files[0].path, "docs/설계 문서.md");
        assert_eq!((files[0].additions, files[0].deletions), (3, 1));
    }

    #[test]
    fn numstat이_없는_파일은_0으로_채운다() {
        let out = ":100644 100644 aaa bbb M\0only-raw.txt\0";
        let files = parse_file_changes(out);
        assert_eq!(files.len(), 1);
        assert_eq!((files[0].additions, files[0].deletions), (0, 0));
    }

    #[test]
    fn 변경_파일이_없으면_빈_목록이다() {
        assert!(parse_file_changes("").is_empty());
    }

    #[test]
    fn 커밋_메타데이터를_파싱한다() {
        let out = [
            "ff362da",
            "홍길동",
            "gildong@example.com",
            "1788192508",
            "커미터",
            "committer@example.com",
            "1788192600",
            "aaa bbb",
            "Merge branch 'feature'",
            "본문 첫 줄\n\n본문 둘째 줄\n\n",
        ]
        .join("\u{1f}");

        let meta = parse_commit_meta(&out).unwrap();
        assert_eq!(meta.sha, "ff362da");
        assert_eq!(meta.author_name, "홍길동");
        assert_eq!(meta.author_timestamp, 1788192508);
        assert_eq!(meta.committer_name, "커미터");
        assert_eq!(meta.committer_timestamp, 1788192600);
        assert_eq!(meta.parents, vec!["aaa".to_string(), "bbb".to_string()]);
        assert_eq!(meta.subject, "Merge branch 'feature'");
        assert_eq!(meta.body, "본문 첫 줄\n\n본문 둘째 줄");
    }

    #[test]
    fn 본문이_없으면_빈_문자열이다() {
        let out = [
            "abc", "T", "t@t.com", "1", "T", "t@t.com", "2", "", "s", "\n",
        ]
        .join("\u{1f}");
        let meta = parse_commit_meta(&out).unwrap();
        assert_eq!(meta.body, "");
        assert!(meta.parents.is_empty());
    }

    #[test]
    fn 메타데이터_필드가_모자라면_오류다() {
        let err = parse_commit_meta("abc\u{1f}T").unwrap_err();
        assert!(err.contains("Could not parse"), "{err}");
    }
}
