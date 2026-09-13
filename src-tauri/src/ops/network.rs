//! 네트워크를 타는 작업. 여기만 인증이 걸리고, 그래서 `needs_auth`가 의미를 갖는다.
//!
//! @see CONTRACTS.md

use crate::model::OpResult;

use super::run::{
    current_branch, run_op, upstream_of_head, validate_ref_name, validate_remote, NETWORK_TIMEOUT,
};

/// `all_remotes`가 켜져 있으면 `--all`, 아니면 `remote`(없으면 git 기본 remote).
#[tauri::command]
pub fn git_fetch(
    path: String,
    remote: Option<String>,
    prune: bool,
    all_remotes: bool,
    tags: bool,
) -> Result<OpResult, String> {
    let remote = match remote.as_deref().map(str::trim).filter(|r| !r.is_empty()) {
        Some(remote) => Some(validate_remote(&path, remote)?),
        None => None,
    };

    let mut args: Vec<&str> = vec!["fetch"];
    if all_remotes {
        args.push("--all");
    } else if let Some(remote) = remote.as_deref() {
        args.push(remote);
    }
    if prune {
        args.push("--prune");
    }
    if tags {
        args.push("--tags");
    }

    run_op(&path, &args, NETWORK_TIMEOUT)
}

/// `mode`는 `PullMode`("ff-only" | "merge" | "rebase").
#[tauri::command]
pub fn git_pull(
    path: String,
    mode: String,
    remote: Option<String>,
    branch: Option<String>,
) -> Result<OpResult, String> {
    let mut args: Vec<&str> = match mode.as_str() {
        "ff-only" => vec!["pull", "--ff-only"],
        // --no-rebase가 곧 merge다. --no-ff는 아니라서 ff가 가능하면 ff로 끝난다.
        "merge" => vec!["pull", "--no-rebase", "--no-edit"],
        "rebase" => vec!["pull", "--rebase"],
        other => return Err(format!("알 수 없는 pull 모드입니다: {other}")),
    };

    // remote 없이 branch만 주면 git이 branch를 remote로 읽는다. 둘은 같이 온다.
    let remote = match remote.as_deref().map(str::trim).filter(|r| !r.is_empty()) {
        Some(remote) => Some(validate_remote(&path, remote)?),
        None => None,
    };
    let branch = match branch.as_deref().map(str::trim).filter(|b| !b.is_empty()) {
        Some(branch) => Some(validate_ref_name(&path, branch)?),
        None => None,
    };
    if branch.is_some() && remote.is_none() {
        return Err("브랜치를 지정하려면 remote도 함께 지정해야 합니다".to_string());
    }
    if let Some(remote) = remote.as_deref() {
        args.push(remote);
    }
    if let Some(branch) = branch.as_deref() {
        args.push(branch);
    }

    run_op(&path, &args, NETWORK_TIMEOUT)
}

/// 푸시한다. 일반 `--force`는 어떤 경로로도 붙지 않는다.
#[tauri::command]
pub fn git_push(
    path: String,
    remote: Option<String>,
    branch: Option<String>,
    set_upstream: bool,
    force_with_lease: bool,
    tags: bool,
) -> Result<OpResult, String> {
    let remote = match remote.as_deref().map(str::trim).filter(|r| !r.is_empty()) {
        Some(remote) => Some(validate_remote(&path, remote)?),
        None => None,
    };
    let branch = match branch.as_deref().map(str::trim).filter(|b| !b.is_empty()) {
        Some(branch) => validate_ref_name(&path, branch)?,
        None => current_branch(&path)
            .ok_or_else(|| "detached HEAD 상태에서는 푸시할 수 없습니다".to_string())?,
    };

    let has_upstream = upstream_of_head(&path).is_some();
    let args = push_args(
        remote.as_deref(),
        &branch,
        has_upstream,
        set_upstream,
        force_with_lease,
        tags,
    );
    let args: Vec<&str> = args.iter().map(String::as_str).collect();

    run_op(&path, &args, NETWORK_TIMEOUT)
}

