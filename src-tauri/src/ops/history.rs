//! 히스토리를 바꾸는 작업. 머지, 리베이스, 체리픽, 리버트, 리셋과 그 진행 제어.
//!
//! @see CONTRACTS.md

use crate::model::OpResult;

use super::run::{run_op, validate_commitish, validate_ref_name, LOCAL_TIMEOUT};

/// `source`를 현재 브랜치로 머지한다. 충돌하면 `ok=false` + `conflicts`가 채워진다.
#[tauri::command]
pub fn git_merge(
    path: String,
    source: String,
    no_ff: bool,
    squash: bool,
    no_commit: bool,
) -> Result<OpResult, String> {
    let source = validate_ref_name(&path, &source)?;
    if no_ff && squash {
        // --squash는 커밋을 만들지 않아서 --no-ff와 뜻이 겹치지 않고 git이 거절한다.
        // 조합을 UI에서 못 만들게 막았더라도 여기서 한 번 더 거른다.
        return Err("--no-ff와 --squash는 함께 쓸 수 없습니다".to_string());
    }

    let mut args: Vec<&str> = vec!["merge", "--no-edit"];
    if no_ff {
        args.push("--no-ff");
    }
    if squash {
        args.push("--squash");
    }
    if no_commit {
        args.push("--no-commit");
    }
    args.push(source.as_str());

    run_op(&path, &args, LOCAL_TIMEOUT)
}

/// 현재 브랜치를 `upstream` 위로 옮긴다. `onto`가 있으면 이동할 바닥을 따로 지정한다.
#[tauri::command]
pub fn git_rebase(
    path: String,
    upstream: String,
    onto: Option<String>,
    autostash: bool,
) -> Result<OpResult, String> {
    let upstream = validate_commitish(&path, &upstream)?;
    let onto = match onto.as_deref().map(str::trim).filter(|v| !v.is_empty()) {
        Some(onto) => Some(validate_commitish(&path, onto)?),
        None => None,
    };

    let mut args: Vec<&str> = vec!["rebase"];
    if autostash {
        args.push("--autostash");
    }
    if let Some(onto) = onto.as_deref() {
        args.push("--onto");
        args.push(onto);
    }
    args.push(upstream.as_str());

    run_op(&path, &args, LOCAL_TIMEOUT)
}

#[tauri::command]
pub fn git_cherry_pick(
    path: String,
    shas: Vec<String>,
    no_commit: bool,
    mainline: Option<u32>,
) -> Result<OpResult, String> {
    let shas = validate_commitish_list(&path, &shas)?;
    let mainline = validate_mainline(mainline)?;

    let mut args: Vec<&str> = vec!["cherry-pick"];
    if no_commit {
        args.push("-n");
    }
    if let Some(mainline) = mainline.as_deref() {
        args.push("-m");
        args.push(mainline);
    }
    args.extend(shas.iter().map(String::as_str));

    run_op(&path, &args, LOCAL_TIMEOUT)
}

#[tauri::command]
pub fn git_revert(
    path: String,
    shas: Vec<String>,
    no_commit: bool,
    mainline: Option<u32>,
) -> Result<OpResult, String> {
    let shas = validate_commitish_list(&path, &shas)?;
    let mainline = validate_mainline(mainline)?;

    let mut args: Vec<&str> = vec!["revert", "--no-edit"];
    if no_commit {
        args.push("-n");
    }
    if let Some(mainline) = mainline.as_deref() {
        args.push("-m");
        args.push(mainline);
    }
    args.extend(shas.iter().map(String::as_str));

    run_op(&path, &args, LOCAL_TIMEOUT)
}

/// `mode`는 "soft" | "mixed" | "hard". hard는 워킹 트리를 지우므로 UI 확인이 필수다.
#[tauri::command]
pub fn git_reset(path: String, target: String, mode: String) -> Result<OpResult, String> {
    let flag = match mode.as_str() {
        "soft" => "--soft",
        "mixed" => "--mixed",
        "hard" => "--hard",
        other => return Err(format!("알 수 없는 reset 모드입니다: {other}")),
    };
    let target = validate_commitish(&path, &target)?;

    run_op(&path, &["reset", flag, target.as_str()], LOCAL_TIMEOUT)
}

/// 진행 중인 작업을 이어가거나 되돌린다.
///
/// `kind`는 `get_sync_state().pending.kind`를 그대로 넘긴다. 종류마다 명령이 달라서
/// 프론트가 짐작하지 않게 하려는 것이다. 머지에는 `--skip`이 없다.
#[tauri::command]
pub fn git_pending_action(path: String, kind: String, action: String) -> Result<OpResult, String> {
    let subcommand = match kind.as_str() {
        "merge" => "merge",
        "rebase" => "rebase",
        "cherryPick" => "cherry-pick",
        "revert" => "revert",
        other => return Err(format!("알 수 없는 진행 중 작업입니다: {other}")),
    };
    let flag = match action.as_str() {
        "continue" => "--continue",
        "abort" => "--abort",
        "skip" => {
            if subcommand == "merge" {
                return Err("머지에는 skip이 없습니다".to_string());
            }
            "--skip"
        }
        other => return Err(format!("알 수 없는 동작입니다: {other}")),
    };

    run_op(&path, &[subcommand, flag], LOCAL_TIMEOUT)
}

