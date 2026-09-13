//! 충돌 목록과 해결.
//!
//! @see CONTRACTS.md

use crate::git;
use crate::model::{ConflictFile, ConflictKind, OpResult};

use super::run::{run_chain, run_op, validate_paths, LOCAL_TIMEOUT};

/// 충돌 시작과 끝 마커. 사용자가 손으로 지웠는지 보는 데 쓴다.
const MARKER_START: &str = "<<<<<<<";
const MARKER_END: &str = ">>>>>>>";

/// 충돌 파일 목록과 각 파일의 충돌 종류.
#[tauri::command]
pub fn get_conflicts(path: String) -> Result<Vec<ConflictFile>, String> {
    // `ls-files -u`는 스테이지 번호(1=base, 2=ours, 3=theirs)와 경로를 함께 준다.
    // 어느 스테이지가 빠졌는지가 곧 "누가 지웠는지"라서 이 한 번의 호출로 종류가 나온다.
    let raw = git::run(&path, &["ls-files", "-u", "-z"])?;
    let mut files = parse_unmerged(&raw);

    for file in &mut files {
        file.has_markers = has_markers(&path, &file.path);
    }
    Ok(files)
}

/// `ls-files -u -z`의 "<mode> <sha> <stage>\t<path>\0" 레코드를 경로별로 모은다.
///
/// `-z`를 쓰는 이유는 경로에 개행이 들어갈 수 있어서다. 줄 단위로 읽으면 그런 경로에서
/// 목록이 통째로 어긋난다.
fn parse_unmerged(raw: &str) -> Vec<ConflictFile> {
    let mut order: Vec<String> = Vec::new();
    let mut stages: std::collections::HashMap<String, [bool; 3]> = std::collections::HashMap::new();

    for record in raw.split('\0') {
        if record.trim().is_empty() {
            continue;
        }
        let Some((meta, path)) = record.split_once('\t') else {
            continue;
        };
        let Some(stage) = meta
            .split_whitespace()
            .nth(2)
            .and_then(|s| s.parse::<usize>().ok())
        else {
            continue;
        };
        if !(1..=3).contains(&stage) {
            continue;
        }

        let path = path.to_string();
        if !order.contains(&path) {
            order.push(path.clone());
        }
        stages.entry(path).or_insert([false; 3])[stage - 1] = true;
    }

    order
        .into_iter()
        .map(|path| {
            let present = stages.get(&path).copied().unwrap_or([false; 3]);
            ConflictFile {
                kind: classify(present),
                path,
                // 파일을 읽는 것은 호출자가 채운다. 파싱은 순수 함수로 둔다.
                has_markers: false,
            }
        })
        .collect()
}

/// [base, ours, theirs] 존재 여부로 충돌 종류를 가른다.
fn classify(present: [bool; 3]) -> ConflictKind {
    match present {
        [true, true, true] => ConflictKind::BothModified,
        [false, true, true] => ConflictKind::BothAdded,
        [true, false, true] => ConflictKind::DeletedByUs,
        [true, true, false] => ConflictKind::DeletedByThem,
        // base만 남은 경우가 양쪽 삭제다. 나머지 조합은 git이 만들지 않는다.
        _ => ConflictKind::BothDeleted,
    }
}

/// 파일에 충돌 마커가 남아 있는지 본다. 바이너리나 삭제된 파일은 false다.
fn has_markers(repo: &str, relative: &str) -> bool {
    let full = std::path::Path::new(repo).join(relative);
    let Ok(text) = std::fs::read_to_string(full) else {
        return false;
    };
    let mut start = false;
    let mut end = false;
    for line in text.lines() {
        start |= line.starts_with(MARKER_START);
        end |= line.starts_with(MARKER_END);
    }
    start && end
}

/// 한쪽을 통째로 골라 해결한다. 고른 뒤 인덱스에 올려 "해결됨"까지 한 번에 끝낸다.
#[tauri::command]
pub fn git_resolve_with(path: String, file: String, side: String) -> Result<OpResult, String> {
    let flag = match side.as_str() {
        "ours" => "--ours",
        "theirs" => "--theirs",
        other => return Err(format!("알 수 없는 쪽입니다: {other}")),
    };
    let file = validate_paths(&[file])?.remove(0);

    run_chain(
        &path,
        &[
            vec!["checkout", flag, "--", file.as_str()],
            vec!["add", "--", file.as_str()],
        ],
        LOCAL_TIMEOUT,
    )
}

/// 손으로 고친 파일을 해결 완료로 표시한다.
#[tauri::command]
pub fn git_mark_resolved(path: String, files: Vec<String>) -> Result<OpResult, String> {
    let files = validate_paths(&files)?;
    let mut args: Vec<&str> = vec!["add", "--"];
    args.extend(files.iter().map(String::as_str));
    run_op(&path, &args, LOCAL_TIMEOUT)
}

