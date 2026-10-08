//! 커밋과 그 되돌리기.
//!
//! @see CONTRACTS.md

use crate::git;
use crate::model::{CommitOptions, CommitTemplate, OpResult};

use super::run::{finish, run_op, Outcome, LOCAL_TIMEOUT};

/// 인덱스에 올라간 것을 커밋한다.
///
/// 메시지는 `-m`으로 넘긴다. `-m`은 다음 인자를 무조건 값으로 먹어서 메시지가 `-`로
/// 시작해도 옵션이 되지 않고, 프로세스 인자는 셸을 거치지 않아 따옴표 문제도 없다.
/// amend에 메시지가 비어 있으면 `--no-edit`으로 원래 메시지를 유지한다.
#[tauri::command(async)]
pub fn git_commit(path: String, options: CommitOptions) -> Result<OpResult, String> {
    let message = options.message.trim().to_string();
    if message.is_empty() && !options.amend {
        return Err("Commit message is empty.".to_string());
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
#[tauri::command(async)]
pub fn get_last_commit_message(path: String) -> Result<String, String> {
    git::run(&path, &["log", "-1", "--format=%B"]).map(|out| out.trim_end().to_string())
}

/// `commit.template` 설정이 있으면 그 내용과 주석 줄 접두. 없으면 None.
///
/// 설정만 있고 파일이 없는 경우가 흔하다(다른 기계에서 복사해 온 `.gitconfig`).
/// 그건 오류가 아니라 "템플릿 없음"이다.
#[tauri::command(async)]
pub fn get_commit_template(path: String) -> Result<Option<CommitTemplate>, String> {
    const TEMPLATE_ARGS: [&str; 3] = ["config", "--get", "commit.template"];
    const COMMENT_ARGS: [&str; 4] = [
        "config",
        "-z",
        "--get-regexp",
        r"^core\.comment(char|string)$",
    ];

    let mut outputs = git::run_all(&path, &[&TEMPLATE_ARGS[..], &COMMENT_ARGS[..]]).into_iter();
    let Some(Ok(raw)) = outputs.next() else {
        return Ok(None);
    };
    let raw = raw.trim();
    if raw.is_empty() {
        return Ok(None);
    }
    let Ok(text) = std::fs::read_to_string(expand_home(raw)) else {
        return Ok(None);
    };

    // 설정이 하나도 없으면 git config가 exit 1로 끝난다. 그건 기본값 "#"이다
    let comment_config = outputs.next().and_then(Result::ok).unwrap_or_default();
    Ok(Some(CommitTemplate {
        text,
        comment_prefix: comment_prefix(&comment_config),
    }))
}

/// 주석 접두를 고른다. 입력은 `git config -z --get-regexp`의 `키\n값\0` 목록이다.
///
/// git은 `core.commentChar`와 `core.commentString`을 같은 설정으로 읽어 나중에 나온 값이 이긴다
/// (config.c가 두 키를 한 분기에서 처리한다). 출력이 설정 파일 읽는 순서라 마지막 항목을 쓴다.
/// 한 파일 안에서 하나만 쓰는 보통의 경우 계약 문구("commentString이 있으면 그 값, 없으면
/// commentChar")와 같은 결과다. "auto"는 메시지에 안 쓰인 글자를 고르는 모드인데 템플릿을 지우는
/// 시점에는 그 글자를 알 수 없어 "#"로 둔다.
fn comment_prefix(config: &str) -> String {
    const DEFAULT: &str = "#";
    let last = config
        .split('\0')
        .filter_map(|entry| entry.split_once('\n'))
        .map(|(_, value)| value)
        .last();
    match last {
        Some(value) if !value.is_empty() && value != "auto" => value.to_string(),
        _ => DEFAULT.to_string(),
    }
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
///
/// 루트 커밋은 `HEAD~1`이 없어 git 원문 오류("ambiguous argument 'HEAD~1'")가 그대로 떴다.
/// 거절 문구로 바꾸는 대신 실제로 되돌린다. 브랜치 ref를 지우면 첫 커밋 전 상태가 되고
/// 트리는 인덱스에 남는다(`A a.txt`). 프론트의 성공 문구 "changes are staged"와 정확히 같은
/// 결과이고, 원래 sha는 `.git/logs/HEAD`에 남아 `git reset --soft <sha>`로 되찾는다.
/// 일반 커밋의 `reset --soft`와 되돌릴 수 있는 정도가 같아 거절할 이유가 없다.
///
/// 루트 판정은 커밋 객체의 `parent` 줄로 한다. 얕은 클론의 경계 커밋은 `HEAD~1`이 없지만
/// 부모가 있다. 그걸 루트로 보면 멀쩡한 브랜치를 첫 커밋 전으로 만든다.
#[tauri::command(async)]
pub fn git_undo_commit(path: String) -> Result<OpResult, String> {
    const RESET: [&str; 3] = ["reset", "--soft", "HEAD~1"];

    let Ok(raw) = git::run(&path, &["cat-file", "commit", "HEAD"]) else {
        return Ok(refused(&path, &RESET, "There is no commit to undo yet."));
    };
    let header = raw.split("\n\n").next().unwrap_or_default();
    if header.lines().any(|line| line.starts_with("parent ")) {
        if git::run(&path, &["rev-parse", "--verify", "-q", "HEAD~1"]).is_err() {
            return Ok(refused(
                &path,
                &RESET,
                "The parent commit is not in this shallow clone. Fetch more history (git fetch --deepen=1) and try again.",
            ));
        }
        return run_op(&path, &RESET, LOCAL_TIMEOUT);
    }

    // detached HEAD에 `update-ref -d HEAD`를 걸면 HEAD 파일 자체가 지워져 레포가 깨진다
    let Ok(branch) = git::run(&path, &["symbolic-ref", "-q", "HEAD"]) else {
        return Ok(refused(
            &path,
            &RESET,
            "Cannot undo the first commit on a detached HEAD. Check out a branch first.",
        ));
    };
    let branch = branch.trim_end().to_string();
    let head = git::run(&path, &["rev-parse", "HEAD"])?.trim().to_string();
    // 옛 값을 붙여 확인과 삭제 사이에 브랜치가 움직였으면 git이 거절하게 한다
    run_op(
        &path,
        &[
            "update-ref",
            "-m",
            "undo first commit (GitLanes)",
            "-d",
            branch.as_str(),
            head.as_str(),
        ],
        LOCAL_TIMEOUT,
    )
}

/// git을 돌리지 않고 실패 결과를 만든다. OpResult를 직접 만들지 않고 [`finish`]를 거쳐
/// 필드가 늘어도 이 파일이 깨지지 않게 한다.
fn refused(repo: &str, command: &[&str], message: &str) -> OpResult {
    let outcome = Outcome {
        code: Some(1),
        stdout: String::new(),
        stderr: message.to_string(),
        timed_out: false,
    };
    finish(repo, command, outcome, LOCAL_TIMEOUT)
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

    /// pathspec 리터럴 처리가 사용자 훅까지 새어 들어가지 않는지 본다.
    /// 훅 안의 glob은 사용자가 터미널에서 커밋할 때와 똑같이 풀려야 한다.
    #[cfg(unix)]
    #[test]
    fn pre_commit_훅의_glob은_평소대로_풀린다() {
        use std::os::unix::fs::PermissionsExt;

        let repo = based("gitlanes-commit-hook");
        let seen = format!("{}/.git/hook-seen", repo.path());
        let hook = format!("{}/.git/hooks/pre-commit", repo.path());
        std::fs::write(
            &hook,
            format!("#!/bin/sh\ngit diff --cached --name-only -- '*.txt' > '{seen}'\n"),
        )
        .unwrap();
        std::fs::set_permissions(&hook, std::fs::Permissions::from_mode(0o755)).unwrap();

        repo.write("a.txt", "2\n");
        repo.git(&["add", "-A"]);
        let result = git_commit(repo.path(), options("훅 확인")).unwrap();
        assert!(result.ok, "{result:?}");
        assert_eq!(
            std::fs::read_to_string(&seen).unwrap().trim(),
            "a.txt",
            "훅의 '*.txt'가 리터럴로 해석돼 아무것도 못 찾았다"
        );
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

    fn template_text(repo: &TempRepo) -> Option<String> {
        get_commit_template(repo.path()).unwrap().map(|t| t.text)
    }

    fn template_prefix(repo: &TempRepo) -> String {
        get_commit_template(repo.path())
            .unwrap()
            .expect("템플릿이 있어야 한다")
            .comment_prefix
    }

    /// 템플릿 파일을 만들고 절대 경로로 건다. 상대 경로는 저장소 루트가 아니라 프로세스 cwd 기준이다
    fn with_template(prefix: &str, content: &str) -> TempRepo {
        let repo = based(prefix);
        repo.write("tpl.txt", content);
        let absolute = format!("{}/tpl.txt", repo.path());
        repo.git(&["config", "commit.template", &absolute]);
        repo
    }

    #[test]
    fn 커밋_템플릿은_설정과_파일이_모두_있어야_값이_된다() {
        let repo = based("gitlanes-template");
        assert_eq!(template_text(&repo), None);

        // 설정만 있고 파일이 없으면 여전히 없음이다
        repo.git(&["config", "commit.template", "없는파일.txt"]);
        assert_eq!(template_text(&repo), None);

        let repo = with_template("gitlanes-template", "제목\n\n# 안내\n");
        assert_eq!(
            get_commit_template(repo.path()).unwrap(),
            Some(CommitTemplate {
                text: "제목\n\n# 안내\n".to_string(),
                comment_prefix: "#".to_string(),
            })
        );
    }

    #[test]
    fn 커밋_템플릿_주석_접두는_comment_char를_따르고_auto는_샵이다() {
        let repo = with_template("gitlanes-template-char", "; 안내\n");
        repo.git(&["config", "core.commentChar", ";"]);
        assert_eq!(template_prefix(&repo), ";");

        repo.git(&["config", "core.commentChar", "auto"]);
        assert_eq!(template_prefix(&repo), "#");
    }

    #[test]
    fn 커밋_템플릿_주석_접두는_comment_string을_따른다() {
        let repo = with_template("gitlanes-template-string", "// 안내\n");
        repo.git(&["config", "core.commentString", "//"]);
        assert_eq!(template_prefix(&repo), "//");
    }

    #[test]
    fn 주석_접두는_나중에_나온_설정이_이긴다() {
        assert_eq!(comment_prefix(""), "#");
        assert_eq!(comment_prefix("core.commentchar\n;\0"), ";");
        assert_eq!(
            comment_prefix("core.commentchar\n;\0core.commentstring\n//\0"),
            "//"
        );
        assert_eq!(
            comment_prefix("core.commentstring\n//\0core.commentchar\n;\0"),
            ";"
        );
        assert_eq!(comment_prefix("core.commentchar\nauto\0"), "#");
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

    /// R-L1. 루트 커밋에는 `HEAD~1`이 없다. 브랜치를 첫 커밋 전으로 돌려 변경을 인덱스에 남긴다.
    #[test]
    fn 첫_커밋의_undo는_브랜치를_첫_커밋_전으로_돌린다() {
        let repo = based("gitlanes-undo-root");
        let root = repo.rev("HEAD");

        let result = git_undo_commit(repo.path()).unwrap();
        assert!(result.ok, "{result:?}");
        assert!(
            git::run(repo.path(), &["rev-parse", "--verify", "-q", "HEAD"]).is_err(),
            "HEAD가 아직 커밋을 가리킨다"
        );
        assert_eq!(
            git::run(repo.path(), &["status", "--porcelain"]).unwrap(),
            "A  a.txt\n",
            "변경이 인덱스에 남아야 한다"
        );
        // 되찾을 길이 남아 있다. HEAD reflog에 원래 sha가 있다
        let reflog = std::fs::read_to_string(format!("{}/.git/logs/HEAD", repo.path())).unwrap();
        assert!(reflog.contains(&root), "{reflog}");
    }

    #[test]
    fn 커밋이_없으면_undo는_읽을_수_있는_이유로_실패한다() {
        let repo = TempRepo::init("gitlanes-undo-unborn");
        let result = git_undo_commit(repo.path()).unwrap();
        assert!(!result.ok, "{result:?}");
        assert!(result.stderr.contains("no commit to undo"), "{result:?}");
    }

    /// detached HEAD의 루트 커밋은 지울 브랜치가 없다. `update-ref -d HEAD`는 HEAD 파일 자체를
    /// 지워 레포를 망가뜨리므로 거절한다.
    #[test]
    fn detached_루트_커밋의_undo는_거절한다() {
        let repo = based("gitlanes-undo-detached");
        let root = repo.rev("HEAD");
        repo.git(&["checkout", "-q", "--detach"]);

        let result = git_undo_commit(repo.path()).unwrap();
        assert!(!result.ok, "{result:?}");
        assert!(result.stderr.contains("detached"), "{result:?}");
        assert_eq!(repo.rev("HEAD"), root);
        assert_eq!(repo.rev("main"), root);
    }

    /// 얕은 클론의 경계 커밋은 부모가 있지만 받아 오지 않았다. 루트로 오인해 브랜치를 지우면 안 된다.
    #[test]
    fn 얕은_클론의_경계_커밋은_루트로_보지_않는다() {
        let origin = based("gitlanes-undo-origin");
        origin.write("b.txt", "b\n");
        origin.git(&["add", "-A"]);
        origin.git(&["commit", "-qm", "두 번째"]);

        let shallow = TempRepo::init("gitlanes-undo-shallow");
        let url = format!("file://{}", origin.path());
        shallow.git(&["fetch", "-q", "--depth", "1", url.as_str(), "main"]);
        shallow.git(&["update-ref", "refs/heads/main", "FETCH_HEAD"]);
        shallow.git(&["reset", "-q", "--hard"]);
        let tip = shallow.rev("HEAD");

        let result = git_undo_commit(shallow.path()).unwrap();
        assert!(!result.ok, "{result:?}");
        assert!(result.stderr.contains("shallow"), "{result:?}");
        assert_eq!(shallow.rev("main"), tip, "브랜치가 지워졌다");
    }
}
