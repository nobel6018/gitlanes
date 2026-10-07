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
        crate::git::version(),
    )?;
    let args: Vec<&str> = args.iter().map(String::as_str).collect();

    run_op(&path, &args, NETWORK_TIMEOUT)
}

/// push 인자를 조립한다. 순수 함수로 떼어낸 이유는 `--force`가 어떤 조합에서도 나오지
/// 않는다는 것을 테스트로 못 박기 위해서다.
///
/// remote와 branch를 명시하는 경우가 아니면 인자를 덧붙이지 않는다. 그래야 `push.default`
/// 설정과 upstream 추적이 평소대로 동작한다.
///
/// `--force-with-lease`에는 `--force-if-includes`를 함께 붙인다. lease 값은 원격 추적 ref라서
/// 툴바 Fetch가 그걸 갱신하면, 통합하지 않은 동료 커밋이 있어도 lease 검사를 통과해 덮어쓴다.
/// `--force-if-includes`는 원격 추적 ref의 끝이 로컬 브랜치 reflog에 있을 때만, 즉 내가 한 번
/// 받아 본 상태에서 고쳐 쓴 것일 때만 허용한다.
///
/// 이 옵션은 git 2.30부터 있다. 그보다 낮거나 버전을 못 읽으면 force push를 **거절한다**.
/// 옵션만 빼고 lease로 밀면, 확인창의 "통합하지 않은 원격 커밋이 있으면 거절된다"는 약속이
/// 거짓이 되고 사용자는 그 문구를 믿고 남의 커밋을 덮는다. 기능이 없는 편이 낫다.
/// 일반 push는 버전과 무관하다. `git_version`을 인자로 받는 이유는 테스트가 버전을 주입하기
/// 위해서다.
fn push_args(
    remote: Option<&str>,
    branch: &str,
    has_upstream: bool,
    set_upstream: bool,
    force_with_lease: bool,
    tags: bool,
    git_version: Option<(u32, u32)>,
) -> Result<Vec<String>, String> {
    let mut args = vec!["push".to_string()];
    if force_with_lease {
        if git_version.is_none_or(|version| version < FORCE_IF_INCLUDES_SINCE) {
            return Err(
                "Force push needs git 2.30 or newer. Update git and try again.".to_string(),
            );
        }
        args.push("--force-with-lease".to_string());
        args.push("--force-if-includes".to_string());
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
    Ok(args)
}

/// `push --force-if-includes`가 들어온 git 버전.
const FORCE_IF_INCLUDES_SINCE: (u32, u32) = (2, 30);

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

    fn remote_log(origin: &crate::testrepo::TempRepo) -> String {
        crate::git::run(origin.path(), &["log", "--format=%s", "main"]).unwrap()
    }

    /// 툴바 Fetch가 lease 값(원격 추적 ref)을 갱신해 버리면 `--force-with-lease`만으로는
    /// `--force`와 다를 바 없다. 통합하지 않은 동료 커밋이 있으면 거절해야 한다.
    #[test]
    fn force_with_lease는_fetch만_하고_통합하지_않은_원격_커밋을_덮지_않는다() {
        let (origin, repo) = remote_fixture();
        push_remote_commit(&origin, "teammate-work");
        repo.git(&["commit", "-q", "--amend", "-m", "c1-amended"]);

        // 원격 추적 ref가 낡아서 lease 검사에 걸린다
        let stale = git_push(repo.path(), None, None, false, true, false).unwrap();
        assert!(!stale.ok, "{stale:?}");

        // Fetch로 lease가 최신이 됐어도 teammate-work를 통합하지 않았으니 거절이다
        assert!(fetch_all(&repo).ok);
        let fetched = git_push(repo.path(), None, None, false, true, false).unwrap();
        assert!(!fetched.ok, "통합 안 한 원격 커밋을 덮었다: {fetched:?}");
        assert!(
            remote_log(&origin).contains("teammate-work"),
            "{}",
            remote_log(&origin)
        );
    }

    /// 내가 올린 커밋을 amend해 다시 올리는 평범한 force push는 그대로 통한다.
    #[test]
    fn force_with_lease는_내_커밋을_고쳐_올리는_것은_허용한다() {
        let (origin, repo) = remote_fixture();
        repo.git(&["commit", "-q", "--amend", "-m", "c1-amended"]);

        let result = git_push(repo.path(), None, None, false, true, false).unwrap();
        assert!(result.ok, "{result:?}");
        assert_eq!(remote_log(&origin).trim(), "c1-amended");
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
                            for version in [None, Some((2, 29)), Some((2, 30)), Some((3, 0))] {
                                let built = push_args(
                                    remote,
                                    "main",
                                    has_upstream,
                                    set_upstream,
                                    force_with_lease,
                                    tags,
                                    version,
                                );
                                let supported = version.is_some_and(|v| v >= (2, 30));
                                if force_with_lease && !supported {
                                    // 보호를 보장할 수 없으면 git을 부르지 않고 거절한다
                                    assert_eq!(
                                        built.unwrap_err(),
                                        "Force push needs git 2.30 or newer. Update git and try again."
                                    );
                                    continue;
                                }
                                let args = built.expect("일반 push는 버전과 무관하다");
                                assert!(
                                    !args.iter().any(|arg| arg == "--force" || arg == "-f"),
                                    "{args:?}"
                                );
                                let lease = args.iter().any(|arg| arg == "--force-with-lease");
                                let includes = args.iter().any(|arg| arg == "--force-if-includes");
                                assert_eq!(lease, force_with_lease, "{args:?}");
                                // 둘은 언제나 함께 나온다. lease만 나가는 조합은 없다
                                assert_eq!(includes, lease, "{args:?}");
                            }
                        }
                    }
                }
            }
        }

        // upstream이 이미 있으면 -u를 붙이지 않는다
        assert_eq!(
            push_args(None, "main", true, true, false, false, Some((2, 50))).unwrap(),
            ["push"]
        );
        assert_eq!(
            push_args(None, "feature", false, true, false, false, Some((2, 50))).unwrap(),
            ["push", "-u", "origin", "feature"]
        );
        assert_eq!(
            push_args(
                Some("upstream"),
                "feature",
                true,
                false,
                false,
                false,
                Some((2, 50))
            )
            .unwrap(),
            ["push", "upstream", "feature"]
        );
        assert_eq!(
            push_args(None, "main", true, false, false, true, Some((2, 50))).unwrap(),
            ["push", "--tags"]
        );
    }

    #[test]
    fn force_push는_git_2_29에서_거절되고_2_30에서_두_옵션이_함께_나온다() {
        assert!(push_args(None, "main", true, false, true, false, Some((2, 29))).is_err());
        assert!(push_args(None, "main", true, false, true, false, None).is_err());
        assert_eq!(
            push_args(None, "main", true, false, true, false, Some((2, 30))).unwrap(),
            ["push", "--force-with-lease", "--force-if-includes"]
        );
        // 일반 push는 오래된 git에서도 그대로다
        assert_eq!(
            push_args(None, "main", true, false, false, false, Some((2, 20))).unwrap(),
            ["push"]
        );
    }
}
