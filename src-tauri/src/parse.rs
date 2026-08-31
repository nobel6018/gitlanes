//! git CLI 출력 파서. 프로세스를 띄우지 않는 순수 함수만 둔다.
//!
//! 구분자는 git pretty format의 `%x1f`(필드) / `%x1e`(레코드)와
//! `-z` 옵션의 NUL을 그대로 쓴다. 경로에 등장할 수 없는 바이트라 따옴표 처리가 필요 없다.
//!
//! @see CONTRACTS.md

use std::collections::HashMap;

use crate::model::{FileChange, FileStatus, RefInfo, RefKind};

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

const FIELD: char = '\u{1f}';
const RECORD: char = '\u{1e}';

/// [`LOG_FORMAT`] 출력을 커밋 목록으로 만든다. topo 순서를 그대로 유지한다.
pub fn parse_log(out: &str) -> Result<Vec<RawCommit>, String> {
    let mut commits = Vec::new();
    for record in out.split(RECORD) {
        let record = record.trim_start_matches(['\n', '\r']);
        if record.is_empty() {
            continue;
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
            return Err(format!("git log 출력을 해석하지 못했습니다: {record:?}"));
        };
        if sha.is_empty() {
            return Err("git log 출력에 커밋 해시가 없습니다".to_string());
        }
        let timestamp = ts
            .trim()
            .parse::<i64>()
            .map_err(|_| format!("git log의 author timestamp를 숫자로 읽지 못했습니다: {ts:?}"))?;

        commits.push(RawCommit {
            sha: sha.to_string(),
            parents: parents.split_whitespace().map(str::to_string).collect(),
            author: author.to_string(),
            author_email: email.to_string(),
            timestamp,
            subject: subject.to_string(),
        });
    }
    Ok(commits)
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
        return Err("git show의 커밋 메타데이터를 해석하지 못했습니다".to_string());
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
        .map_err(|_| format!("{which} timestamp를 숫자로 읽지 못했습니다: {raw:?}"))
}

/// `git for-each-ref` 출력을 대상 커밋 sha → refs 맵으로 만든다.
///
/// 포맷: `%(objectname)%1f%(*objectname)%1f%(refname)%1f%(HEAD)`
/// (for-each-ref는 `%x1f`를 해석하지 않아 `%1f`를 쓴다.)
/// annotated tag는 tag 객체 sha가 아니라 역참조한 커밋 sha에 매달아야 한다.
pub fn parse_refs(out: &str) -> HashMap<String, Vec<RefInfo>> {
    let mut map: HashMap<String, Vec<RefInfo>> = HashMap::new();
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

        map.entry(target.to_string()).or_default().push(RefInfo {
            name: name.to_string(),
            kind,
            is_head: kind == RefKind::LocalBranch && head_marker == "*",
        });
    }

    for refs in map.values_mut() {
        refs.sort_by(|a, b| a.kind.cmp(&b.kind).then_with(|| a.name.cmp(&b.name)));
    }
    map
}

/// `--raw --numstat -M -z` 출력을 파일 변경 목록으로 만든다.
///
/// raw 섹션이 먼저 나오고 numstat 섹션이 뒤따른다. raw 레코드는 `:`로 시작하므로
/// 한 번의 스캔으로 두 섹션을 구분한다. 순서는 raw 섹션 순서를 따른다.
pub fn parse_file_changes(out: &str) -> Vec<FileChange> {
    let chunks: Vec<&str> = out.split('\0').collect();
    let mut entries: Vec<(String, Option<String>, FileStatus)> = Vec::new();
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
            if matches!(status, FileStatus::Renamed | FileStatus::Copied) {
                let old = chunks.get(i + 1).copied().unwrap_or_default();
                let new = chunks.get(i + 2).copied().unwrap_or_default();
                entries.push((new.to_string(), Some(old.to_string()), status));
                i += 3;
            } else {
                let path = chunks.get(i + 1).copied().unwrap_or_default();
                entries.push((path.to_string(), None, status));
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
        .map(|(path, old_path, status)| {
            let (additions, deletions) = counts.get(&path).copied().unwrap_or((0, 0));
            FileChange {
                path,
                old_path,
                status,
                additions,
                deletions,
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
        assert!(err.contains("해석하지 못했습니다"), "{err}");
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
        assert!(err.contains("해석하지 못했습니다"), "{err}");
    }
}
