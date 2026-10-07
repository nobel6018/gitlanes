//! 충돌 목록과 해결.
//!
//! @see CONTRACTS.md

use crate::git;
use crate::model::{ConflictFile, ConflictKind, OpResult};

use super::run::{execute, finish, op_command, run_op, validate_paths, LOCAL_TIMEOUT};

/// 충돌 시작과 끝 마커. 사용자가 손으로 지웠는지 보는 데 쓴다.
const MARKER_START: &str = "<<<<<<<";
const MARKER_END: &str = ">>>>>>>";

/// 충돌 파일 목록과 각 파일의 충돌 종류.
#[tauri::command(async)]
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
///
/// 고른 쪽이 파일을 지운 쪽이면(삭제/수정 충돌) 꺼낼 버전이 없어 checkout이
/// "does not have our version"으로 실패한다. 그때는 삭제를 받아들이는 `rm` 한 단계다.
#[tauri::command(async)]
pub fn git_resolve_with(path: String, file: String, side: String) -> Result<OpResult, String> {
    let flag = match side.as_str() {
        "ours" => "--ours",
        "theirs" => "--theirs",
        other => return Err(format!("알 수 없는 쪽입니다: {other}")),
    };
    let file = validate_paths(&[file])?.remove(0);

    let unmerged = parse_unmerged(&git::run(&path, &["ls-files", "-u", "-z"])?);
    let chosen_deleted = unmerged
        .iter()
        .find(|conflict| conflict.path == file)
        .is_some_and(|conflict| !has_side(conflict.kind, flag));
    if chosen_deleted {
        return run_op(&path, &["rm", "-q", "--", file.as_str()], LOCAL_TIMEOUT);
    }

    let checkout = checkout_side(&path, flag, &file)?;
    if !checkout.ok {
        return Ok(checkout);
    }
    let mut added = run_op(&path, &["add", "--", file.as_str()], LOCAL_TIMEOUT)?;
    if !checkout.stderr.trim().is_empty() {
        added.stderr = format!("{}\n{}", checkout.stderr.trim_end(), added.stderr);
    }
    Ok(added)
}

/// 충돌 종류에서 고른 쪽 스테이지가 남아 있는지 본다.
fn has_side(kind: ConflictKind, flag: &str) -> bool {
    match kind {
        ConflictKind::BothModified | ConflictKind::BothAdded => true,
        ConflictKind::DeletedByUs => flag == "--theirs",
        ConflictKind::DeletedByThem => flag == "--ours",
        ConflictKind::BothDeleted => false,
    }
}

/// `checkout --ours/--theirs`를 경로 리터럴로 실행하되 훅에는 `GIT_LITERAL_PATHSPECS`를
/// 물려주지 않는다.
///
/// checkout은 post-checkout 훅을 돌린다. 환경변수로 리터럴을 걸면 훅 안의
/// `git diff -- '*.py'` 같은 glob까지 리터럴이 되어 훅이 조용히 아무것도 못 찾는다.
/// 이 명령의 경로 하나에만 `:(literal)` magic을 붙이면 효과는 같고 훅은 그대로 돈다.
fn checkout_side(repo: &str, flag: &str, file: &str) -> Result<OpResult, String> {
    let spec = format!(":(literal){file}");
    let args = ["checkout", flag, "--", spec.as_str()];
    let mut command = op_command(repo, &args);
    command.env_remove("GIT_LITERAL_PATHSPECS");
    let outcome = execute(command, LOCAL_TIMEOUT)?;
    Ok(finish(repo, &args, outcome, LOCAL_TIMEOUT))
}

/// 손으로 고친 파일을 해결 완료로 표시한다.
#[tauri::command(async)]
pub fn git_mark_resolved(path: String, files: Vec<String>) -> Result<OpResult, String> {
    let files = validate_paths(&files)?;
    let mut args: Vec<&str> = vec!["add", "--"];
    args.extend(files.iter().map(String::as_str));
    run_op(&path, &args, LOCAL_TIMEOUT)
}

