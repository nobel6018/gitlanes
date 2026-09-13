//! 스태시. 목록 참조는 `stash@{N}` 형태로만 받는다.
//!
//! @see CONTRACTS.md

use crate::model::OpResult;

use super::run::{run_op, validate_paths, validate_ref_name, LOCAL_TIMEOUT};

/// `files`가 있으면 그 경로만 스태시한다(부분 스태시).
#[tauri::command]
pub fn git_stash_push(
    path: String,
    message: Option<String>,
    include_untracked: bool,
    keep_index: bool,
    files: Option<Vec<String>>,
) -> Result<OpResult, String> {
    let message = message
        .as_deref()
        .map(str::trim)
        .filter(|message| !message.is_empty());
    let files = match files.filter(|files| !files.is_empty()) {
        Some(files) => Some(validate_paths(&files)?),
        None => None,
    };

    let mut args: Vec<&str> = vec!["stash", "push"];
    if include_untracked {
        args.push("--include-untracked");
    }
    if keep_index {
        args.push("--keep-index");
    }
    // -m이 다음 인자를 값으로 먹으므로 메시지가 "-"로 시작해도 옵션이 되지 않는다
    if let Some(message) = message {
        args.push("-m");
        args.push(message);
    }
    if let Some(files) = files.as_ref() {
        args.push("--");
        args.extend(files.iter().map(String::as_str));
    }

    run_op(&path, &args, LOCAL_TIMEOUT)
}

/// `drop=true`가 pop이다. 충돌하면 `conflicts`가 채워지고 스태시는 남는다.
#[tauri::command]
pub fn git_stash_apply(path: String, reference: String, drop: bool) -> Result<OpResult, String> {
    let reference = validate_stash_ref(&reference)?;
    let verb = if drop { "pop" } else { "apply" };
    run_op(&path, &["stash", verb, reference.as_str()], LOCAL_TIMEOUT)
}

#[tauri::command]
pub fn git_stash_drop(path: String, reference: String) -> Result<OpResult, String> {
    let reference = validate_stash_ref(&reference)?;
    run_op(&path, &["stash", "drop", reference.as_str()], LOCAL_TIMEOUT)
}

/// 스태시를 새 브랜치로 꺼낸다. 스태시를 만든 시점의 커밋에서 갈라져 나오므로 충돌이 없다.
#[tauri::command]
pub fn git_stash_branch(path: String, reference: String, name: String) -> Result<OpResult, String> {
    let reference = validate_stash_ref(&reference)?;
    let name = validate_ref_name(&path, &name)?;
    run_op(
        &path,
        &["stash", "branch", name.as_str(), reference.as_str()],
        LOCAL_TIMEOUT,
    )
}