/// 커밋 목록을 검증한다. 빈 목록은 git이 전체로 해석할 여지가 있어 먼저 막는다.
fn validate_commitish_list(repo: &str, shas: &[String]) -> Result<Vec<String>, String> {
    if shas.is_empty() {
        return Err("대상 커밋이 없습니다".to_string());
    }
    shas.iter()
        .map(|sha| validate_commitish(repo, sha))
        .collect()
}

/// `-m`은 머지 커밋에서 어느 부모를 기준으로 삼을지다. 1부터 시작한다.
fn validate_mainline(mainline: Option<u32>) -> Result<Option<String>, String> {
    match mainline {
        None => Ok(None),
        Some(0) => Err("mainline은 1부터 시작합니다".to_string()),
        Some(value) => Ok(Some(value.to_string())),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git;
    use crate::model::PendingKind;
    use crate::ops::sync::detect_pending;
    use crate::testrepo::TempRepo;

    /// main과 other가 같은 파일을 다르게 고쳐 충돌하는 저장소.
    fn conflicting(prefix: &str) -> TempRepo {
        let repo = TempRepo::init(prefix);
        repo.write("c.txt", "base\n");
        repo.git(&["add", "-A"]);
        repo.git(&["commit", "-qm", "base"]);
        repo.git(&["checkout", "-qb", "other"]);
        repo.write("c.txt", "other\n");
        repo.git(&["add", "-A"]);
        repo.git(&["commit", "-qm", "other side"]);
        repo.git(&["checkout", "-q", "main"]);
        repo.write("c.txt", "main\n");
        repo.git(&["add", "-A"]);
        repo.git(&["commit", "-qm", "main side"]);
        repo
    }

    /// main 위에 other가 서로 다른 파일을 만드는, 충돌하지 않는 저장소.
    fn clean_branches(prefix: &str) -> TempRepo {
        let repo = TempRepo::init(prefix);
        repo.write("base.txt", "base\n");
        repo.git(&["add", "-A"]);
        repo.git(&["commit", "-qm", "base"]);
        repo.git(&["checkout", "-qb", "other"]);
        repo.write("other.txt", "other\n");
        repo.git(&["add", "-A"]);
        repo.git(&["commit", "-qm", "other side"]);
        repo.git(&["checkout", "-q", "main"]);
        repo
    }

    fn count(repo: &TempRepo, rev: &str) -> usize {
        git::run(repo.path(), &["rev-list", "--count", rev])
            .unwrap()
            .trim()
            .parse()
            .unwrap()
    }

    #[test]
    fn merge_충돌은_conflicts를_채운다() {
        let repo = conflicting("gitlanes-merge");
        let result = git_merge(repo.path(), "other".to_string(), false, false, false).unwrap();
        assert!(!result.ok, "{result:?}");
        assert_eq!(result.conflicts, ["c.txt"]);
        assert!(!result.needs_auth);
    }

    #[test]
    fn 충돌이_없는_merge는_conflicts가_비어_있다() {
        let repo = clean_branches("gitlanes-merge-clean");
        let result = git_merge(repo.path(), "other".to_string(), false, false, false).unwrap();
        assert!(result.ok, "{result:?}");
        assert!(result.conflicts.is_empty(), "{result:?}");
    }

    #[test]
    fn merge_no_ff는_머지_커밋을_남긴다() {
        let repo = clean_branches("gitlanes-merge-noff");
        let result = git_merge(repo.path(), "other".to_string(), true, false, false).unwrap();
        assert!(result.ok, "{result:?}");
        // ff였다면 부모가 하나뿐이다
        let parents = git::run(repo.path(), &["log", "-1", "--format=%P"]).unwrap();
        assert_eq!(parents.split_whitespace().count(), 2, "{parents}");
    }

    #[test]
    fn merge_squash는_커밋하지_않고_인덱스만_채운다() {
        let repo = clean_branches("gitlanes-merge-squash");
        let before = count(&repo, "HEAD");

        let result = git_merge(repo.path(), "other".to_string(), false, true, false).unwrap();
        assert!(result.ok, "{result:?}");
        assert_eq!(
            count(&repo, "HEAD"),
            before,
            "squash는 커밋을 만들지 않는다"
        );

        let staged = git::run(repo.path(), &["diff", "--cached", "--name-only"]).unwrap();
        assert_eq!(staged.trim(), "other.txt");
    }

    #[test]
    fn merge는_no_ff와_squash_조합과_잘못된_이름을_거부한다() {
        let repo = clean_branches("gitlanes-merge-bad");
        assert!(git_merge(repo.path(), "other".to_string(), true, true, false).is_err());
        assert!(git_merge(repo.path(), "a b".to_string(), false, false, false).is_err());
        assert!(git_merge(repo.path(), "-x".to_string(), false, false, false).is_err());
    }

    #[test]
    fn rebase는_커밋을_위로_옮긴다() {
        let repo = clean_branches("gitlanes-rebase");
        repo.write("main.txt", "main\n");
        repo.git(&["add", "-A"]);
        repo.git(&["commit", "-qm", "main work"]);
        repo.git(&["checkout", "-q", "other"]);

        let result = git_rebase(repo.path(), "main".to_string(), None, false).unwrap();
        assert!(result.ok, "{result:?}");
        // other가 main 위로 올라갔으니 main은 조상이다
        assert!(git::run(
            repo.path(),
            &["merge-base", "--is-ancestor", "main", "HEAD"]
        )
        .is_ok());
    }

    #[test]
    fn rebase_충돌은_pending_rebase를_남긴다() {
        let repo = conflicting("gitlanes-rebase-conflict");
        repo.git(&["checkout", "-q", "other"]);

        let result = git_rebase(repo.path(), "main".to_string(), None, false).unwrap();
        assert!(!result.ok, "{result:?}");
        assert_eq!(result.conflicts, ["c.txt"]);

        let pending = detect_pending(&repo.path()).unwrap();
        assert_eq!(pending.kind, PendingKind::Rebase);

        // abort로 원래 자리로 돌아온다
        let aborted =
            git_pending_action(repo.path(), "rebase".to_string(), "abort".to_string()).unwrap();
        assert!(aborted.ok, "{aborted:?}");
        assert_eq!(detect_pending(&repo.path()), None);
    }

    #[test]
    fn rebase_onto가_바닥을_바꾼다() {
        let repo = TempRepo::init("gitlanes-rebase-onto");
        repo.write("a.txt", "a\n");
        repo.git(&["add", "-A"]);
        repo.git(&["commit", "-qm", "root"]);
        repo.git(&["checkout", "-qb", "middle"]);
        repo.write("m.txt", "m\n");
        repo.git(&["add", "-A"]);
        repo.git(&["commit", "-qm", "middle work"]);
        repo.git(&["checkout", "-qb", "topic"]);
        repo.write("t.txt", "t\n");
        repo.git(&["add", "-A"]);
        repo.git(&["commit", "-qm", "topic work"]);

        // topic의 커밋 하나만 main 위로 옮긴다
        let result = git_rebase(
            repo.path(),
            "middle".to_string(),
            Some("main".to_string()),
            false,
        )
        .unwrap();
        assert!(result.ok, "{result:?}");
        assert_eq!(count(&repo, "HEAD"), 2, "root + topic work만 남아야 한다");
    }

    #[test]
    fn rebase는_없는_대상을_거부한다() {
        let repo = clean_branches("gitlanes-rebase-bad");
        assert!(git_rebase(repo.path(), "없는브랜치".to_string(), None, false).is_err());
        assert!(git_rebase(repo.path(), "-x".to_string(), None, false).is_err());
        assert!(git_rebase(
            repo.path(),
            "main".to_string(),
            Some("없는바닥".to_string()),
            false
        )
        .is_err());
    }

    #[test]
    fn cherry_pick이_커밋을_가져온다() {
        let repo = clean_branches("gitlanes-cherry");
        let sha = repo.rev("other");

        let result = git_cherry_pick(repo.path(), vec![sha], false, None).unwrap();
        assert!(result.ok, "{result:?}");
        assert!(std::path::Path::new(&repo.path())
            .join("other.txt")
            .exists());
    }

    #[test]
    fn cherry_pick_no_commit은_인덱스에만_올린다() {
        let repo = clean_branches("gitlanes-cherry-n");
        let sha = repo.rev("other");
        let before = count(&repo, "HEAD");

        let result = git_cherry_pick(repo.path(), vec![sha], true, None).unwrap();
        assert!(result.ok, "{result:?}");
        assert_eq!(count(&repo, "HEAD"), before);
        let staged = git::run(repo.path(), &["diff", "--cached", "--name-only"]).unwrap();
        assert_eq!(staged.trim(), "other.txt");
    }

    #[test]
    fn cherry_pick은_빈_목록과_없는_커밋과_mainline_0을_거부한다() {
        let repo = clean_branches("gitlanes-cherry-bad");
        assert!(git_cherry_pick(repo.path(), vec![], false, None).is_err());
        assert!(git_cherry_pick(repo.path(), vec!["없음".to_string()], false, None).is_err());
        assert!(git_cherry_pick(repo.path(), vec![repo.rev("other")], false, Some(0)).is_err());
    }

    #[test]
    fn revert가_변경을_되돌린다() {
        let repo = TempRepo::init("gitlanes-revert");
        repo.write("a.txt", "1\n");
        repo.git(&["add", "-A"]);
        repo.git(&["commit", "-qm", "base"]);
        repo.write("a.txt", "2\n");
        repo.git(&["add", "-A"]);
        repo.git(&["commit", "-qm", "바꾼다"]);

        let head = repo.rev("HEAD");
        let result = git_revert(repo.path(), vec![head], false, None).unwrap();
        assert!(result.ok, "{result:?}");
        assert_eq!(
            std::fs::read_to_string(std::path::Path::new(&repo.path()).join("a.txt")).unwrap(),
            "1\n"
        );
        assert_eq!(count(&repo, "HEAD"), 3, "되돌리는 커밋이 하나 쌓인다");
    }

    #[test]
    fn revert_충돌은_pending_revert를_남긴다() {
        let repo = TempRepo::init("gitlanes-revert-conflict");
        repo.write("a.txt", "1\n");
        repo.git(&["add", "-A"]);
        repo.git(&["commit", "-qm", "base"]);
        repo.write("a.txt", "2\n");
        repo.git(&["add", "-A"]);
        repo.git(&["commit", "-qm", "두 번째"]);
        let target = repo.rev("HEAD");
        repo.write("a.txt", "3\n");
        repo.git(&["add", "-A"]);
        repo.git(&["commit", "-qm", "세 번째"]);

        let result = git_revert(repo.path(), vec![target], false, None).unwrap();
        assert!(!result.ok, "{result:?}");
        assert_eq!(
            detect_pending(&repo.path()).map(|p| p.kind),
            Some(PendingKind::Revert)
        );

        let aborted =
            git_pending_action(repo.path(), "revert".to_string(), "abort".to_string()).unwrap();
        assert!(aborted.ok, "{aborted:?}");
        assert_eq!(detect_pending(&repo.path()), None);
    }

    #[test]
    fn reset은_모드별로_인덱스와_워킹트리를_다르게_둔다() {
        let repo = TempRepo::linear("gitlanes-reset", 3);

        let soft = git_reset(repo.path(), "HEAD~1".to_string(), "soft".to_string()).unwrap();
        assert!(soft.ok, "{soft:?}");
        assert_eq!(count(&repo, "HEAD"), 2);
        let staged = git::run(repo.path(), &["diff", "--cached", "--name-only"]).unwrap();
        assert_eq!(
            staged.trim(),
            "counter.txt",
            "soft는 변경을 인덱스에 남긴다"
        );

        let hard = git_reset(repo.path(), "HEAD".to_string(), "hard".to_string()).unwrap();
        assert!(hard.ok, "{hard:?}");
        assert!(git::run(repo.path(), &["status", "--porcelain"])
            .unwrap()
            .trim()
            .is_empty());
    }

    #[test]
    fn reset은_알_수_없는_모드와_대상을_거부한다() {
        let repo = TempRepo::linear("gitlanes-reset-bad", 2);
        assert!(git_reset(repo.path(), "HEAD".to_string(), "merge".to_string()).is_err());
        assert!(git_reset(repo.path(), "없는것".to_string(), "hard".to_string()).is_err());
        assert!(git_reset(repo.path(), "-x".to_string(), "hard".to_string()).is_err());
    }

    #[test]
    fn pending_action은_종류별_명령으로_바뀐다() {
        let repo = conflicting("gitlanes-pending-merge-abort");
        let merged = git_merge(repo.path(), "other".to_string(), false, false, false).unwrap();
        assert!(!merged.ok);

        let aborted =
            git_pending_action(repo.path(), "merge".to_string(), "abort".to_string()).unwrap();
        assert!(aborted.ok, "{aborted:?}");
        assert_eq!(aborted.command, ["merge", "--abort"]);
        assert_eq!(detect_pending(&repo.path()), None);
    }

    #[test]
    fn pending_action은_모르는_인자와_머지_skip을_거부한다() {
        let repo = TempRepo::linear("gitlanes-pending-bad", 1);
        assert!(git_pending_action(repo.path(), "stash".to_string(), "abort".to_string()).is_err());
        assert!(git_pending_action(repo.path(), "merge".to_string(), "next".to_string()).is_err());
        assert!(git_pending_action(repo.path(), "merge".to_string(), "skip".to_string()).is_err());
        // 진행 중인 작업이 없으면 git이 거절한다. 오류가 아니라 결과다.
        let idle =
            git_pending_action(repo.path(), "rebase".to_string(), "abort".to_string()).unwrap();
        assert!(!idle.ok, "{idle:?}");
    }
}