/// 3-way 비교용 원문. 해당 스테이지가 없으면(그쪽이 지웠으면) 빈 문자열이다.
#[tauri::command(async)]
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

    fn remaining(repo: &TempRepo) -> Vec<String> {
        get_conflicts(repo.path())
            .unwrap()
            .into_iter()
            .map(|c| c.path)
            .collect()
    }

    fn tracked(repo: &TempRepo, file: &str) -> bool {
        !git::run(repo.path(), &["ls-files", "--", file])
            .unwrap()
            .trim()
            .is_empty()
    }

    #[test]
    fn 상대가_지운_파일에서_theirs를_고르면_삭제로_해결된다() {
        let repo = conflicted("gitlanes-resolve-deleted-theirs");

        let result =
            git_resolve_with(repo.path(), "gone.txt".to_string(), "theirs".to_string()).unwrap();
        assert!(result.ok, "{result:?}");
        assert!(!remaining(&repo).contains(&"gone.txt".to_string()));
        assert!(!tracked(&repo, "gone.txt"));
        assert!(!std::path::Path::new(&repo.path()).join("gone.txt").exists());
    }

    #[test]
    fn 내가_지운_파일에서_ours를_고르면_삭제로_해결된다() {
        let repo = TempRepo::init("gitlanes-resolve-deleted-ours");
        repo.write("gone.txt", "base\n");
        repo.git(&["add", "-A"]);
        repo.git(&["commit", "-qm", "base"]);
        repo.git(&["checkout", "-qb", "other"]);
        repo.write("gone.txt", "other가 고침\n");
        repo.git(&["commit", "-qam", "other side"]);
        repo.git(&["checkout", "-q", "main"]);
        repo.git(&["rm", "-q", "gone.txt"]);
        repo.git(&["commit", "-qm", "main이 지움"]);
        let _ = std::process::Command::new("git")
            .current_dir(repo.path())
            .args(["merge", "--no-edit", "other"])
            .output()
            .unwrap();
        assert_eq!(
            get_conflicts(repo.path()).unwrap()[0].kind,
            ConflictKind::DeletedByUs
        );

        let result =
            git_resolve_with(repo.path(), "gone.txt".to_string(), "ours".to_string()).unwrap();
        assert!(result.ok, "{result:?}");
        assert!(remaining(&repo).is_empty());
        assert!(!tracked(&repo, "gone.txt"));
    }

    #[test]
    fn 지운_쪽이_아니면_그쪽_내용으로_해결된다() {
        // 삭제/수정 충돌에서 남아 있는 쪽을 고르면 지금처럼 checkout이다
        let repo = conflicted("gitlanes-resolve-deleted-keep");

        let result =
            git_resolve_with(repo.path(), "gone.txt".to_string(), "ours".to_string()).unwrap();
        assert!(result.ok, "{result:?}");
        assert!(tracked(&repo, "gone.txt"));
        assert_eq!(
            std::fs::read_to_string(std::path::Path::new(&repo.path()).join("gone.txt")).unwrap(),
            "main이 고침\n"
        );
    }

    /// glob 문자가 든 파일과, 그 glob에 걸리는 다른 파일이 함께 충돌하는 저장소.
    fn glob_conflicted(prefix: &str) -> TempRepo {
        let repo = TempRepo::init(prefix);
        for name in ["f*.txt", "fx.txt"] {
            repo.write(name, "base\n");
        }
        repo.git(&["add", "-A"]);
        repo.git(&["commit", "-qm", "base"]);
        repo.git(&["checkout", "-qb", "other"]);
        for name in ["f*.txt", "fx.txt"] {
            repo.write(name, "other\n");
        }
        repo.git(&["commit", "-qam", "other side"]);
        repo.git(&["checkout", "-q", "main"]);
        for name in ["f*.txt", "fx.txt"] {
            repo.write(name, "main\n");
        }
        repo.git(&["commit", "-qam", "main side"]);
        let _ = std::process::Command::new("git")
            .current_dir(repo.path())
            .args(["merge", "--no-edit", "other"])
            .output()
            .unwrap();
        repo
    }

    #[test]
    fn resolve_with는_glob_문자_파일명을_리터럴로_다룬다() {
        let repo = glob_conflicted("gitlanes-resolve-glob");

        let result =
            git_resolve_with(repo.path(), "f*.txt".to_string(), "theirs".to_string()).unwrap();
        assert!(result.ok, "{result:?}");

        let root = std::path::Path::new(&repo.path()).to_path_buf();
        assert_eq!(
            std::fs::read_to_string(root.join("f*.txt")).unwrap(),
            "other\n"
        );
        // glob으로 해석되면 fx.txt까지 theirs로 덮인다
        assert_eq!(remaining(&repo), ["fx.txt"]);
        assert!(has_markers(&repo.path(), "fx.txt"));
    }

    #[cfg(unix)]
    #[test]
    fn resolve_with의_checkout은_훅에_리터럴_pathspec을_물려주지_않는다() {
        use std::os::unix::fs::PermissionsExt;

        let repo = conflicted("gitlanes-resolve-hook");
        let seen = std::path::Path::new(&repo.path())
            .join(".git")
            .join("seen-env");
        let hook = std::path::Path::new(&repo.path())
            .join(".git")
            .join("hooks")
            .join("post-checkout");
        std::fs::create_dir_all(hook.parent().unwrap()).unwrap();
        std::fs::write(
            &hook,
            format!(
                "#!/bin/sh\necho \"${{GIT_LITERAL_PATHSPECS:-unset}}\" > '{}'\n",
                seen.display()
            ),
        )
        .unwrap();
        std::fs::set_permissions(&hook, std::fs::Permissions::from_mode(0o755)).unwrap();

        let result =
            git_resolve_with(repo.path(), "both.txt".to_string(), "theirs".to_string()).unwrap();
        assert!(result.ok, "{result:?}");

        // 훅 안의 `git diff -- '*.py'` 같은 glob이 리터럴로 바뀌지 않아야 한다
        assert_eq!(std::fs::read_to_string(&seen).unwrap().trim(), "unset");
    }
}