/// push 인자를 조립한다. 순수 함수로 떼어낸 이유는 `--force`가 어떤 조합에서도 나오지
/// 않는다는 것을 테스트로 못 박기 위해서다.
///
/// remote와 branch를 명시하는 경우가 아니면 인자를 덧붙이지 않는다. 그래야 `push.default`
/// 설정과 upstream 추적이 평소대로 동작한다.
fn push_args(
    remote: Option<&str>,
    branch: &str,
    has_upstream: bool,
    set_upstream: bool,
    force_with_lease: bool,
    tags: bool,
) -> Vec<String> {
    let mut args = vec!["push".to_string()];
    if force_with_lease {
        args.push("--force-with-lease".to_string());
    }
    if tags {
        args.push("--tags".to_string());
    }

    // upstream이 이미 있으면 -u를 다시 붙일 이유가 없다
    let setting_upstream = set_upstream && !has_upstream;
    if setting_upstream {
        args.push("-u".to_string());
    }
    if setting_upstream || remote.is_some() {
        args.push(remote.unwrap_or("origin").to_string());
        args.push(branch.to_string());
    }
    args
}

/// 다른 모듈의 통합 테스트가 공유하는 로컬 리모트 픽스처.
#[cfg(test)]
pub mod tests_support {
    use crate::testrepo::TempRepo;

    /// (origin bare, 작업 사본). 둘 다 살려둬야 Drop이 디렉토리를 지우지 않는다.
    pub fn remote_fixture() -> (TempRepo, TempRepo) {
        let origin = TempRepo::init_bare("gitlanes-origin");
        let repo = TempRepo::init("gitlanes-ops");
        repo.write("a.txt", "1\n");
        repo.git(&["add", "-A"]);
        repo.git(&["commit", "-qm", "c1"]);
        repo.git(&["remote", "add", "origin", &origin.path()]);
        repo.git(&["push", "-q", "-u", "origin", "main"]);
        (origin, repo)
    }

    /// 두 번째 사본에서 origin/main에 커밋 하나를 올린다.
    pub fn push_remote_commit(origin: &TempRepo, message: &str) {
        let other = TempRepo::clone_of("gitlanes-other", &origin.path());
        other.write("other.txt", &format!("{message}\n"));
        other.git(&["add", "-A"]);
        other.git(&["commit", "-qm", message]);
        other.git(&["push", "-q", "origin", "main"]);
    }

    /// 리모트와 로컬이 서로 다른 커밋을 하나씩 갖게 만든다.
    pub fn diverge(origin: &TempRepo, repo: &TempRepo) {
        push_remote_commit(origin, "remote side");
        repo.write("local.txt", "local\n");
        repo.git(&["add", "-A"]);
        repo.git(&["commit", "-qm", "local side"]);
    }

    pub fn exists(repo: &TempRepo, name: &str) -> bool {
        std::path::Path::new(&repo.path()).join(name).exists()
    }
}

#[cfg(test)]
mod tests {
    use super::tests_support::*;
    use super::*;
    use crate::ops::sync::get_sync_state;

    fn fetch_all(repo: &crate::testrepo::TempRepo) -> OpResult {
        git_fetch(repo.path(), None, false, true, false).unwrap()
    }

    #[test]
    fn fetch는_리모트_변경을_가져와_behind로_보인다() {
        let (origin, repo) = remote_fixture();
        push_remote_commit(&origin, "remote work");

        let result = fetch_all(&repo);
        assert!(result.ok, "{result:?}");
        assert!(result.conflicts.is_empty());
        assert_eq!(result.command, ["fetch", "--all"]);
        assert!(!result.needs_auth);

        let state = get_sync_state(repo.path()).unwrap();
        assert_eq!(state.branch.as_deref(), Some("main"));
        assert_eq!(state.upstream.as_deref(), Some("origin/main"));
        assert_eq!((state.ahead, state.behind), (0, 1));
    }

