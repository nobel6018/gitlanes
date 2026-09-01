//! 커밋 검색. git을 실행하지 않는 순수 계산이다.
//!
//! 로드된 행이 아니라 전체 히스토리를 대상으로 하며, 결과의 `index`는
//! `load_graph`와 같은 topo 순서에서의 행 인덱스다. 프론트는 그 값으로
//! 필요한 깊이까지 추가 로드한 뒤 해당 행으로 점프한다.
//!
//! @see CONTRACTS.md

use crate::model::SearchMatch;
use crate::parse::RawCommit;

/// 결과 상한. 프론트가 더 큰 값을 요청해도 여기서 잘린다.
pub const MAX_RESULTS: usize = 500;

/// subject, author 이름, sha로 커밋을 찾는다.
///
/// subject와 author는 부분일치, sha는 prefix 일치다. 셋 다 ASCII 대소문자를 무시한다.
/// 빈 질의는 결과가 없다.
pub fn find_matches(commits: &[RawCommit], query: &str, limit: usize) -> Vec<SearchMatch> {
    let query = query.trim();
    if query.is_empty() {
        return Vec::new();
    }
    let needle = query.to_ascii_lowercase();
    let cap = effective_limit(limit);

    let mut matches = Vec::new();
    for (index, commit) in commits.iter().enumerate() {
        if matches.len() >= cap {
            break;
        }
        if matches_commit(commit, &needle) {
            matches.push(SearchMatch {
                sha: commit.sha.clone(),
                index,
            });
        }
    }
    matches
}

/// 0은 "상한 없음"으로 보고 [`MAX_RESULTS`]를 쓴다. 그 밖에는 요청값과 상한 중 작은 쪽.
fn effective_limit(limit: usize) -> usize {
    if limit == 0 {
        MAX_RESULTS
    } else {
        limit.min(MAX_RESULTS)
    }
}

fn matches_commit(commit: &RawCommit, needle_lower: &str) -> bool {
    starts_with_ignore_ascii_case(&commit.sha, needle_lower)
        || contains_ignore_ascii_case(&commit.subject, needle_lower)
        || contains_ignore_ascii_case(&commit.author, needle_lower)
}

/// ASCII 대소문자만 무시하는 부분일치.
///
/// 한글 등 비ASCII는 대소문자 개념이 없어 그대로 비교하면 된다. UTF-8은 ASCII 바이트가
/// 멀티바이트 문자 안에 나타나지 않아서 바이트 단위로 훑어도 문자 경계가 깨지지 않는다.
/// 커밋마다 `to_lowercase()`로 새 String을 만들지 않으려고 이렇게 한다.
fn contains_ignore_ascii_case(haystack: &str, needle_lower: &str) -> bool {
    let (haystack, needle) = (haystack.as_bytes(), needle_lower.as_bytes());
    if needle.is_empty() {
        return true;
    }
    if haystack.len() < needle.len() {
        return false;
    }
    haystack
        .windows(needle.len())
        .any(|window| window.eq_ignore_ascii_case(needle))
}

