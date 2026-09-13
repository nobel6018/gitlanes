//! 커밋과 그 되돌리기.
//!
//! @see CONTRACTS.md

use crate::git;
use crate::model::{CommitOptions, OpResult};

use super::run::{run_op, LOCAL_TIMEOUT};

/// 인덱스에 올라간 것을 커밋한다.
///
/// 메시지는 `-m`으로 넘긴다. `-m`은 다음 인자를 무조건 값으로 먹어서 메시지가 `-`로
/// 시작해도 옵션이 되지 않고, 프로세스 인자는 셸을 거치지 않아 따옴표 문제도 없다.
/// amend에 메시지가 비어 있으면 `--no-edit`으로 원래 메시지를 유지한다.
#[tauri::command]
pub fn git_commit(path: String, options: CommitOptions) -> Result<OpResult, String> {
    let message = options.message.trim().to_string();
    if message.is_empty() && !options.amend {
        return Err("커밋 메시지가 비어 있습니다".to_string());
    }

    let mut args: Vec<&str> = vec!["commit"];
    if options.amend {
        args.push("--amend");
    }
    if options.signoff {
        args.push("--signoff");
    }
    if options.gpg_sign {
        args.push("--gpg-sign");
    }
    if options.allow_empty {
        args.push("--allow-empty");
    }
    if options.stage_all {
        args.push("-a");
    }
    if message.is_empty() {
        args.push("--no-edit");
    } else {
        args.push("-m");
        args.push(message.as_str());
    }

    run_op(&path, &args, LOCAL_TIMEOUT)
}

/// amend 체크박스를 켰을 때 메시지 상자를 채울 값.
#[tauri::command]
pub fn get_last_commit_message(path: String) -> Result<String, String> {
    git::run(&path, &["log", "-1", "--format=%B"]).map(|out| out.trim_end().to_string())
}

/// `commit.template` 설정이 있으면 그 내용. 없으면 None.
///
/// 설정만 있고 파일이 없는 경우가 흔하다(다른 기계에서 복사해 온 `.gitconfig`).
/// 그건 오류가 아니라 "템플릿 없음"이다.
#[tauri::command]
pub fn get_commit_template(path: String) -> Result<Option<String>, String> {
    let Ok(raw) = git::run(&path, &["config", "--get", "commit.template"]) else {
        return Ok(None);
    };
    let raw = raw.trim();
    if raw.is_empty() {
        return Ok(None);
    }

    let expanded = expand_home(raw);
    Ok(std::fs::read_to_string(expanded).ok())
}

/// `~/`로 시작하는 설정값을 홈 경로로 편다. git은 이 표기를 그대로 받아들인다.
fn expand_home(raw: &str) -> std::path::PathBuf {
    let Some(rest) = raw.strip_prefix("~/") else {
        return std::path::PathBuf::from(raw);
    };
    match std::env::var_os("HOME") {
        Some(home) => std::path::PathBuf::from(home).join(rest),
        None => std::path::PathBuf::from(raw),
    }
}

