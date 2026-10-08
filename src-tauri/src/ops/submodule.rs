//! 서브모듈 update (v0.19), 추가와 제거 (v0.20).
//!
//! @see CONTRACTS.md (v0.19.0, v0.20.0)

use crate::commands::validate_pathspec;
use crate::model::{AddSubmoduleOptions, OpResult};

use super::run::{
    finish, run_chain, run_op, validate_paths, Outcome, LOCAL_TIMEOUT, NETWORK_TIMEOUT,
};

/// `submodule update [--init] --recursive -- <paths>`. paths가 비면 전부다.
///
/// 서브모듈 HEAD를 상위 레포에 기록된 커밋으로 옮긴다. 옮기기 전 HEAD는 서브모듈 reflog에
/// 남는다(확인 대화상자는 프론트 몫). clone이나 fetch가 일어날 수 있어 네트워크 상한을 쓰고,
/// `submodule`은 needsAuth 판정 대상이다.
///
/// `protocol.file.allow`는 건드리지 않는다. 로컬 경로 서브모듈의 clone을 막는 최근 git의
/// 기본값은 사용자 설정이 결정한다.
#[tauri::command(async)]
pub fn git_submodule_update(
    path: String,
    paths: Vec<String>,
    init: bool,
) -> Result<OpResult, String> {
    let paths = if paths.is_empty() {
        Vec::new()
    } else {
        for file in &paths {
            validate_pathspec(file)?;
        }
        validate_paths(&paths)?
    };

    let mut args: Vec<&str> = vec!["submodule", "update"];
    if init {
        args.push("--init");
    }
    args.extend(["--recursive", "--"]);
    args.extend(paths.iter().map(String::as_str));
    run_op(&path, &args, NETWORK_TIMEOUT)
}

/// `submodule add [-b <branch>] -- <url> <path>`. 결과(`.gitmodules`와 gitlink)는 스테이지에 남는다.
///
/// clone이 일어나 네트워크 상한을 쓰고, `submodule add`는 needsAuth 판정 대상이다.
/// `protocol.file.allow`는 덮지 않는다. 로컬 경로 URL이 막히면 git stderr가 그대로 간다.
/// 같은 경로 재추가, 레포 밖 경로는 git이 거절한다.
#[tauri::command(async)]
pub fn git_submodule_add(path: String, options: AddSubmoduleOptions) -> Result<OpResult, String> {
    let url = validate_url(&options.url)?;
    let sub_path = validate_sub_path(&options.path)?;
    let branch = options
        .branch
        .as_deref()
        .map(str::trim)
        .filter(|branch| !branch.is_empty());
    if let Some(branch) = branch {
        if branch.starts_with('-') || branch.contains('\0') {
            return Err(format!("Invalid branch name: {branch}"));
        }
    }

    let mut args: Vec<&str> = vec!["submodule", "add"];
    if let Some(branch) = branch {
        args.extend(["-b", branch]);
    }
    args.extend(["--", url.as_str(), sub_path.as_str()]);
    run_op(&path, &args, NETWORK_TIMEOUT)
}