/// 3-way 비교용 원문. 해당 스테이지가 없으면(그쪽이 지웠으면) 빈 문자열이다.
#[tauri::command]
pub fn get_conflict_side(path: String, file: String, side: String) -> Result<String, String> {
    let stage = match side.as_str() {
        "base" => "1",
        "ours" => "2",
        "theirs" => "3",
        other => return Err(format!("알 수 없는 쪽입니다: {other}")),
    };
    let file = validate_paths(&[file])?.remove(0);
    let spec = format!(":{stage}:{file}");

    Ok(git::run(&path, &["show", spec.as_str()]).unwrap_or_default())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testrepo::TempRepo;

    /// 내용 충돌 하나와 "한쪽이 지움" 충돌 하나를 동시에 만든다.
    fn conflicted(prefix: &str) -> TempRepo {
        let repo = TempRepo::init(prefix);
        repo.write("both.txt", "base\n");
        repo.write("gone.txt", "base\n");
        repo.git(&["add", "-A"]);
        repo.git(&["commit", "-qm", "base"]);

        repo.git(&["checkout", "-qb", "other"]);
        repo.write("both.txt", "other\n");
        repo.git(&["rm", "-q", "gone.txt"]);
        repo.git(&["add", "-A"]);
        repo.git(&["commit", "-qm", "other side"]);

        repo.git(&["checkout", "-q", "main"]);
        repo.write("both.txt", "main\n");
        repo.write("gone.txt", "main이 고침\n");
        repo.git(&["add", "-A"]);
        repo.git(&["commit", "-qm", "main side"]);

        let _ = std::process::Command::new("git")
            .current_dir(repo.path())
            .args(["merge", "--no-edit", "other"])
            .output()
            .unwrap();
        repo
    }

    #[test]
    fn 스테이지_조합으로_충돌_종류를_가른다() {
        assert_eq!(classify([true, true, true]), ConflictKind::BothModified);
        assert_eq!(classify([false, true, true]), ConflictKind::BothAdded);
        assert_eq!(classify([true, false, true]), ConflictKind::DeletedByUs);
        assert_eq!(classify([true, true, false]), ConflictKind::DeletedByThem);
        assert_eq!(classify([true, false, false]), ConflictKind::BothDeleted);
    }

    #[test]
    fn 충돌_목록이_종류와_마커를_담는다() {
        let repo = conflicted("gitlanes-conflict-list");
        let conflicts = get_conflicts(repo.path()).unwrap();

        let both = conflicts
            .iter()
            .find(|c| c.path == "both.txt")
            .expect("both.txt가 충돌이어야 한다");
        assert_eq!(both.kind, ConflictKind::BothModified);
        assert!(both.has_markers, "머지가 마커를 남긴다");

        let gone = conflicts
            .iter()
            .find(|c| c.path == "gone.txt")
            .expect("gone.txt가 충돌이어야 한다");
        assert_eq!(gone.kind, ConflictKind::DeletedByThem);
        assert!(!gone.has_markers, "삭제 충돌에는 마커가 없다");
    }

    #[test]
    fn 충돌이_없으면_빈_목록이다() {
        let repo = TempRepo::linear("gitlanes-conflict-none", 2);
        assert!(get_conflicts(repo.path()).unwrap().is_empty());
    }

    #[test]
    fn resolve_with가_한쪽을_골라_인덱스에_올린다() {
        let repo = conflicted("gitlanes-resolve");

        let result =
            git_resolve_with(repo.path(), "both.txt".to_string(), "theirs".to_string()).unwrap();
        assert!(result.ok, "{result:?}");
        assert_eq!(
            std::fs::read_to_string(std::path::Path::new(&repo.path()).join("both.txt")).unwrap(),
            "other\n"
        );

        let remaining = get_conflicts(repo.path()).unwrap();
        assert!(
            !remaining.iter().any(|c| c.path == "both.txt"),
            "{remaining:?}"
        );
    }

    #[test]
    fn resolve_with는_알_수_없는_쪽을_거부한다() {
        let repo = conflicted("gitlanes-resolve-bad");
        assert!(git_resolve_with(repo.path(), "both.txt".to_string(), "mine".to_string()).is_err());
        assert!(git_resolve_with(repo.path(), String::new(), "ours".to_string()).is_err());
    }

    #[test]
    fn mark_resolved가_손으로_고친_파일을_올린다() {
        let repo = conflicted("gitlanes-mark");
        repo.write("both.txt", "손으로 합침\n");

        let result = git_mark_resolved(repo.path(), vec!["both.txt".to_string()]).unwrap();
        assert!(result.ok, "{result:?}");
        assert!(!get_conflicts(repo.path())
            .unwrap()
            .iter()
            .any(|c| c.path == "both.txt"));

        assert!(git_mark_resolved(repo.path(), vec![]).is_err());
    }

    #[test]
    fn conflict_side가_세_원문을_돌려준다() {
        let repo = conflicted("gitlanes-side");

        assert_eq!(
            get_conflict_side(repo.path(), "both.txt".to_string(), "base".to_string()).unwrap(),
            "base\n"
        );
        assert_eq!(
            get_conflict_side(repo.path(), "both.txt".to_string(), "ours".to_string()).unwrap(),
            "main\n"
        );
        assert_eq!(
            get_conflict_side(repo.path(), "both.txt".to_string(), "theirs".to_string()).unwrap(),
            "other\n"
        );

        // 상대가 지운 파일은 theirs가 비어 있다
        assert_eq!(
            get_conflict_side(repo.path(), "gone.txt".to_string(), "theirs".to_string()).unwrap(),
            ""
        );
        assert!(
            get_conflict_side(repo.path(), "gone.txt".to_string(), "both".to_string()).is_err()
        );
    }
}
