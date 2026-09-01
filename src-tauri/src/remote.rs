//! remote URL을 웹에서 열 수 있는 형태로 정규화한다. git을 실행하지 않는 순수 계산이다.
//!
//! 컨텍스트 메뉴의 "Open on GitHub"이 `<url>/commit/<sha>`를 여는 데 쓴다.
//!
//! @see CONTRACTS.md

/// git remote URL을 `https://host/owner/repo` 형태로 바꾼다.
///
/// - `git@host:a/b.git` → `https://host/a/b`
/// - `ssh://git@host:2222/a/b.git` → `https://host/a/b` (포트는 웹 URL에 의미가 없어 버린다)
/// - `https://host/a/b.git` → `https://host/a/b` (scheme 유지, `.git`만 제거)
///
/// 로컬 경로나 `file://`처럼 웹에서 열 수 없는 remote는 None이다.
pub fn normalize_remote_url(raw: &str) -> Option<String> {
    let raw = raw.trim();
    if raw.is_empty() {
        return None;
    }

    let (scheme, rest) = if let Some(rest) = raw.strip_prefix("https://") {
        ("https", rest)
    } else if let Some(rest) = raw.strip_prefix("http://") {
        ("http", rest)
    } else if let Some(rest) = raw.strip_prefix("ssh://") {
        ("https", rest)
    } else if let Some(rest) = raw.strip_prefix("git://") {
        ("https", rest)
    } else if raw.starts_with("file://") || raw.starts_with('/') || raw.starts_with('.') {
        // 로컬 저장소는 열 웹 주소가 없다
        return None;
    } else {
        // scp 형태: [user@]host:path
        let (authority, path) = raw.split_once(':')?;
        // 윈도우 드라이브 경로(C:\repo)를 host로 오해하지 않는다
        let host = host_of(authority);
        if host.len() < 2 {
            return None;
        }
        return build(scheme_for_scp(), host, path);
    };

    // scheme이 있는 형태: [user[:pass]@]host[:port]/path
    let (authority, path) = rest.split_once('/')?;
    build(scheme, host_of(authority), path)
}

fn scheme_for_scp() -> &'static str {
    "https"
}

/// `[user[:pass]@]host[:port]`에서 host만 뽑는다.
/// 경로에 `@`가 있어도 영향받지 않도록 authority 부분에만 적용한다.
fn host_of(authority: &str) -> &str {
    let host = authority.rsplit('@').next().unwrap_or(authority);
    host.split_once(':').map(|(host, _)| host).unwrap_or(host)
}

fn build(scheme: &str, host: &str, path: &str) -> Option<String> {
    let path = path.trim_matches('/');
    let path = path.strip_suffix(".git").unwrap_or(path);
    let path = path.trim_end_matches('/');
    if host.is_empty() || path.is_empty() {
        return None;
    }
    Some(format!("{scheme}://{host}/{path}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scp_형태를_https로_바꾼다() {
        assert_eq!(
            normalize_remote_url("git@github.com:nobel6018/gitlanes.git").as_deref(),
            Some("https://github.com/nobel6018/gitlanes")
        );
        // .git이 없어도 된다
        assert_eq!(
            normalize_remote_url("git@github.com:nobel6018/gitlanes").as_deref(),
            Some("https://github.com/nobel6018/gitlanes")
        );
        // user가 git이 아니어도 된다
        assert_eq!(
            normalize_remote_url("deploy@gitlab.example.com:team/app.git").as_deref(),
            Some("https://gitlab.example.com/team/app")
        );
        // user 없이 host:path만
        assert_eq!(
            normalize_remote_url("github.com:a/b.git").as_deref(),
            Some("https://github.com/a/b")
        );
    }

    #[test]
    fn ssh_scheme을_https로_바꾼다() {
        assert_eq!(
            normalize_remote_url("ssh://git@github.com/nobel6018/gitlanes.git").as_deref(),
            Some("https://github.com/nobel6018/gitlanes")
        );
        assert_eq!(
            normalize_remote_url("ssh://github.com/a/b").as_deref(),
            Some("https://github.com/a/b")
        );
    }

    #[test]
    fn ssh_포트는_버린다() {
        assert_eq!(
            normalize_remote_url("ssh://git@git.example.com:2222/team/app.git").as_deref(),
            Some("https://git.example.com/team/app")
        );
        assert_eq!(
            normalize_remote_url("ssh://git.example.com:7999/scm/proj/repo.git").as_deref(),
            Some("https://git.example.com/scm/proj/repo")
        );
    }

    #[test]
    fn https는_git_접미사만_제거한다() {
        assert_eq!(
            normalize_remote_url("https://github.com/nobel6018/gitlanes.git").as_deref(),
            Some("https://github.com/nobel6018/gitlanes")
        );
        assert_eq!(
            normalize_remote_url("https://github.com/nobel6018/gitlanes").as_deref(),
            Some("https://github.com/nobel6018/gitlanes")
        );
        // http는 scheme을 유지한다
        assert_eq!(
            normalize_remote_url("http://git.internal/a/b.git").as_deref(),
            Some("http://git.internal/a/b")
        );
        // 토큰이 박힌 URL에서도 host를 제대로 뽑는다
        assert_eq!(
            normalize_remote_url("https://user:token@github.com/a/b.git").as_deref(),
            Some("https://github.com/a/b")
        );
    }

    #[test]
    fn git_프로토콜도_https로_바꾼다() {
        assert_eq!(
            normalize_remote_url("git://github.com/a/b.git").as_deref(),
            Some("https://github.com/a/b")
        );
    }

    #[test]
    fn 웹에서_열_수_없는_remote는_none이다() {
        assert_eq!(normalize_remote_url(""), None);
        assert_eq!(normalize_remote_url("   "), None);
        assert_eq!(normalize_remote_url("/Users/levit/leedo/gitlanes"), None);
        assert_eq!(normalize_remote_url("../sibling-repo"), None);
        assert_eq!(normalize_remote_url("file:///Users/levit/repo"), None);
        assert_eq!(normalize_remote_url("C:\\Users\\levit\\repo"), None);
        // host만 있고 경로가 없으면 열 곳이 없다
        assert_eq!(normalize_remote_url("git@github.com:"), None);
        assert_eq!(normalize_remote_url("https://github.com/"), None);
    }

    #[test]
    fn 경로에_at이_있어도_host를_잘못_읽지_않는다() {
        assert_eq!(
            normalize_remote_url("https://github.com/a/b@c.git").as_deref(),
            Some("https://github.com/a/b@c")
        );
    }

    #[test]
    fn 끝의_슬래시를_정리한다() {
        assert_eq!(
            normalize_remote_url("https://github.com/a/b.git/").as_deref(),
            Some("https://github.com/a/b")
        );
    }
}