/// `stash@{N}` 형태만 받는다.
///
/// 여기는 `check-ref-format`을 쓰지 않는다. `stash@{0}`은 브랜치 이름 규칙에서 `@{`가
/// 금지라 무조건 거부당한다. 형태가 좁고 고정이라 직접 본다.
fn validate_stash_ref(reference: &str) -> Result<String, String> {
    let reference = reference.trim();
    if reference.is_empty() {
        return Err("스태시 참조가 비어 있습니다".to_string());
    }

    let index = reference
        .strip_prefix("stash@{")
        .and_then(|rest| rest.strip_suffix('}'))
        .ok_or_else(|| format!("스태시 참조 형식이 올바르지 않습니다: {reference}"))?;

    if index.is_empty() || !index.bytes().all(|byte| byte.is_ascii_digit()) {
        return Err(format!("스태시 참조 형식이 올바르지 않습니다: {reference}"));
    }
    Ok(reference.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ops::network::tests_support::{exists, remote_fixture};
    use crate::ops::sync::get_sync_state;

    fn stash_count(repo: &crate::testrepo::TempRepo) -> u32 {
        get_sync_state(repo.path()).unwrap().stash_count
    }

    #[test]
    fn stash_push와_pop이_왕복한다() {
        let (_origin, repo) = remote_fixture();
        repo.write("a.txt", "changed\n");
        repo.write("fresh.txt", "new\n");

        let pushed =
            git_stash_push(repo.path(), Some("작업 중".to_string()), true, false, None).unwrap();
        assert!(pushed.ok, "{pushed:?}");
        assert_eq!(stash_count(&repo), 1);
        assert!(!exists(&repo, "fresh.txt"), "untracked도 스태시로 들어간다");

        let popped = git_stash_apply(repo.path(), "stash@{0}".to_string(), true).unwrap();
        assert!(popped.ok, "{popped:?}");
        assert_eq!(stash_count(&repo), 0);
        assert!(exists(&repo, "fresh.txt"));
    }

    #[test]
    fn apply는_스태시를_남기고_pop은_없앤다() {
        let (_origin, repo) = remote_fixture();
        repo.write("a.txt", "changed\n");
        assert!(
            git_stash_push(repo.path(), None, false, false, None)
                .unwrap()
                .ok
        );

        let applied = git_stash_apply(repo.path(), "stash@{0}".to_string(), false).unwrap();
        assert!(applied.ok, "{applied:?}");
        assert_eq!(stash_count(&repo), 1, "apply는 목록을 건드리지 않는다");

        let dropped = git_stash_drop(repo.path(), "stash@{0}".to_string()).unwrap();
        assert!(dropped.ok, "{dropped:?}");
        assert_eq!(stash_count(&repo), 0);
    }

    #[test]
    fn 파일을_지정하면_그것만_스태시한다() {
        let (_origin, repo) = remote_fixture();
        repo.write("a.txt", "changed\n");
        repo.write("b.txt", "b\n");
        repo.git(&["add", "-A"]);
        repo.git(&["commit", "-qm", "b 추가"]);
        repo.write("a.txt", "again\n");
        repo.write("b.txt", "b 수정\n");

        let result = git_stash_push(
            repo.path(),
            None,
            false,
            false,
            Some(vec!["a.txt".to_string()]),
        )
        .unwrap();
        assert!(result.ok, "{result:?}");

        let dirty = crate::git::run(repo.path(), &["status", "--porcelain"]).unwrap();
        assert!(dirty.contains("b.txt"), "b.txt는 남아야 한다: {dirty}");
        assert!(
            !dirty.contains("a.txt"),
            "a.txt는 스태시로 갔어야 한다: {dirty}"
        );
    }

    #[test]
    fn keep_index는_스테이지된_것을_인덱스에_남긴다() {
        let (_origin, repo) = remote_fixture();
        repo.write("a.txt", "staged\n");
        repo.git(&["add", "-A"]);

        let result = git_stash_push(repo.path(), None, false, true, None).unwrap();
        assert!(result.ok, "{result:?}");
        assert!(result.command.contains(&"--keep-index".to_string()));

        let staged = crate::git::run(repo.path(), &["diff", "--cached", "--name-only"]).unwrap();
        assert_eq!(staged.trim(), "a.txt");
    }

    #[test]
    fn 스태시가_없으면_pop이_ok_false다() {
        let (_origin, repo) = remote_fixture();
        let result = git_stash_apply(repo.path(), "stash@{0}".to_string(), true).unwrap();
        assert!(!result.ok, "{result:?}");
        assert!(!result.stderr.is_empty(), "{result:?}");
    }

    #[test]
    fn 스태시_참조_형식을_검증한다() {
        let (_origin, repo) = remote_fixture();
        for bad in [
            "",
            "stash",
            "stash@{}",
            "stash@{a}",
            "-x",
            "HEAD",
            "stash@{0",
        ] {
            assert!(
                git_stash_apply(repo.path(), bad.to_string(), false).is_err(),
                "허용하면 안 되는 참조: {bad:?}"
            );
        }
        assert!(git_stash_drop(repo.path(), "refs/stash".to_string()).is_err());
    }

    #[test]
    fn stash_branch가_새_브랜치로_꺼낸다() {
        let (_origin, repo) = remote_fixture();
        repo.write("a.txt", "changed\n");
        assert!(
            git_stash_push(repo.path(), None, false, false, None)
                .unwrap()
                .ok
        );

        let result = git_stash_branch(
            repo.path(),
            "stash@{0}".to_string(),
            "from-stash".to_string(),
        )
        .unwrap();
        assert!(result.ok, "{result:?}");
        assert_eq!(
            crate::ops::run::current_branch(&repo.path()).as_deref(),
            Some("from-stash")
        );
        assert_eq!(stash_count(&repo), 0, "성공하면 스태시가 사라진다");

        assert!(git_stash_branch(repo.path(), "stash@{0}".to_string(), "-x".to_string()).is_err());
    }
}