/// `submodule deinit [-f] -- <subPath>` 뒤 `rm [-f] -- <subPath>`. `.gitmodules` 항목과 gitlink
/// 삭제가 스테이지된다. `.git/modules/<name>`은 지우지 않는다(서브모듈 안의 push 안 한 커밋 보존).
///
/// - force=false인데 서브모듈 안에 커밋 안 한 변경(추적 파일 수정 또는 untracked)이 있으면 git을
///   실행하지 않고 ok=false. 판정은 `get_submodules`의 dirty와 같다
/// - force=true면 먼저 `rm -n -f`로 rm이 거절할 조건(스테이지 안 한 `.gitmodules` 수정 등)을 본다.
///   deinit -f는 워킹 트리를 비우므로, rm이 뒤에서 거절하면 반쯤 지워진 상태가 남는다.
///   force=false의 deinit은 git이 안에서 같은 `rm -n`을 돌린다
/// - 그래도 deinit 뒤 rm이 실패하면(권한 등) 실패한 단계와 남은 상태를 stderr 끝에 적는다
#[tauri::command(async)]
pub fn git_submodule_remove(
    path: String,
    sub_path: String,
    force: bool,
) -> Result<OpResult, String> {
    let sub_path = validate_sub_path(&sub_path)?;
    let sub = sub_path.as_str();

    if !force && crate::submodule::is_dirty(&path, sub)? {
        return Ok(refused(
            &path,
            &format!(
                "The submodule {sub} has uncommitted changes. Commit or stash them inside the submodule, or remove it with force to discard them."
            ),
        ));
    }

    let force_arg: &[&str] = if force { &["-f"] } else { &[] };
    let deinit: Vec<&str> = [&["submodule", "deinit"][..], force_arg, &["--", sub]].concat();
    let rm: Vec<&str> = [&["rm"][..], force_arg, &["--", sub]].concat();

    if force {
        let preflight: Vec<&str> = [&["rm", "-n"][..], force_arg, &["--", sub]].concat();
        let checked = run_op(&path, &preflight, LOCAL_TIMEOUT)?;
        if !checked.ok {
            return Ok(checked);
        }
    }

    let mut result = run_chain(&path, &[deinit, rm], LOCAL_TIMEOUT)?;
    if !result.ok {
        let step = if result.command.first().map(String::as_str) == Some("rm") {
            half_removed_note(sub)
        } else {
            format!(
                "Removing {sub} stopped at step 1 of 2 (submodule deinit). The index and .gitmodules were not changed."
            )
        };
        result.stderr = format!("{}\n\n{step}", result.stderr.trim_end());
    }
    Ok(result)
}

/// deinit은 됐는데 rm이 실패했을 때 남은 상태.
fn half_removed_note(sub: &str) -> String {
    format!(
        "Removing {sub} stopped at step 2 of 2 (rm). Step 1 (submodule deinit) already ran: the submodule was unregistered from .git/config and its working tree was cleared. It is still in the index and .gitmodules, and its git directory in .git/modules is kept. Fix the problem above and remove it again, or run `git submodule update --init -- {sub}` to check it out again."
    )
}

/// git을 돌리지 않고 실패 결과를 만든다. command는 비워 둔다(실행한 명령이 없다)
fn refused(path: &str, message: &str) -> OpResult {
    let outcome = Outcome {
        code: Some(1),
        stdout: String::new(),
        stderr: message.to_string(),
        timed_out: false,
    };
    finish(path, &[], outcome, LOCAL_TIMEOUT)
}

/// 비지 않고, 옵션처럼 보이지 않고, NUL이 없는 URL. 앞뒤 공백은 떼어 낸다(붙여넣기)
fn validate_url(url: &str) -> Result<String, String> {
    let url = url.trim();
    if url.is_empty() {
        return Err("No submodule URL was given.".to_string());
    }
    if url.starts_with('-') || url.contains('\0') {
        return Err(format!("Invalid submodule URL: {}", url.replace('\0', "\\0")));
    }
    Ok(url.to_string())
}