fn starts_with_ignore_ascii_case(haystack: &str, needle_lower: &str) -> bool {
    let (haystack, needle) = (haystack.as_bytes(), needle_lower.as_bytes());
    haystack.len() >= needle.len() && haystack[..needle.len()].eq_ignore_ascii_case(needle)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn commit(sha: &str, subject: &str, author: &str) -> RawCommit {
        RawCommit {
            sha: sha.to_string(),
            parents: Vec::new(),
            author: author.to_string(),
            author_email: "t@t.com".to_string(),
            timestamp: 0,
            subject: subject.to_string(),
        }
    }

    fn fixture() -> Vec<RawCommit> {
        vec![
            commit(
                "ff362da2fa5b5d45b1b53354e085b920039aa4d8",
                "Merge branch 'Feature'",
                "홍길동",
            ),
            commit(
                "23df1a833990d7c206defdfbe41f5a7b20886aaa",
                "fix: 결제 실패 처리",
                "Kim Younghoon",
            ),
            commit(
                "0400f6927b0000000000000000000000000000aa",
                "chore: bump deps",
                "홍길동",
            ),
            commit(
                "aabbccdd11223344556677889900aabbccddeeff",
                "feat: 검색 추가",
                "Lee",
            ),
        ]
    }

    fn indices(matches: &[SearchMatch]) -> Vec<usize> {
        matches.iter().map(|m| m.index).collect()
    }

    #[test]
    fn subject를_대소문자_무시하고_부분일치로_찾는다() {
        let commits = fixture();
        assert_eq!(indices(&find_matches(&commits, "feature", 0)), vec![0]);
        assert_eq!(indices(&find_matches(&commits, "FEATURE", 0)), vec![0]);
        assert_eq!(indices(&find_matches(&commits, "merge", 0)), vec![0]);
    }

    #[test]
    fn 한글_subject도_찾는다() {
        let commits = fixture();
        assert_eq!(indices(&find_matches(&commits, "결제", 0)), vec![1]);
        assert_eq!(indices(&find_matches(&commits, "검색 추가", 0)), vec![3]);
    }

    #[test]
    fn author_이름으로_찾는다() {
        let commits = fixture();
        assert_eq!(indices(&find_matches(&commits, "홍길동", 0)), vec![0, 2]);
        // 대소문자 무시 + 부분일치
        assert_eq!(indices(&find_matches(&commits, "younghoon", 0)), vec![1]);
        assert_eq!(indices(&find_matches(&commits, "KIM", 0)), vec![1]);
    }

    #[test]
    fn sha는_prefix로_찾는다() {
        let commits = fixture();
        assert_eq!(indices(&find_matches(&commits, "ff362da", 0)), vec![0]);
        assert_eq!(indices(&find_matches(&commits, "FF362DA", 0)), vec![0]);
        assert_eq!(
            indices(&find_matches(
                &commits,
                "23df1a833990d7c206defdfbe41f5a7b20886aaa",
                0
            )),
            vec![1]
        );
        // 중간 일치는 sha로 잡지 않는다
        assert!(find_matches(&commits, "990d7c206", 0).is_empty());
    }

    #[test]
    fn index는_topo_순서의_행_번호다() {
        let commits = fixture();
        let hits = find_matches(&commits, "홍길동", 0);
        assert_eq!(hits.len(), 2);
        assert_eq!(hits[0].index, 0);
        assert_eq!(hits[0].sha, commits[0].sha);
        assert_eq!(hits[1].index, 2);
        assert_eq!(hits[1].sha, commits[2].sha);
    }

    #[test]
    fn 빈_질의는_결과가_없다() {
        let commits = fixture();
        assert!(find_matches(&commits, "", 0).is_empty());
        assert!(find_matches(&commits, "   ", 0).is_empty());
    }

    #[test]
    fn 못_찾으면_빈_목록이다() {
        assert!(find_matches(&fixture(), "존재하지않는문구", 0).is_empty());
    }

    #[test]
    fn 결과는_500개를_넘지_않는다() {
        let commits: Vec<RawCommit> = (0..1200)
            .map(|i| commit(&format!("{i:040x}"), "same subject", "T"))
            .collect();

        assert_eq!(find_matches(&commits, "same", 0).len(), MAX_RESULTS);
        assert_eq!(
            find_matches(&commits, "same", 100_000).len(),
            MAX_RESULTS,
            "요청값이 커도 상한에서 잘린다"
        );
        // 더 작은 값을 주면 그만큼만
        assert_eq!(find_matches(&commits, "same", 7).len(), 7);

        // 상한에 걸려도 index는 원래 행 번호를 유지한다
        let hits = find_matches(&commits, "same", 0);
        assert_eq!(hits[0].index, 0);
        assert_eq!(hits[MAX_RESULTS - 1].index, MAX_RESULTS - 1);
    }

    #[test]
    fn 질의는_앞뒤_공백을_무시한다() {
        assert_eq!(indices(&find_matches(&fixture(), "  merge  ", 0)), vec![0]);
    }
}
