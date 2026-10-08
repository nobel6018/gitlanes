//! 서브모듈 update (v0.19).
//!
//! @see CONTRACTS.md (v0.19.0)

use crate::commands::validate_pathspec;
use crate::model::OpResult;

use super::run::{run_op, validate_paths, NETWORK_TIMEOUT};

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
