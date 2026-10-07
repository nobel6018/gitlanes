//! 스태시. 목록 참조는 `stash@{N}` 형태로만 받는다.
//!
//! @see CONTRACTS.md

use crate::model::OpResult;

use super::run::{finish, run_op, validate_paths, validate_ref_name, Outcome, LOCAL_TIMEOUT};

/// `files`가 있으면 그 경로만 스태시한다(부분 스태시).
#[tauri::command(async)]
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
#[tauri::command(async)]
pub fn git_stash_apply(
    path: String,
    r#ref: String,
    sha: Option<String>,
    drop: bool,
) -> Result<OpResult, String> {
    let reference = validate_stash_ref(&r#ref)?;
    if let Some(moved) = stash_moved(&path, &reference, sha.as_deref()) {
        return Ok(moved);
    }
    let verb = if drop { "pop" } else { "apply" };
    run_op(&path, &["stash", verb, reference.as_str()], LOCAL_TIMEOUT)
}

#[tauri::command(async)]
pub fn git_stash_drop(
    path: String,
    r#ref: String,
    sha: Option<String>,
) -> Result<OpResult, String> {
    let reference = validate_stash_ref(&r#ref)?;
    if let Some(moved) = stash_moved(&path, &reference, sha.as_deref()) {
        return Ok(moved);
    }
    run_op(&path, &["stash", "drop", reference.as_str()], LOCAL_TIMEOUT)
}

/// 스태시를 새 브랜치로 꺼낸다. 스태시를 만든 시점의 커밋에서 갈라져 나오므로 충돌이 없다.
#[tauri::command(async)]
pub fn git_stash_branch(
    path: String,
    r#ref: String,
    sha: Option<String>,
    name: String,
) -> Result<OpResult, String> {
    let reference = validate_stash_ref(&r#ref)?;
    let name = validate_ref_name(&path, &name)?;
    if let Some(moved) = stash_moved(&path, &reference, sha.as_deref()) {
        return Ok(moved);
    }
    run_op(
        &path,
        &["stash", "branch", name.as_str(), reference.as_str()],
        LOCAL_TIMEOUT,
    )
}

/// 화면이 읽은 sha와 지금 `reference`가 가리키는 스태시가 다르면 실패 결과를 돌려준다.
///
/// `stash@{N}`은 번호라서 터미널이나 다른 창에서 스태시를 만들거나 지우면 다른 스태시를
/// 가리키게 된다. 사용자가 고른 것과 다른 스태시를 drop하면 되돌리기 어렵다(dangling 커밋을
/// fsck로 찾아야 한다). `sha`가 없으면 예전처럼 번호만 믿는다.
///
/// 확인과 실행 사이의 짧은 틈은 남는다. git stash에 "이 sha일 때만" 같은 조건부 실행이 없다.
///
/// 결과의 `command`는 실행하지 않은 `stash drop`이 아니라 `stash list`다. 프론트가
/// command를 터미널로 넘겨 다시 실행하게 하므로, 거기에 번호가 밀린 명령을 실으면 같은 사고가
/// 터미널에서 일어난다. OpResult를 직접 만들지 않고 [`finish`]를 거쳐 필드 추가에 흔들리지 않게 한다.
fn stash_moved(repo: &str, reference: &str, sha: Option<&str>) -> Option<OpResult> {
    let expected = sha?.trim();
    let actual = crate::git::run(repo, &["rev-parse", "--verify", "-q", reference])
        .map(|out| out.trim().to_string())
        .unwrap_or_default();
    if !actual.is_empty() && actual.eq_ignore_ascii_case(expected) {
        return None;
    }
    let outcome = Outcome {
        code: Some(1),
        stdout: String::new(),
        stderr: "The stash list changed since it was loaded. Refresh and try again.".to_string(),
        timed_out: false,
    };
    Some(finish(repo, &["stash", "list"], outcome, LOCAL_TIMEOUT))
}

/// `stash@{N}` 형태만 받는다.
///
/// 인자 이름이 `r#ref`인 이유는 계약(`types.ts`)이 `ref`로 못 박았기 때문이다. Rust
/// 예약어라 raw 식별자를 쓰는데, tauri가 인자 이름에서 `r#`를 떼고 camelCase로 바꾸므로
/// 프론트에는 그대로 `ref`로 보인다.
///
/// 여기는 `check-ref-format`을 쓰지 않는다. `stash@{0}`은 브랜치 이름 규칙에서 `@{`가
/// 금지라 무조건 거부당한다. 형태가 좁고 고정이라 직접 본다.
fn validate_stash_ref(reference: &str) -> Result<String, String> {
    let reference = reference.trim();
    if reference.is_empty() {
        return Err("No stash was given.".to_string());
    }

    let index = reference
        .strip_prefix("stash@{")
        .and_then(|rest| rest.strip_suffix('}'))
        .ok_or_else(|| format!("Invalid stash reference: {reference}"))?;

    if index.is_empty() || !index.bytes().all(|byte| byte.is_ascii_digit()) {
        return Err(format!("Invalid stash reference: {reference}"));
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

    // Windows는 파일명에 `*`를 쓸 수 없어 이 파일을 만들 수조차 없다. 그러니 별표가 glob으로
    // 풀리는 사고도 Windows에서는 일어나지 않는다. 같은 수정(GIT_LITERAL_PATHSPECS)은 Windows에서도
    // 쓸 수 있는 `[` 이름 테스트(`data[1].csv`, `pages/[id].tsx`)가 지킨다.
    #[cfg(not(windows))]
    #[test]
    fn 부분_스태시는_별표_이름을_glob으로_풀지_않는다() {
        let (_origin, repo) = remote_fixture();
        repo.write("note*", "넣을 파일\n");
        repo.write("note_draft.txt", "남겨야 할 초안\n");

        let pushed = git_stash_push(
            repo.path(),
            None,
            true,
            false,
            Some(vec!["note*".to_string()]),
        )
        .unwrap();
        assert!(pushed.ok, "{pushed:?}");
        assert!(!exists(&repo, "note*"));
        assert!(
            exists(&repo, "note_draft.txt"),
            "glob note*에 걸린 파일까지 스태시로 들어갔다"
        );
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

        let popped = git_stash_apply(repo.path(), "stash@{0}".to_string(), None, true).unwrap();
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

        let applied = git_stash_apply(repo.path(), "stash@{0}".to_string(), None, false).unwrap();
        assert!(applied.ok, "{applied:?}");
        assert_eq!(stash_count(&repo), 1, "apply는 목록을 건드리지 않는다");

        let dropped = git_stash_drop(repo.path(), "stash@{0}".to_string(), None).unwrap();
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
        let result = git_stash_apply(repo.path(), "stash@{0}".to_string(), None, true).unwrap();
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
                git_stash_apply(repo.path(), bad.to_string(), None, false).is_err(),
                "허용하면 안 되는 참조: {bad:?}"
            );
        }
        assert!(git_stash_drop(repo.path(), "refs/stash".to_string(), None).is_err());
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
            None,
            "from-stash".to_string(),
        )
        .unwrap();
        assert!(result.ok, "{result:?}");
        assert_eq!(
            crate::ops::run::current_branch(&repo.path()).as_deref(),
            Some("from-stash")
        );
        assert_eq!(stash_count(&repo), 0, "성공하면 스태시가 사라진다");

        assert!(
            git_stash_branch(repo.path(), "stash@{0}".to_string(), None, "-x".to_string()).is_err()
        );
    }

    fn stash_messages(repo: &crate::testrepo::TempRepo) -> Vec<String> {
        crate::ops::run::lines_of(
            &crate::git::run(repo.path(), &["stash", "list", "--format=%s"]).unwrap(),
        )
    }

    /// 스태시 둘(`first`, `second`)을 만든다. 목록 순서는 최신이 0번이다.
    fn two_stashes() -> (crate::testrepo::TempRepo, crate::testrepo::TempRepo) {
        let (origin, repo) = remote_fixture();
        for message in ["first", "second"] {
            repo.write("a.txt", &format!("{message}\n"));
            let pushed =
                git_stash_push(repo.path(), Some(message.to_string()), false, false, None).unwrap();
            assert!(pushed.ok, "{pushed:?}");
        }
        (origin, repo)
    }

    /// R-L10. 사이드바가 `stash@{1}: first`를 보여 주는 동안 터미널에서 스태시를 하나 더 만들면
    /// 번호가 밀려 `stash@{1}`은 `second`가 된다. 화면에서 고른 sha가 같이 오면 거절해야 한다.
    #[test]
    fn 번호가_밀린_스태시는_sha가_달라_drop하지_않는다() {
        let (_origin, repo) = two_stashes();
        let loaded_ref = "stash@{1}".to_string();
        let loaded_sha = repo.rev("stash@{1}");

        repo.write("a.txt", "from terminal\n");
        repo.git(&["stash", "push", "-q", "-m", "terminal"]);
        let before = stash_messages(&repo);
        assert_eq!(before.len(), 3);

        let dropped =
            git_stash_drop(repo.path(), loaded_ref.clone(), Some(loaded_sha.clone())).unwrap();
        assert!(!dropped.ok, "엉뚱한 스태시를 지웠다: {dropped:?}");
        assert!(dropped.stderr.contains("Refresh"), "{dropped:?}");
        assert_eq!(stash_messages(&repo), before, "스태시 목록이 바뀌었다");

        let applied = git_stash_apply(
            repo.path(),
            loaded_ref.clone(),
            Some(loaded_sha.clone()),
            true,
        )
        .unwrap();
        assert!(!applied.ok, "{applied:?}");
        let branched = git_stash_branch(
            repo.path(),
            loaded_ref,
            Some(loaded_sha),
            "from-stash".to_string(),
        )
        .unwrap();
        assert!(!branched.ok, "{branched:?}");
        assert_eq!(stash_messages(&repo), before);
        assert_eq!(
            crate::ops::run::current_branch(&repo.path()).as_deref(),
            Some("main")
        );
    }

    #[test]
    fn sha가_맞으면_그_스태시를_drop한다() {
        let (_origin, repo) = two_stashes();
        let sha = repo.rev("stash@{1}");

        let dropped = git_stash_drop(repo.path(), "stash@{1}".to_string(), Some(sha)).unwrap();
        assert!(dropped.ok, "{dropped:?}");
        assert_eq!(stash_messages(&repo).len(), 1);
        assert!(stash_messages(&repo)[0].ends_with("second"));
    }
}
