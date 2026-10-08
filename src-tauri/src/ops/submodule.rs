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

/// `submodule deinit -f -- <subPath>` 뒤 `rm -f -- <subPath>`. `.gitmodules` 항목과 gitlink
/// 삭제가 스테이지된다. `.git/modules/<name>`은 지우지 않는다(서브모듈 안의 push 안 한 커밋 보존).
///
/// force는 "서브모듈 안의 커밋 안 한 변경을 버린다"는 뜻이다. git의 `-f`는 구현 세부라 아래 검사를
/// 통과하면 늘 준다. `-f` 없는 deinit은 HEAD만 옮겨진(moved) 서브모듈도 거절하는데, 그 커밋은
/// `.git/modules`에 남아 손실이 아니다(CONTRACTS.md v0.20, 감독 결정).
///
/// - index에 gitlink가 아니면 git을 실행하지 않고 ok=false. `deinit -f`는 일반 파일에도 0으로
///   끝나고 `rm -f`는 그 파일의 수정까지 지운다(실측)
/// - force=false인데 서브모듈 안에 커밋 안 한 변경(추적 파일 수정 또는 untracked)이 있으면 git을
///   실행하지 않고 ok=false. 판정은 `get_submodules`의 dirty와 같다
/// - 먼저 `rm -n -f`로 rm이 거절할 조건(스테이지 안 한 `.gitmodules` 수정 등)을 본다. deinit -f는
///   워킹 트리를 비우므로, rm이 뒤에서 거절하면 반쯤 지워진 상태가 남는다
/// - 그래도 deinit 뒤 rm이 실패하면(권한 등) 실패한 단계와 남은 상태를 stderr 끝에 적는다
#[tauri::command(async)]
pub fn git_submodule_remove(
    path: String,
    sub_path: String,
    force: bool,
) -> Result<OpResult, String> {
    let sub_path = validate_sub_path(&sub_path)?;
    let sub = sub_path.as_str();

    let (gitlink, dirty) = crate::submodule::removal_check(&path, sub)?;
    if !gitlink {
        return Ok(refused(
            &path,
            &format!("{sub} is not a submodule in the index. Nothing was removed."),
        ));
    }
    if !force && dirty {
        return Ok(refused(
            &path,
            &format!(
                "The submodule {sub} has uncommitted changes. Commit or stash them inside the submodule, or remove it with force to discard them. The submodule list may not have shown these changes if this repository is set to ignore them (submodule.<name>.ignore, diff.ignoreSubmodules or status.showUntrackedFiles)."
            ),
        ));
    }

    let checked = run_op(&path, &["rm", "-n", "-f", "--", sub], LOCAL_TIMEOUT)?;
    if !checked.ok {
        return Ok(checked);
    }

    let deinit = vec!["submodule", "deinit", "-f", "--", sub];
    let rm = vec!["rm", "-f", "--", sub];
    let mut result = run_chain(&path, &[deinit, rm], LOCAL_TIMEOUT)?;
    if !result.ok {
        append_stop_note(&mut result, sub);
    }
    Ok(result)
}

