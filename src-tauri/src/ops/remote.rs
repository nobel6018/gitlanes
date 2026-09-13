//! remote 목록과 관리. 이름은 `git remote` 목록으로, URL은 형태만 본다.
//!
//! @see CONTRACTS.md

use crate::git;
use crate::model::{OpResult, RemoteInfo};

use super::run::{run_op, validate_remote, LOCAL_TIMEOUT};

/// 등록된 remote 목록. fetch/push URL이 다른 경우가 있어 둘 다 싣는다.
#[tauri::command]
pub fn list_remotes(path: String) -> Result<Vec<RemoteInfo>, String> {
    let raw = git::run(&path, &["remote", "-v"])?;
    Ok(parse_remotes(&raw))
}

/// `git remote -v`는 remote마다 "(fetch)"와 "(push)" 두 줄을 낸다.
///
/// 줄 순서에 기대지 않고 이름으로 모은다. push URL이 따로 설정되지 않았으면 git이
/// fetch URL을 그대로 내주므로 빠지는 줄은 없지만, 낯선 git 버전에서도 깨지지 않게
/// 한쪽만 온 경우를 다른 쪽으로 메운다.
fn parse_remotes(raw: &str) -> Vec<RemoteInfo> {
    let mut order: Vec<String> = Vec::new();
    let mut fetch: std::collections::HashMap<String, String> = std::collections::HashMap::new();
    let mut push: std::collections::HashMap<String, String> = std::collections::HashMap::new();

    for line in raw.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        // "origin\thttps://…(fetch)"
        let Some((name, rest)) = line.split_once('\t') else {
            continue;
        };
        let name = name.trim().to_string();
        let (url, kind) = match rest.rsplit_once(' ') {
            Some((url, kind)) => (url.trim().to_string(), kind.trim()),
            None => (rest.trim().to_string(), ""),
        };

        if !order.contains(&name) {
            order.push(name.clone());
        }
        match kind {
            "(push)" => {
                push.insert(name, url);
            }
            _ => {
                fetch.insert(name, url);
            }
        }
    }

    order
        .into_iter()
        .map(|name| {
            let fetch_url = fetch.get(&name).or_else(|| push.get(&name)).cloned();
            let push_url = push.get(&name).or_else(|| fetch.get(&name)).cloned();
            RemoteInfo {
                fetch_url: fetch_url.unwrap_or_default(),
                push_url: push_url.unwrap_or_default(),
                name,
            }
        })
        .collect()
}

#[tauri::command]
pub fn git_add_remote(path: String, name: String, url: String) -> Result<OpResult, String> {
    let name = validate_new_remote_name(&name)?;
    let url = validate_url(&url)?;
    run_op(
        &path,
        &["remote", "add", name.as_str(), url.as_str()],
        LOCAL_TIMEOUT,
    )
}

#[tauri::command]
pub fn git_remove_remote(path: String, name: String) -> Result<OpResult, String> {
    let name = validate_remote(&path, &name)?;
    run_op(&path, &["remote", "remove", name.as_str()], LOCAL_TIMEOUT)
}

#[tauri::command]
pub fn git_rename_remote(path: String, from: String, to: String) -> Result<OpResult, String> {
    let from = validate_remote(&path, &from)?;
    let to = validate_new_remote_name(&to)?;
    run_op(
        &path,
        &["remote", "rename", from.as_str(), to.as_str()],
        LOCAL_TIMEOUT,
    )
}

#[tauri::command]
pub fn git_set_remote_url(path: String, name: String, url: String) -> Result<OpResult, String> {
    let name = validate_remote(&path, &name)?;
    let url = validate_url(&url)?;
    run_op(
        &path,
        &["remote", "set-url", name.as_str(), url.as_str()],
        LOCAL_TIMEOUT,
    )
}

/// 아직 없는 remote의 이름. [`validate_remote`]와 달리 목록에 있으면 안 된다.
///
/// 이름 규칙은 git이 `remote add`에서 직접 본다. 여기서는 옵션으로 읽힐 형태와
/// 공백만 막는다.
fn validate_new_remote_name(name: &str) -> Result<String, String> {
    let name = name.trim();
    if name.is_empty() {
        return Err("remote 이름이 비어 있습니다".to_string());
    }
    if name.starts_with('-') || name.contains(char::is_whitespace) {
        return Err(format!("remote 이름 형식이 올바르지 않습니다: {name}"));
    }
    Ok(name.to_string())
}