    #[test]
    fn fetch의_prune과_tags가_인자에_실린다() {
        let (_origin, repo) = remote_fixture();
        let result = git_fetch(repo.path(), Some("origin".to_string()), true, false, true).unwrap();
        assert!(result.ok, "{result:?}");
        assert_eq!(result.command, ["fetch", "origin", "--prune", "--tags"]);
    }

    #[test]
    fn 등록되지_않은_remote는_거부한다() {
        let (_origin, repo) = remote_fixture();
        assert!(git_fetch(
            repo.path(),
            Some("upstream".to_string()),
            false,
            false,
            false
        )
        .is_err());
        assert!(git_fetch(repo.path(), Some("-x".to_string()), false, false, false).is_err());
    }

    #[test]
    fn pull_ff_only는_앞선_리모트를_따라간다() {
        let (origin, repo) = remote_fixture();
        push_remote_commit(&origin, "remote work");

        let result = git_pull(repo.path(), "ff-only".to_string(), None, None).unwrap();
        assert!(result.ok, "{result:?}");
        assert!(exists(&repo, "other.txt"));

        let state = get_sync_state(repo.path()).unwrap();
        assert_eq!((state.ahead, state.behind), (0, 0));
    }

    #[test]
    fn pull_ff_only는_분기하면_실패하고_stderr를_담는다() {
        let (origin, repo) = remote_fixture();
        diverge(&origin, &repo);

        let result = git_pull(repo.path(), "ff-only".to_string(), None, None).unwrap();
        assert!(!result.ok, "{result:?}");
        assert!(!result.stderr.is_empty(), "{result:?}");
    }

    #[test]
    fn pull_rebase는_로컬_커밋을_위로_올린다() {
        let (origin, repo) = remote_fixture();
        diverge(&origin, &repo);

        let result = git_pull(repo.path(), "rebase".to_string(), None, None).unwrap();
        assert!(result.ok, "{result:?}");

        let state = get_sync_state(repo.path()).unwrap();
        assert_eq!((state.ahead, state.behind), (1, 0));
    }

    #[test]
    fn pull_merge는_분기를_합친다() {
        let (origin, repo) = remote_fixture();
        diverge(&origin, &repo);

        let result = git_pull(
            repo.path(),
            "merge".to_string(),
            Some("origin".to_string()),
            Some("main".to_string()),
        )
        .unwrap();
        assert!(result.ok, "{result:?}");
        assert!(exists(&repo, "other.txt"));
        assert!(exists(&repo, "local.txt"));

        let state = get_sync_state(repo.path()).unwrap();
        assert_eq!(state.behind, 0);
        // 로컬 커밋 + 머지 커밋
        assert_eq!(state.ahead, 2);
    }

    #[test]
    fn 알_수_없는_pull_모드는_거부한다() {
        let (_origin, repo) = remote_fixture();
        assert!(git_pull(repo.path(), "force".to_string(), None, None).is_err());
        assert!(git_pull(repo.path(), String::new(), None, None).is_err());
        // remote 없이 브랜치만 주면 git이 브랜치를 remote로 읽는다
        assert!(git_pull(
            repo.path(),
            "merge".to_string(),
            None,
            Some("main".to_string())
        )
        .is_err());
    }

    #[test]
    fn push는_upstream이_없으면_설정하며_올린다() {
        let (_origin, repo) = remote_fixture();
        repo.git(&["checkout", "-qb", "feature"]);
        repo.write("f.txt", "f\n");
        repo.git(&["add", "-A"]);
        repo.git(&["commit", "-qm", "feature work"]);

        assert_eq!(get_sync_state(repo.path()).unwrap().upstream, None);

        let result = git_push(repo.path(), None, None, true, false, false).unwrap();
        assert!(result.ok, "{result:?}");

        let state = get_sync_state(repo.path()).unwrap();
        assert_eq!(state.upstream.as_deref(), Some("origin/feature"));
        assert_eq!((state.ahead, state.behind), (0, 0));
    }

