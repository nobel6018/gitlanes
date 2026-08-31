//! `--dump` 디버그 모드. GUI를 띄우지 않고 `load_graph` 결과를 stdout에 뿌린다.
//! 레인 배치 눈검사와 대형 저장소 소요 시간 측정에 쓴다.
//!
//! 사용법: `gitlanes --dump <repo-path> [limit]`
//!
//! @see CONTRACTS.md

use std::io::Write;
use std::time::Instant;

use crate::commands::load_graph;

/// 이 플래그가 인자에 있으면 GUI를 띄우지 않는다.
/// `commands::pick_startup_repo`도 이 플래그를 보고 위치 인자를 소비하지 않는다.
pub const DUMP_FLAG: &str = "--dump";

const DEFAULT_LIMIT: usize = 5000;
const PREVIEW_ROWS: usize = 25;
const SUBJECT_CHARS: usize = 40;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DumpRequest {
    pub repo: String,
    pub limit: usize,
}

/// 인자에서 dump 요청을 읽는다.
///
/// - `None`: dump 모드가 아니다 (GUI로 진행)
/// - `Some(Err)`: dump 모드지만 인자가 잘못됐다
pub fn from_args<I>(args: I) -> Option<Result<DumpRequest, String>>
where
    I: IntoIterator<Item = String>,
{
    let mut rest = args.into_iter().skip_while(|arg| arg != DUMP_FLAG);
    rest.next()?; // DUMP_FLAG 자신

    let usage = format!("사용법: gitlanes {DUMP_FLAG} <repo-path> [limit]");
    let Some(repo) = rest.next().filter(|repo| !repo.trim().is_empty()) else {
        return Some(Err(usage));
    };

    let limit = match rest.next() {
        None => DEFAULT_LIMIT,
        Some(raw) => match raw.trim().parse::<usize>() {
            Ok(0) => return Some(Err("limit은 1 이상이어야 합니다".to_string())),
            Ok(limit) => limit,
            Err(_) => {
                return Some(Err(format!(
                    "limit을 숫자로 읽지 못했습니다: {raw:?}\n{usage}"
                )))
            }
        },
    };

    Some(Ok(DumpRequest {
        repo: repo.trim().to_string(),
        limit,
    }))
}

/// dump를 실행해 `out`에 쓴다. 요약 한 줄 뒤에 처음 [`PREVIEW_ROWS`]행을 찍는다.
pub fn run(request: &DumpRequest, out: &mut impl Write) -> Result<(), String> {
    let started = Instant::now();
    let data = load_graph(request.repo.clone(), request.limit)?;
    let elapsed_ms = started.elapsed().as_secs_f64() * 1000.0;

    let wip = match data.wip {
        Some(wip) => format!("{}changed/{}staged", wip.changed_files, wip.staged_files),
        None => "none".to_string(),
    };
    writeln!(
        out,
        "load_graph: {elapsed_ms:.1}ms totalLoaded={} laneCount={} hasMore={} wip={wip}",
        data.total_loaded, data.lane_count, data.has_more
    )
    .map_err(write_failed)?;

    for row in data.rows.iter().take(PREVIEW_ROWS) {
        let edges = row
            .edges
            .iter()
            .map(|e| format!("{}>{}:{}", e.from_lane, e.to_lane, e.color))
            .collect::<Vec<_>>()
            .join(", ");
        let refs = row
            .refs
            .iter()
            .map(|r| r.name.as_str())
            .collect::<Vec<_>>()
            .join(", ");

        writeln!(
            out,
            "{} lane={} color={} merge={} edges=[{}] refs=[{}] {}",
            row.short_sha,
            row.lane,
            row.color,
            u8::from(row.is_merge),
            edges,
            refs,
            truncate(&row.subject, SUBJECT_CHARS),
        )
        .map_err(write_failed)?;
    }

    if data.total_loaded > PREVIEW_ROWS {
        writeln!(out, "... {} rows omitted", data.total_loaded - PREVIEW_ROWS)
            .map_err(write_failed)?;
    }

    Ok(())
}

fn write_failed(e: std::io::Error) -> String {
    format!("출력에 실패했습니다: {e}")
}

/// 문자 수 기준으로 자른다. 한글이 바이트 중간에서 잘리지 않게 하려면 바이트가 아니라 char여야 한다.
fn truncate(subject: &str, max_chars: usize) -> String {
    let mut chars = subject.chars();
    let head: String = chars.by_ref().take(max_chars).collect();
    if chars.next().is_some() {
        format!("{head}…")
    } else {
        head
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn dump_플래그가_없으면_none이다() {
        assert!(from_args(args(&[])).is_none());
        assert!(from_args(args(&["/some/repo"])).is_none());
        assert!(from_args(args(&["--other", "/some/repo"])).is_none());
    }

    #[test]
    fn limit을_생략하면_기본값을_쓴다() {
        let request = from_args(args(&["--dump", "/some/repo"])).unwrap().unwrap();
        assert_eq!(
            request,
            DumpRequest {
                repo: "/some/repo".to_string(),
                limit: DEFAULT_LIMIT,
            }
        );
    }

    #[test]
    fn limit을_주면_그_값을_쓴다() {
        let request = from_args(args(&["--dump", "/some/repo", "120"]))
            .unwrap()
            .unwrap();
        assert_eq!(request.limit, 120);
        assert_eq!(request.repo, "/some/repo");
    }

    #[test]
    fn dump_앞에_다른_인자가_있어도_찾는다() {
        let request = from_args(args(&["-psn_0_1", "--dump", "/some/repo", "7"]))
            .unwrap()
            .unwrap();
        assert_eq!(request.limit, 7);
    }

    #[test]
    fn 경로가_없으면_사용법을_알린다() {
        let err = from_args(args(&["--dump"])).unwrap().unwrap_err();
        assert!(err.contains("사용법"), "{err}");
        let err = from_args(args(&["--dump", "   "])).unwrap().unwrap_err();
        assert!(err.contains("사용법"), "{err}");
    }

    #[test]
    fn limit이_숫자가_아니거나_0이면_오류다() {
        let err = from_args(args(&["--dump", "/r", "abc"]))
            .unwrap()
            .unwrap_err();
        assert!(err.contains("limit을 숫자로 읽지 못했습니다"), "{err}");

        let err = from_args(args(&["--dump", "/r", "0"]))
            .unwrap()
            .unwrap_err();
        assert!(err.contains("1 이상"), "{err}");
    }

    #[test]
    fn subject는_문자_수로_자르고_말줄임표를_붙인다() {
        assert_eq!(truncate("짧다", 40), "짧다");
        // 한글 45자 → 40자 + …
        let long = "가".repeat(45);
        let cut = truncate(&long, 40);
        assert_eq!(cut.chars().count(), 41);
        assert!(cut.ends_with('…'));
        assert_eq!(truncate("가나다", 3), "가나다", "딱 맞으면 말줄임표가 없다");
    }

    #[test]
    fn 없는_저장소로_dump하면_오류를_돌려준다() {
        let request = DumpRequest {
            repo: "/definitely/not/a/repo/gitlanes".to_string(),
            limit: 10,
        };
        let mut out = Vec::new();
        assert!(run(&request, &mut out).is_err());
    }
}