/// URL은 형태만 본다. 실제로 닿는지는 fetch가 알려준다.
fn validate_url(url: &str) -> Result<String, String> {
    let url = url.trim();
    if url.is_empty() {
        return Err("remote URL이 비어 있습니다".to_string());
    }
    if url.starts_with('-') {
        return Err(format!("remote URL 형식이 올바르지 않습니다: {url}"));
    }
    Ok(url.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ops::network::tests_support::remote_fixture;

    #[test]
    fn remote_v_출력을_이름별로_모은다() {
        let raw = "origin\thttps://example.com/a.git (fetch)\n\
                   origin\tssh://git@example.com/a.git (push)\n\
                   upstream\thttps://example.com/b.git (fetch)\n\
                   upstream\thttps://example.com/b.git (push)\n";
        let parsed = parse_remotes(raw);

        assert_eq!(parsed.len(), 2);
        assert_eq!(parsed[0].name, "origin");
        assert_eq!(parsed[0].fetch_url, "https://example.com/a.git");
        assert_eq!(parsed[0].push_url, "ssh://git@example.com/a.git");
        assert_eq!(parsed[1].name, "upstream");

        assert!(parse_remotes("").is_empty());
    }

    #[test]
    fn 한쪽_url만_와도_다른_쪽으로_메운다() {
        let parsed = parse_remotes("origin\thttps://example.com/a.git (fetch)\n");
        assert_eq!(parsed.len(), 1);
        assert_eq!(parsed[0].push_url, "https://example.com/a.git");
    }

    #[test]
    fn 실제_저장소의_remote를_읽는다() {
        let (origin, repo) = remote_fixture();
        let remotes = list_remotes(repo.path()).unwrap();
        assert_eq!(remotes.len(), 1);
        assert_eq!(remotes[0].name, "origin");
        assert_eq!(remotes[0].fetch_url, origin.path());
    }

    #[test]
    fn remote를_추가하고_이름과_url을_바꾸고_지운다() {
        let (_origin, repo) = remote_fixture();

        let added = git_add_remote(
            repo.path(),
            "upstream".to_string(),
            "https://example.com/x.git".to_string(),
        )
        .unwrap();
        assert!(added.ok, "{added:?}");

        let renamed =
            git_rename_remote(repo.path(), "upstream".to_string(), "fork".to_string()).unwrap();
        assert!(renamed.ok, "{renamed:?}");

        let changed = git_set_remote_url(
            repo.path(),
            "fork".to_string(),
            "https://example.com/y.git".to_string(),
        )
        .unwrap();
        assert!(changed.ok, "{changed:?}");

        let listed = list_remotes(repo.path()).unwrap();
        let fork = listed
            .iter()
            .find(|r| r.name == "fork")
            .expect("fork가 있어야 한다");
        assert_eq!(fork.fetch_url, "https://example.com/y.git");

        let removed = git_remove_remote(repo.path(), "fork".to_string()).unwrap();
        assert!(removed.ok, "{removed:?}");
        assert_eq!(list_remotes(repo.path()).unwrap().len(), 1);
    }

    #[test]
    fn 이미_있는_remote_추가는_ok_false다() {
        let (_origin, repo) = remote_fixture();
        let result = git_add_remote(
            repo.path(),
            "origin".to_string(),
            "https://example.com/x.git".to_string(),
        )
        .unwrap();
        assert!(!result.ok, "{result:?}");
        assert!(!result.stderr.is_empty(), "{result:?}");
    }

    #[test]
    fn 잘못된_이름과_url은_호출_오류다() {
        let (_origin, repo) = remote_fixture();
        assert!(git_add_remote(repo.path(), String::new(), "u".to_string()).is_err());
        assert!(git_add_remote(repo.path(), "-x".to_string(), "u".to_string()).is_err());
        assert!(git_add_remote(repo.path(), "a b".to_string(), "u".to_string()).is_err());
        assert!(git_add_remote(repo.path(), "ok".to_string(), "   ".to_string()).is_err());
        assert!(git_add_remote(repo.path(), "ok".to_string(), "-x".to_string()).is_err());
        // 없는 remote는 수정도 삭제도 못 한다
        assert!(git_remove_remote(repo.path(), "nope".to_string()).is_err());
        assert!(git_set_remote_url(repo.path(), "nope".to_string(), "u".to_string()).is_err());
        assert!(git_rename_remote(repo.path(), "nope".to_string(), "x".to_string()).is_err());
    }
}