    #[test]
    fn push는_upstream도_설정도_없으면_git_안내로_실패한다() {
        let (_origin, repo) = remote_fixture();
        repo.git(&["checkout", "-qb", "feature"]);

        let result = git_push(repo.path(), None, None, false, false, false).unwrap();
        assert!(!result.ok, "{result:?}");
        assert!(!result.stderr.is_empty(), "{result:?}");
    }

    #[test]
    fn push는_non_fast_forward를_ok_false로_돌려준다() {
        let (origin, repo) = remote_fixture();
        diverge(&origin, &repo);

        let result = git_push(repo.path(), None, None, false, false, false).unwrap();
        assert!(!result.ok, "{result:?}");
        assert!(result.stderr.contains("rejected"), "{result:?}");
        // 인증 문제가 아니라 거절이다. 터미널로 넘겨도 똑같이 거절당한다.
        assert!(!result.needs_auth, "{result:?}");
    }

    #[test]
    fn force_with_lease는_fetch로_lease를_갱신한_뒤에만_통한다() {
        let (origin, repo) = remote_fixture();
        diverge(&origin, &repo);

        // 원격 추적 ref가 낡아서 lease 검사에 걸린다
        let stale = git_push(repo.path(), None, None, false, true, false).unwrap();
        assert!(!stale.ok, "{stale:?}");

        assert!(fetch_all(&repo).ok);
        let fresh = git_push(repo.path(), None, None, false, true, false).unwrap();
        assert!(fresh.ok, "{fresh:?}");
    }

    #[test]
    fn push는_remote와_브랜치를_명시할_수_있다() {
        let (origin, repo) = remote_fixture();
        repo.git(&["checkout", "-qb", "named"]);
        repo.write("n.txt", "n\n");
        repo.git(&["add", "-A"]);
        repo.git(&["commit", "-qm", "named work"]);

        let result = git_push(
            repo.path(),
            Some("origin".to_string()),
            Some("named".to_string()),
            false,
            false,
            false,
        )
        .unwrap();
        assert!(result.ok, "{result:?}");
        assert_eq!(result.command, ["push", "origin", "named"]);

        let branches = crate::git::run(origin.path(), &["branch", "--list", "named"]).unwrap();
        assert!(branches.contains("named"), "{branches}");
    }

    #[test]
    fn detached_head는_브랜치가_없고_푸시도_거부한다() {
        let (_origin, repo) = remote_fixture();
        let head = repo.rev("HEAD");
        repo.git(&["checkout", "-q", "--detach", &head]);

        let state = get_sync_state(repo.path()).unwrap();
        assert_eq!(state.branch, None);
        assert_eq!(state.upstream, None);
        assert_eq!((state.ahead, state.behind), (0, 0));

        assert!(git_push(repo.path(), None, None, true, false, false).is_err());
    }

    #[test]
    fn push_인자에는_어떤_조합에서도_force가_없다() {
        for remote in [None, Some("origin")] {
            for has_upstream in [false, true] {
                for set_upstream in [false, true] {
                    for force_with_lease in [false, true] {
                        for tags in [false, true] {
                            let args = push_args(
                                remote,
                                "main",
                                has_upstream,
                                set_upstream,
                                force_with_lease,
                                tags,
                            );
                            assert!(
                                !args.iter().any(|arg| arg == "--force" || arg == "-f"),
                                "{args:?}"
                            );
                            assert_eq!(
                                args.iter().any(|arg| arg == "--force-with-lease"),
                                force_with_lease,
                                "{args:?}"
                            );
                        }
                    }
                }
            }
        }

        // upstream이 이미 있으면 -u를 붙이지 않는다
        assert_eq!(push_args(None, "main", true, true, false, false), ["push"]);
        assert_eq!(
            push_args(None, "feature", false, true, false, false),
            ["push", "-u", "origin", "feature"]
        );
        assert_eq!(
            push_args(Some("upstream"), "feature", true, false, false, false),
            ["push", "upstream", "feature"]
        );
        assert_eq!(
            push_args(None, "main", true, false, false, true),
            ["push", "--tags"]
        );
    }
}