/// 서브모듈 경로. `validate_pathspec`(빈 값, `-` 시작)과 NUL 검사를 거친다. 끝의 `/`는 뗀다.
/// `status`가 돌려주는 경로와 맞춰야 dirty 판정이 그 항목을 찾는다
fn validate_sub_path(sub_path: &str) -> Result<String, String> {
    let trimmed = sub_path.trim_end_matches('/');
    validate_pathspec(trimmed)?;
    let mut cleaned = validate_paths(&[trimmed.to_string()])?;
    Ok(cleaned.remove(0))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testrepo::{one, TempRepo};

    fn status_line(repo: &TempRepo, sub: &str) -> String {
        crate::git::run(repo.path(), &["submodule", "status", "--", sub])
            .unwrap()
            .trim_end()
            .to_string()
    }

    fn head_of(repo: &TempRepo, sub: &str) -> String {
        let checkout = format!("{}/{sub}", repo.path());
        crate::git::run(&checkout, &["rev-parse", "HEAD"])
            .unwrap()
            .trim()
            .to_string()
    }

    #[test]
    fn moved_서브모듈을_기록된_커밋으로_되돌리고_reflog에_남긴다() {
        let fx = one();
        fx.parent.git_in("a", &["checkout", "-q", "HEAD~1"]);
        let moved_head = head_of(&fx.parent, "a");

        let result = git_submodule_update(fx.parent.path(), vec!["a".into()], false).unwrap();
        assert!(result.ok, "{}", result.stderr);
        assert_eq!(head_of(&fx.parent, "a"), fx.lib(0).rev("HEAD"));
        assert_eq!(
            result.command,
            ["submodule", "update", "--recursive", "--", "a"]
        );

        let checkout = format!("{}/a", fx.parent.path());
        let reflog = crate::git::run(&checkout, &["reflog", "--format=%H"]).unwrap();
        assert!(
            reflog.contains(&moved_head),
            "옮기기 전 HEAD가 reflog에 남는다"
        );
    }

    #[test]
    fn init은_초기화하지_않은_서브모듈을_체크아웃한다() {
        let fx = one();
        fx.parent.git(&["submodule", "deinit", "-q", "a"]);
        assert!(status_line(&fx.parent, "a").starts_with('-'));

        let result = git_submodule_update(fx.parent.path(), vec!["a".into()], true).unwrap();
        assert!(result.ok, "{}", result.stderr);
        assert!(status_line(&fx.parent, "a").starts_with(' '));
        assert!(result.command.contains(&"--init".to_string()));
    }

    #[test]
    fn 경로가_비면_전부_update한다() {
        let fx = one();
        fx.parent.git_in("a", &["checkout", "-q", "HEAD~1"]);
        let result = git_submodule_update(fx.parent.path(), Vec::new(), false).unwrap();
        assert!(result.ok, "{}", result.stderr);
        assert_eq!(head_of(&fx.parent, "a"), fx.lib(0).rev("HEAD"));
        assert_eq!(result.command.last().map(String::as_str), Some("--"));
    }

    /// `a*`가 glob이면 확인 대화상자에 없던 서브모듈의 HEAD까지 옮긴다
    #[test]
    fn 경로는_glob이_아니라_리터럴이다() {
        let fx = one();
        fx.parent.git_in("a", &["checkout", "-q", "HEAD~1"]);
        let moved_head = head_of(&fx.parent, "a");

        let result = git_submodule_update(fx.parent.path(), vec!["a*".into()], false).unwrap();
        assert!(!result.ok, "리터럴 `a*`는 없는 경로다");
        assert_eq!(head_of(&fx.parent, "a"), moved_head);
    }

    #[test]
    fn 옵션처럼_생긴_경로와_빈_경로는_거절한다() {
        let fx = one();
        assert!(git_submodule_update(fx.parent.path(), vec!["--force".into()], false).is_err());
        assert!(git_submodule_update(fx.parent.path(), vec![String::new()], false).is_err());
        assert!(git_submodule_update(fx.parent.path(), vec!["a\0b".into()], false).is_err());
    }

    /// 로컬 경로 clone 허용(`protocol.file.allow`)은 사용자 설정 몫이다. 우리가 덮지 않는다
    #[test]
    fn protocol_file_allow를_주입하지_않는다() {
        let fx = one();
        let result = git_submodule_update(fx.parent.path(), vec!["a".into()], true).unwrap();
        assert!(
            result.command.iter().all(|arg| !arg.contains("protocol")),
            "{:?}",
            result.command
        );
    }
}
