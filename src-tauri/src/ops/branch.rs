//! 브랜치 생성, 체크아웃, 삭제, 이름 변경, upstream 설정.
//!
//! @see CONTRACTS.md

use crate::model::OpResult;

use super::run::{
    current_branch, local_branch_exists, remotes, run_op, validate_commitish, validate_ref_name,
    validate_remote, LOCAL_TIMEOUT, NETWORK_TIMEOUT,
};

/// 로컬 브랜치 이름이나 `origin/x` 형태를 받는다.
///
/// `create_local`은 원격 브랜치를 눌렀을 때만 의미가 있다. 켜면 같은 이름의 추적
/// 브랜치를 만들어 옮기고, 끄면 그 커밋으로 detached HEAD가 된다.
#[tauri::command]
pub fn git_checkout(path: String, target: String, create_local: bool) -> Result<OpResult, String> {
    let target = validate_ref_name(&path, &target)?;

    // "origin/x"에서 origin이 실제 remote일 때만 원격 브랜치로 본다.
    // 로컬에 "feature/x" 같은 슬래시 이름이 있으면 그건 그대로 로컬 체크아웃이다.
    if create_local {
        if let Some((remote, rest)) = target.split_once('/') {
            if !rest.is_empty() && remotes(&path).iter().any(|known| known == remote) {
                // 두 번째부터는 추적 브랜치가 이미 있으니 그냥 옮긴다
                if local_branch_exists(&path, rest) {
                    return run_op(&path, &["checkout", rest], LOCAL_TIMEOUT);
                }
                return run_op(
                    &path,
                    &["checkout", "--track", target.as_str()],
                    LOCAL_TIMEOUT,
                );
            }
        }
    }

    // create_local이 꺼져 있으면 가리키는 것을 그대로 체크아웃한다.
    // 원격 ref나 sha면 detached HEAD가 되고, 그게 호출자가 고른 동작이다.
    run_op(&path, &["checkout", target.as_str()], LOCAL_TIMEOUT)
}

#[tauri::command]
pub fn git_create_branch(
    path: String,
    name: String,
    start_point: Option<String>,
    checkout: bool,
) -> Result<OpResult, String> {
    let name = validate_ref_name(&path, &name)?;
    let start = match start_point
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        // 그래프에서 커밋 위에 놓아 만드는 경로가 있어 sha도 받아야 한다
        Some(start) => Some(validate_commitish(&path, start)?),
        None => None,
    };

    let mut args: Vec<&str> = if checkout {
        vec!["checkout", "-b", name.as_str()]
    } else {
        vec!["branch", name.as_str()]
    };
    if let Some(start) = start.as_deref() {
        args.push(start);
    }

    run_op(&path, &args, LOCAL_TIMEOUT)
}

/// `remote=false`면 로컬 브랜치, `true`면 `origin/foo` 형태를 받아 원격에서 지운다.
#[tauri::command]
pub fn git_delete_branch(
    path: String,
    name: String,
    force: bool,
    remote: bool,
) -> Result<OpResult, String> {
    if remote {
        let (remote_name, branch) = split_remote_ref(&path, &name)?;
        // 원격 삭제에는 force 개념이 없다. 있는 그대로 지운다.
        return run_op(
            &path,
            &["push", remote_name.as_str(), "--delete", branch.as_str()],
            NETWORK_TIMEOUT,
        );
    }

    let name = validate_ref_name(&path, &name)?;
    if current_branch(&path).as_deref() == Some(name.as_str()) {
        return Err(format!(
            "현재 체크아웃된 브랜치는 삭제할 수 없습니다: {name}"
        ));
    }

    let flag = if force { "-D" } else { "-d" };
    run_op(&path, &["branch", flag, name.as_str()], LOCAL_TIMEOUT)
}

/// "origin/feature/x"를 ("origin", "feature/x")로 가른다. remote 이름은 등록된 것이어야 한다.
fn split_remote_ref(repo: &str, name: &str) -> Result<(String, String), String> {
    let name = validate_ref_name(repo, name)?;
    let (remote, branch) = name
        .split_once('/')
        .ok_or_else(|| format!("원격 브랜치 형태가 아닙니다: {name}"))?;
    if branch.is_empty() {
        return Err(format!("원격 브랜치 형태가 아닙니다: {name}"));
    }
    let remote = validate_remote(repo, remote)?;
    Ok((remote, branch.to_string()))
}

#[tauri::command]
pub fn git_rename_branch(path: String, from: String, to: String) -> Result<OpResult, String> {
    let from = validate_ref_name(&path, &from)?;
    let to = validate_ref_name(&path, &to)?;
    run_op(
        &path,
        &["branch", "-m", from.as_str(), to.as_str()],
        LOCAL_TIMEOUT,
    )
}

