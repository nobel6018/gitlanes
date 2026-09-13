//! 태그 생성, 삭제, 원격 반영.
//!
//! @see CONTRACTS.md

use crate::model::OpResult;

use super::run::{
    run_op, validate_commitish, validate_ref_name, validate_remote, LOCAL_TIMEOUT, NETWORK_TIMEOUT,
};

/// `message`가 있으면 annotated 태그, 없으면 lightweight 태그다.
#[tauri::command]
pub fn git_create_tag(
    path: String,
    name: String,
    target: String,
    message: Option<String>,
) -> Result<OpResult, String> {
    let name = validate_ref_name(&path, &name)?;
    let target = validate_commitish(&path, &target)?;
    let message = message
        .as_deref()
        .map(str::trim)
        .filter(|message| !message.is_empty())
        .map(str::to_string);

    let mut args: Vec<&str> = vec!["tag"];
    // -m이 다음 인자를 값으로 먹으므로 메시지가 "-"로 시작해도 옵션이 되지 않는다
    if let Some(message) = message.as_deref() {
        args.push("-a");
        args.push("-m");
        args.push(message);
    }
    args.push(name.as_str());
    args.push(target.as_str());

    run_op(&path, &args, LOCAL_TIMEOUT)
}

#[tauri::command]
pub fn git_delete_tag(path: String, name: String) -> Result<OpResult, String> {
    let name = validate_ref_name(&path, &name)?;
    run_op(&path, &["tag", "-d", name.as_str()], LOCAL_TIMEOUT)
}

/// 태그 하나를 원격에 올리거나 원격에서 지운다.
///
/// `refs/tags/`를 붙여 넘긴다. 같은 이름의 브랜치가 있을 때 git이 무엇을 밀지 헷갈리지
/// 않게 하려는 것이다.
#[tauri::command]
pub fn git_push_tag(
    path: String,
    remote: String,
    name: String,
    delete: bool,
) -> Result<OpResult, String> {
    let remote = validate_remote(&path, &remote)?;
    let name = validate_ref_name(&path, &name)?;
    let refspec = format!("refs/tags/{name}");

    let mut args: Vec<&str> = vec!["push", remote.as_str()];
    if delete {
        args.push("--delete");
    }
    args.push(refspec.as_str());

    run_op(&path, &args, NETWORK_TIMEOUT)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git;
    use crate::ops::network::tests_support::remote_fixture;

    fn tags(repo: &crate::testrepo::TempRepo) -> String {
        git::run(repo.path(), &["tag", "--list"]).unwrap()
    }

    #[test]
    fn lightweight와_annotated_태그를_만든다() {
        let (_origin, repo) = remote_fixture();

        let light =
            git_create_tag(repo.path(), "v1".to_string(), "HEAD".to_string(), None).unwrap();
        assert!(light.ok, "{light:?}");
        assert!(!light.command.contains(&"-a".to_string()));

        let annotated = git_create_tag(
            repo.path(),
            "v2".to_string(),
            "HEAD".to_string(),
            Some("두 번째 릴리스".to_string()),
        )
        .unwrap();
        assert!(annotated.ok, "{annotated:?}");

        assert!(tags(&repo).contains("v1"));
        assert!(tags(&repo).contains("v2"));

        // annotated만 태그 객체 메시지를 갖는다
        let message = git::run(repo.path(), &["tag", "-n", "--list", "v2"]).unwrap();
        assert!(message.contains("두 번째 릴리스"), "{message}");
    }

    #[test]
    fn 태그_생성은_중복과_잘못된_대상을_거부한다() {
        let (_origin, repo) = remote_fixture();
        assert!(
            git_create_tag(repo.path(), "v1".to_string(), "HEAD".to_string(), None)
                .unwrap()
                .ok
        );

        let dup = git_create_tag(repo.path(), "v1".to_string(), "HEAD".to_string(), None).unwrap();
        assert!(!dup.ok, "{dup:?}");
        assert!(!dup.stderr.is_empty(), "{dup:?}");

        assert!(git_create_tag(repo.path(), "-x".to_string(), "HEAD".to_string(), None).is_err());
        assert!(
            git_create_tag(repo.path(), "v3".to_string(), "없는커밋".to_string(), None).is_err()
        );
    }

    #[test]
    fn 태그를_지운다() {
        let (_origin, repo) = remote_fixture();
        repo.git(&["tag", "v1"]);

        let result = git_delete_tag(repo.path(), "v1".to_string()).unwrap();
        assert!(result.ok, "{result:?}");
        assert!(tags(&repo).trim().is_empty());

        let again = git_delete_tag(repo.path(), "v1".to_string()).unwrap();
        assert!(!again.ok, "{again:?}");
    }

    #[test]
    fn 태그를_원격에_올리고_지운다() {
        let (origin, repo) = remote_fixture();
        repo.git(&["tag", "v1"]);

        let pushed =
            git_push_tag(repo.path(), "origin".to_string(), "v1".to_string(), false).unwrap();
        assert!(pushed.ok, "{pushed:?}");
        assert!(git::run(origin.path(), &["tag", "--list"])
            .unwrap()
            .contains("v1"));

        let deleted =
            git_push_tag(repo.path(), "origin".to_string(), "v1".to_string(), true).unwrap();
        assert!(deleted.ok, "{deleted:?}");
        assert!(deleted.command.contains(&"--delete".to_string()));
        assert!(git::run(origin.path(), &["tag", "--list"])
            .unwrap()
            .trim()
            .is_empty());
    }

    #[test]
    fn 태그_푸시는_등록되지_않은_remote를_거부한다() {
        let (_origin, repo) = remote_fixture();
        repo.git(&["tag", "v1"]);
        assert!(git_push_tag(repo.path(), "nope".to_string(), "v1".to_string(), false).is_err());
    }
}