/// 마지막 커밋만 되돌린다. 변경은 인덱스에 그대로 남는다.
///
/// `reset --soft HEAD~1`은 머지 커밋에서도 안전하다. 첫 부모로 옮기고 트리를 손대지
/// 않으므로 머지 결과가 전부 인덱스에 남는다. `--hard`였다면 그게 사라진다.
#[tauri::command]
pub fn git_undo_commit(path: String) -> Result<OpResult, String> {
    run_op(&path, &["reset", "--soft", "HEAD~1"], LOCAL_TIMEOUT)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testrepo::TempRepo;

    fn options(message: &str) -> CommitOptions {
        CommitOptions {
            message: message.to_string(),
            amend: false,
            signoff: false,
            gpg_sign: false,
            allow_empty: false,
            stage_all: false,
        }
    }

    fn based(prefix: &str) -> TempRepo {
        let repo = TempRepo::init(prefix);
        repo.write("a.txt", "1\n");
        repo.git(&["add", "-A"]);
        repo.git(&["commit", "-qm", "base"]);
        repo
    }

    fn head_message(repo: &TempRepo) -> String {
        git::run(repo.path(), &["log", "-1", "--format=%B"])
            .unwrap()
            .trim_end()
            .to_string()
    }

    fn head_count(repo: &TempRepo) -> usize {
        git::run(repo.path(), &["rev-list", "--count", "HEAD"])
            .unwrap()
            .trim()
            .parse()
            .unwrap()
    }

    #[test]
    fn 스테이지된_변경을_커밋한다() {
        let repo = based("gitlanes-commit");
        repo.write("a.txt", "2\n");
        repo.git(&["add", "-A"]);

        let result = git_commit(repo.path(), options("두 번째\n\n본문 줄")).unwrap();
        assert!(result.ok, "{result:?}");
        assert_eq!(head_message(&repo), "두 번째\n\n본문 줄");
        assert_eq!(head_count(&repo), 2);
    }

    #[test]
    fn 스테이지가_비면_커밋이_실패한다() {
        let repo = based("gitlanes-commit-empty");
        let result = git_commit(repo.path(), options("빈 커밋")).unwrap();
        assert!(!result.ok, "{result:?}");
        assert!(!result.stdout.is_empty() || !result.stderr.is_empty());

        // allow_empty를 켜면 통과한다
        let mut allowed = options("빈 커밋");
        allowed.allow_empty = true;
        assert!(git_commit(repo.path(), allowed).unwrap().ok);
    }

    #[test]
    fn 빈_메시지는_호출_오류다() {
        let repo = based("gitlanes-commit-nomsg");
        assert!(git_commit(repo.path(), options("   ")).is_err());
    }

    #[test]
    fn amend는_커밋을_늘리지_않고_메시지를_바꾼다() {
        let repo = based("gitlanes-amend");
        let mut amend = options("고쳐 쓴 메시지");
        amend.amend = true;

        let result = git_commit(repo.path(), amend).unwrap();
        assert!(result.ok, "{result:?}");
        assert_eq!(head_message(&repo), "고쳐 쓴 메시지");
        assert_eq!(head_count(&repo), 1);
    }

    #[test]
    fn amend에_메시지가_없으면_원래_메시지를_지킨다() {
        let repo = based("gitlanes-amend-noedit");
        repo.write("b.txt", "b\n");
        repo.git(&["add", "-A"]);

        let mut amend = options("");
        amend.amend = true;
        let result = git_commit(repo.path(), amend).unwrap();
        assert!(result.ok, "{result:?}");
        assert_eq!(head_message(&repo), "base");
        assert!(result.command.contains(&"--no-edit".to_string()));
    }

    #[test]
    fn signoff와_stage_all이_인자에_실린다() {
        let repo = based("gitlanes-signoff");
        repo.write("a.txt", "2\n");

        let mut all = options("전부 커밋");
        all.signoff = true;
        all.stage_all = true;
        let result = git_commit(repo.path(), all).unwrap();
        assert!(result.ok, "{result:?}");
        assert!(
            head_message(&repo).contains("Signed-off-by:"),
            "{}",
            head_message(&repo)
        );
        assert_eq!(head_count(&repo), 2);
    }

    #[test]
    fn 마지막_커밋_메시지를_읽는다() {
        let repo = based("gitlanes-lastmsg");
        assert_eq!(get_last_commit_message(repo.path()).unwrap(), "base");
    }

    #[test]
    fn 커밋_템플릿은_설정과_파일이_모두_있어야_값이_된다() {
        let repo = based("gitlanes-template");
        assert_eq!(get_commit_template(repo.path()).unwrap(), None);

        // 설정만 있고 파일이 없으면 여전히 없음이다
        repo.git(&["config", "commit.template", "없는파일.txt"]);
        assert_eq!(get_commit_template(repo.path()).unwrap(), None);

        repo.write("tpl.txt", "제목\n\n# 안내\n");
        repo.git(&["config", "commit.template", "tpl.txt"]);
        // 상대 경로는 저장소 루트가 아니라 프로세스 cwd 기준이라 절대 경로로 다시 건다
        let absolute = format!("{}/tpl.txt", repo.path());
        repo.git(&["config", "commit.template", &absolute]);
        assert_eq!(
            get_commit_template(repo.path()).unwrap().as_deref(),
            Some("제목\n\n# 안내\n")
        );
    }

    #[test]
    fn undo_commit은_변경을_인덱스에_남기고_커밋만_없앤다() {
        let repo = based("gitlanes-undo");
        repo.write("b.txt", "b\n");
        repo.git(&["add", "-A"]);
        repo.git(&["commit", "-qm", "되돌릴 커밋"]);
        assert_eq!(head_count(&repo), 2);

        let result = git_undo_commit(repo.path()).unwrap();
        assert!(result.ok, "{result:?}");
        assert_eq!(head_count(&repo), 1);

        let staged = git::run(repo.path(), &["diff", "--cached", "--name-only"]).unwrap();
        assert_eq!(staged.trim(), "b.txt");
    }

    #[test]
    fn 첫_커밋에서는_undo가_실패한다() {
        let repo = based("gitlanes-undo-root");
        let result = git_undo_commit(repo.path()).unwrap();
        assert!(!result.ok, "{result:?}");
        assert!(!result.stderr.is_empty(), "{result:?}");
    }
}