/// `upstream`이 None이면 추적을 끊는다.
#[tauri::command]
pub fn git_set_upstream(
    path: String,
    branch: String,
    upstream: Option<String>,
) -> Result<OpResult, String> {
    let branch = validate_ref_name(&path, &branch)?;

    let Some(upstream) = upstream
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    else {
        return run_op(
            &path,
            &["branch", "--unset-upstream", branch.as_str()],
            LOCAL_TIMEOUT,
        );
    };

    let upstream = validate_ref_name(&path, upstream)?;
    let flag = format!("--set-upstream-to={upstream}");
    run_op(
        &path,
        &["branch", flag.as_str(), branch.as_str()],
        LOCAL_TIMEOUT,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ops::network::tests_support::{push_remote_commit, remote_fixture};
    use crate::ops::sync::get_sync_state;
    use crate::testrepo::TempRepo;

    #[test]
    fn checkout은_로컬_브랜치로_옮긴다() {
        let (_origin, repo) = remote_fixture();
        repo.git(&["branch", "topic"]);

        let result = git_checkout(repo.path(), "topic".to_string(), false).unwrap();
        assert!(result.ok, "{result:?}");
        assert_eq!(current_branch(&repo.path()).as_deref(), Some("topic"));
    }

    #[test]
    fn checkout은_원격_브랜치를_추적_생성하고_두_번째부터는_그냥_옮긴다() {
        let (origin, repo) = remote_fixture();
        let other = TempRepo::clone_of("gitlanes-other", &origin.path());
        other.git(&["checkout", "-qb", "topic"]);
        other.write("t.txt", "t\n");
        other.git(&["add", "-A"]);
        other.git(&["commit", "-qm", "topic work"]);
        other.git(&["push", "-q", "origin", "topic"]);

        assert!(
            crate::ops::network::git_fetch(repo.path(), None, false, true, false)
                .unwrap()
                .ok
        );

        let created = git_checkout(repo.path(), "origin/topic".to_string(), true).unwrap();
        assert!(created.ok, "{created:?}");
        assert_eq!(current_branch(&repo.path()).as_deref(), Some("topic"));
        assert_eq!(
            get_sync_state(repo.path()).unwrap().upstream.as_deref(),
            Some("origin/topic")
        );

        assert!(
            git_checkout(repo.path(), "main".to_string(), true)
                .unwrap()
                .ok
        );
        // 로컬 topic이 이미 있으니 --track 경로를 타지 않는다
        let again = git_checkout(repo.path(), "origin/topic".to_string(), true).unwrap();
        assert!(again.ok, "{again:?}");
        assert_eq!(current_branch(&repo.path()).as_deref(), Some("topic"));
    }

    #[test]
    fn create_local이_꺼지면_원격_브랜치는_detached로_간다() {
        let (origin, repo) = remote_fixture();
        push_remote_commit(&origin, "remote work");
        assert!(
            crate::ops::network::git_fetch(repo.path(), None, false, true, false)
                .unwrap()
                .ok
        );

        let result = git_checkout(repo.path(), "origin/main".to_string(), false).unwrap();
        assert!(result.ok, "{result:?}");
        assert_eq!(current_branch(&repo.path()), None, "detached HEAD여야 한다");
    }

    #[test]
    fn create_branch는_checkout_여부를_따른다() {
        let (_origin, repo) = remote_fixture();

        let stay = git_create_branch(repo.path(), "keep-here".to_string(), None, false).unwrap();
        assert!(stay.ok, "{stay:?}");
        assert_eq!(current_branch(&repo.path()).as_deref(), Some("main"));
        assert!(local_branch_exists(&repo.path(), "keep-here"));

        let moved = git_create_branch(
            repo.path(),
            "go-there".to_string(),
            Some("main".to_string()),
            true,
        )
        .unwrap();
        assert!(moved.ok, "{moved:?}");
        assert_eq!(current_branch(&repo.path()).as_deref(), Some("go-there"));
    }

    #[test]
    fn create_branch의_start_point는_sha도_받는다() {
        let repo = TempRepo::linear("gitlanes-branch-sha", 3);
        let older = repo.rev("HEAD~2");

        let result = git_create_branch(
            repo.path(),
            "from-sha".to_string(),
            Some(older.clone()),
            false,
        )
        .unwrap();
        assert!(result.ok, "{result:?}");
        assert_eq!(repo.rev("from-sha"), older);
    }

    #[test]
    fn 현재_브랜치_삭제는_호출_오류다() {
        let (_origin, repo) = remote_fixture();
        let error = git_delete_branch(repo.path(), "main".to_string(), false, false).unwrap_err();
        assert!(error.contains("현재"), "{error}");
    }

    #[test]
    fn 미머지_브랜치는_force_없이_지워지지_않는다() {
        let (_origin, repo) = remote_fixture();
        repo.git(&["checkout", "-qb", "unmerged"]);
        repo.write("u.txt", "u\n");
        repo.git(&["add", "-A"]);
        repo.git(&["commit", "-qm", "unmerged work"]);
        repo.git(&["checkout", "-q", "main"]);

        let refused = git_delete_branch(repo.path(), "unmerged".to_string(), false, false).unwrap();
        assert!(!refused.ok, "{refused:?}");
        assert!(local_branch_exists(&repo.path(), "unmerged"));

        let forced = git_delete_branch(repo.path(), "unmerged".to_string(), true, false).unwrap();
        assert!(forced.ok, "{forced:?}");
        assert!(!local_branch_exists(&repo.path(), "unmerged"));
    }

    #[test]
    fn 원격_브랜치_삭제는_push_delete로_간다() {
        let (origin, repo) = remote_fixture();
        repo.git(&["checkout", "-qb", "throwaway"]);
        repo.git(&["push", "-q", "origin", "throwaway"]);
        repo.git(&["checkout", "-q", "main"]);

        let result =
            git_delete_branch(repo.path(), "origin/throwaway".to_string(), false, true).unwrap();
        assert!(result.ok, "{result:?}");
        assert_eq!(result.command[0], "push");
        assert!(result.command.contains(&"--delete".to_string()));

        let remaining = crate::git::run(origin.path(), &["branch", "--list", "throwaway"]).unwrap();
        assert!(remaining.trim().is_empty(), "{remaining}");
    }

    #[test]
    fn 원격_삭제는_등록되지_않은_remote를_거부한다() {
        let (_origin, repo) = remote_fixture();
        assert!(git_delete_branch(repo.path(), "nope/x".to_string(), false, true).is_err());
        // remote 이름만 있고 브랜치가 없는 형태도 거부한다
        assert!(git_delete_branch(repo.path(), "origin".to_string(), false, true).is_err());
    }

    #[test]
    fn rename_branch가_이름을_바꾼다() {
        let (_origin, repo) = remote_fixture();
        repo.git(&["branch", "old-name"]);

        let result =
            git_rename_branch(repo.path(), "old-name".to_string(), "new-name".to_string()).unwrap();
        assert!(result.ok, "{result:?}");
        assert!(!local_branch_exists(&repo.path(), "old-name"));
        assert!(local_branch_exists(&repo.path(), "new-name"));
    }

    #[test]
    fn rename_branch는_없는_브랜치에서_ok_false다() {
        let (_origin, repo) = remote_fixture();
        let result =
            git_rename_branch(repo.path(), "없다".to_string(), "새이름".to_string()).unwrap();
        assert!(!result.ok, "{result:?}");
        assert!(git_rename_branch(repo.path(), "a b".to_string(), "c".to_string()).is_err());
    }

    #[test]
    fn set_upstream이_추적을_걸고_끊는다() {
        let (_origin, repo) = remote_fixture();
        repo.git(&["checkout", "-qb", "tracked"]);

        let unset = git_set_upstream(repo.path(), "tracked".to_string(), None).unwrap();
        // 원래 추적이 없으니 git이 거절한다. 오류가 아니라 결과로 돌아온다.
        assert!(!unset.ok, "{unset:?}");

        let set = git_set_upstream(
            repo.path(),
            "tracked".to_string(),
            Some("origin/main".to_string()),
        )
        .unwrap();
        assert!(set.ok, "{set:?}");
        assert_eq!(
            get_sync_state(repo.path()).unwrap().upstream.as_deref(),
            Some("origin/main")
        );

        let cleared = git_set_upstream(repo.path(), "tracked".to_string(), None).unwrap();
        assert!(cleared.ok, "{cleared:?}");
        assert_eq!(get_sync_state(repo.path()).unwrap().upstream, None);
    }

    #[test]
    fn 이름_검증은_옵션과_git이_거부하는_ref를_막는다() {
        let (_origin, repo) = remote_fixture();
        let path = repo.path();

        for bad in [
            "",
            "   ",
            "-x",
            "a..b",
            "a b",
            "he@{ad}",
            "back\\slash",
            "star*",
        ] {
            assert!(
                git_create_branch(path.clone(), bad.to_string(), None, false).is_err(),
                "허용하면 안 되는 이름: {bad:?}"
            );
        }
        // start_point와 checkout/delete도 같은 검증을 통과해야 한다
        assert!(git_create_branch(
            path.clone(),
            "ok".to_string(),
            Some("-x".to_string()),
            false
        )
        .is_err());
        assert!(git_checkout(path.clone(), "-x".to_string(), false).is_err());
        assert!(git_delete_branch(path.clone(), "a..b".to_string(), true, false).is_err());

        // 슬래시가 들어간 정상 이름은 통과한다
        assert!(
            git_create_branch(path, "feature/ok".to_string(), None, false)
                .unwrap()
                .ok
        );
    }
}