/// 실패한 단계(result.command의 첫 인자로 가른다)와 남은 상태를 stderr 끝에 붙인다.
fn append_stop_note(result: &mut OpResult, sub: &str) {
    let note = if result.command.first().map(String::as_str) == Some("rm") {
        format!(
            "Removing {sub} stopped at step 2 of 2 (rm). Step 1 (submodule deinit) already ran: the submodule was unregistered from .git/config and its working tree was cleared. It is still in the index and .gitmodules, and its git directory in .git/modules is kept. Fix the problem above and remove it again, or run `git submodule update --init -- {sub}` to check it out again."
        )
    } else {
        format!(
            "Removing {sub} stopped at step 1 of 2 (submodule deinit). The index and .gitmodules were not changed."
        )
    };
    result.stderr = format!("{}\n\n{note}", result.stderr.trim_end());
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
        return Err(format!(
            "Invalid submodule URL: {}",
            url.replace('\0', "\\0")
        ));
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
    use crate::testrepo::{lib, one, with_command_config, TempRepo, LOCAL_CLONE_CONFIG};

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

    fn staged(repo: &TempRepo) -> String {
        crate::git::run(repo.path(), &["diff", "--cached", "--name-status"])
            .unwrap()
            .trim_end()
            .to_string()
    }

    fn add_options(url: &str, sub: &str, branch: Option<&str>) -> AddSubmoduleOptions {
        AddSubmoduleOptions {
            url: url.to_string(),
            path: sub.to_string(),
            branch: branch.map(str::to_string),
        }
    }

    /// 로컬 경로 원본을 clone할 수 있게 테스트 설정을 얹은 add
    fn add(repo: &TempRepo, url: &str, sub: &str, branch: Option<&str>) -> OpResult {
        with_command_config(&LOCAL_CLONE_CONFIG, || {
            git_submodule_add(repo.path(), add_options(url, sub, branch)).unwrap()
        })
    }

    fn modules_dir(repo: &TempRepo, name: &str) -> std::path::PathBuf {
        std::path::Path::new(&repo.path())
            .join(".git/modules")
            .join(name)
    }

    fn registered(repo: &TempRepo, name: &str) -> bool {
        crate::git::run(
            repo.path(),
            &["config", "--get", &format!("submodule.{name}.url")],
        )
        .is_ok()
    }

    #[test]
    fn add는_gitmodules와_gitlink를_스테이지한다() {
        let parent = TempRepo::linear("gitlanes-subadd-parent", 1);
        let lib = lib("gitlanes-subadd-lib");

        let result = add(&parent, &lib.path(), "libs/x", Some("main"));
        assert!(result.ok, "{}", result.stderr);
        assert_eq!(
            result.command,
            [
                "submodule",
                "add",
                "-b",
                "main",
                "--",
                lib.path().as_str(),
                "libs/x"
            ]
        );
        assert_eq!(staged(&parent), "A\t.gitmodules\nA\tlibs/x");

        let stage =
            crate::git::run(parent.path(), &["ls-files", "--stage", "--", "libs/x"]).unwrap();
        assert!(
            stage.starts_with(&format!("160000 {} 0", lib.rev("HEAD"))),
            "{stage}"
        );
        let branch = crate::git::run(
            parent.path(),
            &["config", "-f", ".gitmodules", "submodule.libs/x.branch"],
        )
        .unwrap();
        assert_eq!(branch.trim(), "main");
        assert!(
            crate::git::run(parent.path(), &["log", "-1", "--format=%s"])
                .unwrap()
                .contains("commit 0"),
            "커밋은 사용자가 한다"
        );
    }

    #[test]
    fn branch가_없거나_비면_b를_넘기지_않는다() {
        let parent = TempRepo::linear("gitlanes-subadd-nob", 1);
        let lib = lib("gitlanes-subadd-nob-lib");
        let result = add(&parent, &lib.path(), "x", Some("  "));
        assert!(result.ok, "{}", result.stderr);
        assert!(
            !result.command.contains(&"-b".to_string()),
            "{:?}",
            result.command
        );
    }

    #[test]
    fn 같은_경로_재추가는_git이_거절한다() {
        let fx = one();
        let before = staged(&fx.parent);
        let result = add(&fx.parent, &fx.lib(0).path(), "a", None);
        assert!(!result.ok);
        assert!(
            result.stderr.contains("already exists"),
            "{}",
            result.stderr
        );
        assert_eq!(staged(&fx.parent), before);
    }

    #[test]
    fn 옵션처럼_생긴_url과_잘못된_인자는_거절한다() {
        let parent = TempRepo::linear("gitlanes-subadd-bad", 1);
        let bad = [
            add_options("--upload-pack=touch /tmp/x", "x", None),
            add_options("  -u", "x", None),
            add_options("", "x", None),
            add_options("a\0b", "x", None),
            add_options("../lib", "-x", None),
            add_options("../lib", "", None),
            add_options("../lib", "/", None),
            add_options("../lib", "x\0y", None),
            add_options("../lib", "x", Some("-f")),
        ];
        for options in bad {
            let label = format!("{options:?}");
            assert!(
                git_submodule_add(parent.path(), options).is_err(),
                "{label}"
            );
        }
        assert_eq!(staged(&parent), "");
    }

    /// 로컬 경로 clone 허용(`protocol.file.allow`)은 사용자 설정 몫이다. 사용자가 막아 두면
    /// 우리 command도 막히고 git stderr가 그대로 간다
    #[test]
    fn add는_protocol_file_allow를_덮지_않는다() {
        let parent = TempRepo::linear("gitlanes-subadd-proto", 1);
        let lib = lib("gitlanes-subadd-proto-lib");
        let result = with_command_config(&[("protocol.file.allow", "never")], || {
            git_submodule_add(parent.path(), add_options(&lib.path(), "x", None)).unwrap()
        });
        assert!(!result.ok);
        assert!(
            result.stderr.contains("transport 'file' not allowed"),
            "{}",
            result.stderr
        );
        assert!(
            result.command.iter().all(|arg| !arg.contains("protocol")),
            "{:?}",
            result.command
        );
    }

    #[test]
    fn remove는_gitmodules와_gitlink_삭제를_스테이지하고_modules를_남긴다() {
        let fx = one();
        let result = git_submodule_remove(fx.parent.path(), "a".into(), false).unwrap();
        assert!(result.ok, "{}", result.stderr);
        assert_eq!(
            result.command,
            ["rm", "-f", "--", "a"],
            "마지막 단계의 명령이 남는다. force와 무관하게 -f다"
        );
        assert_eq!(staged(&fx.parent), "M\t.gitmodules\nD\ta");
        assert!(
            modules_dir(&fx.parent, "a").join("HEAD").exists(),
            ".git/modules/a는 남는다"
        );
        assert!(!registered(&fx.parent, "a"), ".git/config에서 빠진다");
        assert!(!std::path::Path::new(&fx.parent.path())
            .join("a/counter.txt")
            .exists());
        assert!(
            crate::git::run(fx.parent.path(), &["log", "-1", "--format=%s"])
                .unwrap()
                .contains("add a"),
            "커밋은 사용자가 한다"
        );
    }

    /// moved(HEAD만 옮겨짐)는 dirty가 아니다. git -f 없는 deinit은 이걸 거절하지만 우리는 늘 -f를
    /// 주므로 force 없이 지워진다. 옮긴 HEAD의 커밋은 `.git/modules`에 남는다
    #[test]
    fn moved는_force_없이도_지워지고_그_커밋이_modules에_남는다() {
        let fx = one();
        fx.parent.git_in("a", &["checkout", "-q", "HEAD~1"]);
        fx.parent
            .git_in("a", &["commit", "-q", "--allow-empty", "-m", "local only"]);
        let local_only = crate::git::run(format!("{}/a", fx.parent.path()), &["rev-parse", "HEAD"])
            .unwrap()
            .trim()
            .to_string();

        let result = git_submodule_remove(fx.parent.path(), "a/".into(), false).unwrap();
        assert!(result.ok, "{}", result.stderr);
        assert_eq!(result.command, ["rm", "-f", "--", "a"], "끝의 /는 뗀다");
        assert_eq!(staged(&fx.parent), "M\t.gitmodules\nD\ta");
        let kept = crate::git::run(
            modules_dir(&fx.parent, "a").to_string_lossy().as_ref(),
            &["cat-file", "-e", &format!("{local_only}^{{commit}}")],
        );
        assert!(kept.is_ok(), "옮긴 HEAD의 커밋은 .git/modules에 남는다");
    }

    fn assert_untouched(fx: &crate::testrepo::Fixture, file: &str, content: &str) {
        let on_disk =
            std::fs::read_to_string(std::path::Path::new(&fx.parent.path()).join(file)).unwrap();
        assert_eq!(on_disk, content);
        assert!(registered(&fx.parent, "a"));
        assert_eq!(staged(&fx.parent), "");
    }

    #[test]
    fn dirty면_force_없이는_git을_실행하지_않고_거절한다() {
        let fx = one();
        fx.parent.write("a/counter.txt", "dirty\n");
        let result = git_submodule_remove(fx.parent.path(), "a".into(), false).unwrap();
        assert!(!result.ok);
        assert!(result.command.is_empty(), "{:?}", result.command);
        assert!(
            result.stderr.contains("uncommitted changes"),
            "{}",
            result.stderr
        );
        assert!(!result.needs_auth);
        assert_untouched(&fx, "a/counter.txt", "dirty\n");
    }

    #[test]
    fn untracked_파일만_있어도_force_없이는_거절한다() {
        let fx = one();
        fx.parent.write("a/new.txt", "new\n");
        let result = git_submodule_remove(fx.parent.path(), "a".into(), false).unwrap();
        assert!(!result.ok);
        assert!(result.command.is_empty(), "{:?}", result.command);
        assert_untouched(&fx, "a/new.txt", "new\n");
    }

    /// 목록(get_submodules)은 숨김 설정을 존중해 dirty=false로 보여 확인창에 경고가 없다.
    /// remove의 검사는 실제 상태를 봐서 거절하고, 문구가 이유를 알린다
    #[test]
    fn ignore_설정으로_숨은_변경도_force_없이는_거절한다() {
        let cases = [
            ("submodule.a.ignore", "all", "a/counter.txt", "dirty\n"),
            ("status.showUntrackedFiles", "no", "a/new.txt", "new\n"),
        ];
        for (key, value, file, content) in cases {
            let fx = one();
            fx.parent.git(&["config", key, value]);
            fx.parent.write(file, content);
            let listed = crate::submodule::get_submodules(fx.parent.path()).unwrap();
            assert!(!listed[0].dirty, "목록은 {key}={value}를 존중한다");

            let result = git_submodule_remove(fx.parent.path(), "a".into(), false).unwrap();
            assert!(!result.ok, "{key}");
            assert!(result.command.is_empty(), "{:?}", result.command);
            assert!(
                result.stderr.contains("set to ignore them"),
                "{}",
                result.stderr
            );
            assert_untouched(&fx, file, content);

            let result = git_submodule_remove(fx.parent.path(), "a".into(), true).unwrap();
            assert!(result.ok, "{key}: {}", result.stderr);
        }
    }

    #[test]
    fn force면_dirty를_버리고_지운다() {
        let fx = one();
        fx.parent.write("a/counter.txt", "dirty\n");
        fx.parent.write("a/new.txt", "new\n");
        let result = git_submodule_remove(fx.parent.path(), "a".into(), true).unwrap();
        assert!(result.ok, "{}", result.stderr);
        assert_eq!(result.command, ["rm", "-f", "--", "a"]);
        assert_eq!(staged(&fx.parent), "M\t.gitmodules\nD\ta");
        assert!(modules_dir(&fx.parent, "a").join("HEAD").exists());
        assert!(!std::path::Path::new(&fx.parent.path())
            .join("a/new.txt")
            .exists());
    }

    /// rm은 스테이지 안 한 `.gitmodules` 수정을 -f로도 거절한다. deinit -f 뒤에 알면 늦다
    #[test]
    fn rm이_거절할_상태면_deinit_전에_멈춘다() {
        let fx = one();
        let gitmodules =
            std::fs::read_to_string(format!("{}/.gitmodules", fx.parent.path())).unwrap();
        fx.parent
            .write(".gitmodules", &format!("{gitmodules}# memo\n"));

        for force in [false, true] {
            let result = git_submodule_remove(fx.parent.path(), "a".into(), force).unwrap();
            assert!(!result.ok);
            assert!(result.stderr.contains(".gitmodules"), "{}", result.stderr);
            assert_eq!(result.command, ["rm", "-n", "-f", "--", "a"]);
            assert!(registered(&fx.parent, "a"), "deinit이 돌지 않았다");
            let checkout = std::path::Path::new(&fx.parent.path()).join("a/counter.txt");
            assert!(checkout.exists(), "force={force}");
        }
    }

    /// deinit은 됐는데 rm이 실패한 반쪽 상태. 상위 디렉토리에 쓰기 권한이 없으면 deinit은 경고만
    /// 내고 0으로 끝나고(빈 디렉토리를 다시 못 만든다), rm은 디렉토리를 못 지워 실패한다.
    /// `rm -n`은 파일시스템을 건드리지 않아 미리 못 잡는다
    #[cfg(unix)] // 권한 비트로 실패를 만든다. Windows에는 같은 픽스처가 없다
    #[test]
    fn deinit_뒤_rm이_실패하면_단계와_남은_상태를_적는다() {
        use std::os::unix::fs::PermissionsExt;

        let parent = TempRepo::linear("gitlanes-subrm-half", 1);
        let lib = lib("gitlanes-subrm-half-lib");
        parent.add_submodule(&lib.path(), "mods/a");
        parent.git(&["commit", "-qm", "add mods/a"]);
        let mods = std::path::Path::new(&parent.path()).join("mods");
        std::fs::set_permissions(&mods, std::fs::Permissions::from_mode(0o555)).unwrap();

        let result = git_submodule_remove(parent.path(), "mods/a".into(), true);
        std::fs::set_permissions(&mods, std::fs::Permissions::from_mode(0o755)).unwrap();
        let result = result.unwrap();

        assert!(!result.ok);
        assert_eq!(result.command, ["rm", "-f", "--", "mods/a"]);
        assert!(
            result.stderr.contains("step 2 of 2 (rm)"),
            "{}",
            result.stderr
        );
        assert!(
            result.stderr.contains("still in the index"),
            "{}",
            result.stderr
        );
        assert!(
            result
                .stderr
                .contains("git submodule update --init -- mods/a"),
            "{}",
            result.stderr
        );
        assert!(!result.needs_auth);
        assert_eq!(staged(&parent), "", "index는 그대로다");
        assert!(!registered(&parent, "mods/a"), "deinit은 이미 돌았다");
    }

    /// `deinit -f`는 일반 파일에도 0으로 끝나고 `rm -f`는 그 파일의 수정까지 지운다
    #[test]
    fn 서브모듈이_아닌_경로는_git을_실행하지_않고_거절한다() {
        let fx = one();
        fx.parent.write("counter.txt", "edited\n");
        for force in [false, true] {
            for target in ["counter.txt", "zz"] {
                let result = git_submodule_remove(fx.parent.path(), target.into(), force).unwrap();
                assert!(!result.ok, "{target} force={force}");
                assert!(result.command.is_empty(), "{:?}", result.command);
                assert!(
                    result.stderr.contains("not a submodule"),
                    "{}",
                    result.stderr
                );
            }
        }
        let on_disk = std::fs::read_to_string(format!("{}/counter.txt", fx.parent.path())).unwrap();
        assert_eq!(on_disk, "edited\n");
        assert_eq!(staged(&fx.parent), "");
    }

    /// deinit -f는 실측으로 실패를 만들 수 없었다(권한, config 잠금 모두 0으로 끝남). 문구만 고정한다
    #[test]
    fn deinit이_실패하면_1단계에서_멈췄다고_적는다() {
        let mut result = refused(
            &TempRepo::linear("gitlanes-subrm-note", 1).path(),
            "fatal: boom",
        );
        result.command = vec![
            "submodule".into(),
            "deinit".into(),
            "-f".into(),
            "--".into(),
            "a".into(),
        ];
        append_stop_note(&mut result, "a");
        assert!(
            result.stderr.starts_with("fatal: boom\n\n"),
            "{}",
            result.stderr
        );
        assert!(result.stderr.contains("step 1 of 2"), "{}", result.stderr);
        assert!(
            result.stderr.contains("were not changed"),
            "{}",
            result.stderr
        );
    }

    /// `a*`가 glob이면 확인 대화상자에 없던 서브모듈까지 지운다
    #[test]
    fn remove의_경로는_glob이_아니라_리터럴이다() {
        let fx = one();
        for force in [false, true] {
            let result = git_submodule_remove(fx.parent.path(), "a*".into(), force).unwrap();
            assert!(!result.ok, "force={force}");
            assert!(registered(&fx.parent, "a"), "force={force}");
            assert_eq!(staged(&fx.parent), "");
            let checkout = std::path::Path::new(&fx.parent.path()).join("a/counter.txt");
            assert!(checkout.exists(), "force={force}");
        }
    }

    /// 이름 자체가 glob 문자를 담은 서브모듈. index 확인과 `rm -n`을 통과하므로 deinit의 리터럴
    /// 처리만 남은 가드다. glob이면 `a[b]`가 `ab`까지 deinit한다
    #[test]
    fn 대괄호_이름의_서브모듈을_지워도_다른_서브모듈은_남는다() {
        let parent = TempRepo::linear("gitlanes-subrm-bracket", 1);
        let lib_ab = lib("gitlanes-subrm-bracket-ab");
        let lib_br = lib("gitlanes-subrm-bracket-br");
        // 테스트 git 호출은 리터럴 pathspec이 아니다. `a[b]`를 먼저 넣어야 `ab`에 걸리지 않는다
        parent.add_submodule(&lib_br.path(), "a[b]");
        parent.add_submodule(&lib_ab.path(), "ab");
        parent.git(&["commit", "-qm", "two"]);

        let result = git_submodule_remove(parent.path(), "a[b]".into(), false).unwrap();
        assert!(result.ok, "{}", result.stderr);
        // git 2.50.1은 이름에 `[`가 든 서브모듈의 `.gitmodules` 항목을 rm에서 지우지 못한다(터미널
        // 실측, 리터럴 여부와 무관). 그래서 gitlink 삭제만 본다
        assert!(staged(&parent).contains("D\ta[b]"), "{}", staged(&parent));
        assert!(!staged(&parent).contains("\tab"), "{}", staged(&parent));
        assert!(registered(&parent, "ab"), "ab는 deinit되지 않는다");
        let checkout = std::path::Path::new(&parent.path()).join("ab/counter.txt");
        assert!(checkout.exists());
    }

    #[test]
    fn remove는_옵션처럼_생긴_경로와_빈_경로를_거절한다() {
        let fx = one();
        for bad in ["--force", "", "/", "a\0b"] {
            assert!(
                git_submodule_remove(fx.parent.path(), bad.into(), true).is_err(),
                "{bad:?}"
            );
        }
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
