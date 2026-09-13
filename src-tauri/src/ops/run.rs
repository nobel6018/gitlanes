//! 모든 쓰기 command가 공유하는 실행기.
//!
//! 여기 걸어둔 제약이 "앱이 멈추지 않는다"는 보장의 전부다.
//!
//! - **절대 프롬프트를 띄우지 않는다.** stdin을 막고 `GIT_TERMINAL_PROMPT=0`,
//!   `GIT_SSH_COMMAND=ssh -oBatchMode=yes`, `GIT_ASKPASS`/`SSH_ASKPASS`를 빈 값으로 둔다.
//!   자격증명이 없으면 물어보지 않고 실패한다. 앱에는 터미널이 없어서 한 번 물어보면
//!   프로세스가 영구히 멈춘다.
//! - **타임아웃이 있다.** 네트워크 120초, 로컬 60초. 넘으면 kill + wait 후
//!   `ok=false`, `stderr="timed out after Ns"`.
//! - **종료 코드는 오류가 아니다.** non-fast-forward나 인증 실패는 사용자가 읽어야 하는
//!   결과라서 `ok=false` + stderr로 돌려준다. `Err`는 인자 검증 실패에만 쓴다.
//! - **인증 실패는 따로 표시한다.** 프롬프트를 막았다는 것은 ssh-agent나 keychain이
//!   없는 환경에서 반드시 실패한다는 뜻이다. 그 경우 [`OpResult::needs_auth`]를 켜고
//!   실행한 인자를 [`OpResult::command`]에 담아 프론트가 내장 터미널로 넘기게 한다.
//! - **`--force`는 쓰지 않는다.** push는 `--force-with-lease`만 허용한다.
//!
//! @see CONTRACTS.md

use std::ffi::OsStr;
use std::io::{Read, Write};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use crate::git;
use crate::model::OpResult;

/// 네트워크를 타는 작업(fetch/pull/push)의 상한.
pub const NETWORK_TIMEOUT: Duration = Duration::from_secs(120);

/// 로컬만 만지는 작업(checkout/branch/merge/stash)의 상한.
pub const LOCAL_TIMEOUT: Duration = Duration::from_secs(60);

/// 종료를 기다리는 폴링 간격. 사람이 못 느끼는 지연이면서 폴링 비용도 없는 값.
const POLL_INTERVAL: Duration = Duration::from_millis(20);

/// stdout/stderr에서 보관할 줄 수. 프론트가 토스트에 그대로 뿌리므로 상한이 필요하다.
const MAX_OUTPUT_LINES: usize = 200;

/// 충돌 파일 목록을 뽑는 인자.
const CONFLICT_ARGS: [&str; 3] = ["diff", "--name-only", "--diff-filter=U"];

/// stderr가 이 중 하나를 담고 있으면 자격증명 문제로 본다.
///
/// 종료 코드로는 구분되지 않는다. git은 인증 실패도 128로 끝내서 non-fast-forward와
/// 같아진다. 문구로 가르는 수밖에 없고, 그래서 `LC_ALL=C`로 로케일을 고정해 둔다.
const AUTH_MARKERS: [&str; 10] = [
    "authentication failed",
    "permission denied",
    "could not read username",
    "could not read password",
    "terminal prompts disabled",
    "host key verification failed",
    "publickey",
    "access denied",
    "support for password authentication was removed",
    "invalid username or token",
];

/// 위 목록과 달리 HTTP 상태 문구라 대소문자가 섞여 온다. 소문자로 내려 비교한다.
const AUTH_MARKER_403: &str = "403 forbidden";

/// 실행 결과 원본. [`finish`]가 이걸 [`OpResult`]로 바꾼다.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Outcome {
    /// 시그널로 죽으면 None
    pub code: Option<i32>,
    pub stdout: String,
    pub stderr: String,
    pub timed_out: bool,
}

/// 비대화식 git 명령을 만든다. 여기 걸어둔 환경변수가 "멈추지 않는다"는 보장의 전부다.
pub fn op_command<S: AsRef<OsStr>>(repo: &str, args: &[S]) -> Command {
    let mut cmd = Command::new("git");
    cmd.arg("-c")
        .arg("core.quotepath=false")
        .arg("-C")
        .arg(repo);
    cmd.args(args);

    // 호스트 환경의 git 설정이 새어 들어오지 않게 한다
    cmd.env_remove("GIT_DIR");
    cmd.env_remove("GIT_WORK_TREE");
    cmd.env_remove("GIT_INDEX_FILE");

    // 자격증명이나 호스트 키를 물어보지 않고 실패시킨다
    cmd.env("GIT_TERMINAL_PROMPT", "0");
    cmd.env("GIT_SSH_COMMAND", "ssh -oBatchMode=yes");
    cmd.env("GIT_ASKPASS", "");
    cmd.env("SSH_ASKPASS", "");

    // 오류 메시지를 파싱한다(needs_auth). 로케일에 따라 문구가 흔들리면 판정이 깨진다.
    cmd.env("LANG", "C");
    cmd.env("LC_ALL", "C");

    // 편집기를 띄우려는 경로가 남아 있어도 여기서 막힌다
    cmd.env("GIT_EDITOR", "true");

    cmd.stdin(Stdio::null());
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());
    cmd
}

/// 자식 프로세스를 타임아웃과 함께 실행한다.
///
/// 테스트가 git 대신 다른 프로그램을 넣을 수 있게 [`Command`]를 그대로 받는다.
pub fn execute(command: Command, timeout: Duration) -> Result<Outcome, String> {
    execute_with_input(command, timeout, None)
}

/// stdin에 바이트를 흘려넣는 변형. `git apply`가 패치를 이 경로로 받는다.
///
/// stdout/stderr는 물론 **stdin 쓰기도 별도 스레드**여야 한다. 패치가 파이프 버퍼(보통
/// 64KB)보다 크면 부모는 쓰기에서, 자식은 출력 쓰기에서 서로를 기다리다 타임아웃까지
/// 교착된다. 다 쓰고 나면 파이프를 닫아야 `git apply`가 EOF를 보고 끝난다.
pub fn execute_with_input(
    mut command: Command,
    timeout: Duration,
    input: Option<Vec<u8>>,
) -> Result<Outcome, String> {
    if input.is_some() {
        command.stdin(Stdio::piped());
    }

    let mut child = command
        .spawn()
        .map_err(|e| format!("git 실행에 실패했습니다. git이 설치되어 있는지 확인하세요: {e}"))?;

    let mut stdout = child.stdout.take();
    let mut stderr = child.stderr.take();
    let mut stdin = child.stdin.take();

    std::thread::scope(|scope| {
        let out_reader = scope.spawn(move || drain(stdout.as_mut()));
        let err_reader = scope.spawn(move || drain(stderr.as_mut()));
        // 쓰기가 끝나면 stdin을 drop해서 파이프를 닫는다. 닫지 않으면 자식이 EOF를
        // 못 보고 영원히 기다린다.
        let in_writer = scope.spawn(move || {
            if let (Some(mut pipe), Some(bytes)) = (stdin.take(), input) {
                let _ = pipe.write_all(&bytes);
                let _ = pipe.flush();
            }
        });

        let deadline = Instant::now() + timeout;
        let mut status = None;
        loop {
            match child.try_wait() {
                Ok(Some(done)) => {
                    status = Some(done);
                    break;
                }
                Ok(None) => {}
                Err(error) => return Err(format!("git 종료를 기다리지 못했습니다: {error}")),
            }
            if Instant::now() >= deadline {
                break;
            }
            std::thread::sleep(POLL_INTERVAL);
        }

        // kill을 해야 파이프가 닫히고 읽기 스레드가 끝난다
        let timed_out = status.is_none();
        if timed_out {
            let _ = child.kill();
            let _ = child.wait();
        }

        let _ = in_writer.join();
        Ok(Outcome {
            code: status.and_then(|status| status.code()),
            stdout: out_reader.join().unwrap_or_default(),
            stderr: err_reader.join().unwrap_or_default(),
            timed_out,
        })
    })
}

/// 파이프를 끝까지 읽는다. 임의 인코딩이 올 수 있어 lossy 변환을 쓴다.
fn drain<R: Read>(source: Option<&mut R>) -> String {
    let Some(source) = source else {
        return String::new();
    };
    let mut buffer = Vec::new();
    let _ = source.read_to_end(&mut buffer);
    String::from_utf8_lossy(&buffer).into_owned()
}

/// git 쓰기 명령 하나를 실행하고 결과를 [`OpResult`]로 돌려준다.
///
/// `Err`는 프로세스를 띄우지도 못한 경우뿐이다. 그 밖의 실패는 `ok=false`다.
pub fn run_op(repo: &str, args: &[&str], timeout: Duration) -> Result<OpResult, String> {
    let outcome = execute(op_command(repo, args), timeout)?;
    Ok(finish(repo, args, outcome, timeout))
}

/// stdin으로 바이트를 넘기는 변형.
pub fn run_op_with_input(
    repo: &str,
    args: &[&str],
    timeout: Duration,
    input: Vec<u8>,
) -> Result<OpResult, String> {
    let outcome = execute_with_input(op_command(repo, args), timeout, Some(input))?;
    Ok(finish(repo, args, outcome, timeout))
}

/// 환경변수를 더 얹어야 하는 변형. `git_rebase_interactive`의 에디터 주입 전용이다.
pub fn run_op_with_env(
    repo: &str,
    args: &[&str],
    timeout: Duration,
    envs: &[(&str, String)],
) -> Result<OpResult, String> {
    let mut command = op_command(repo, args);
    for (key, value) in envs {
        command.env(key, value);
    }
    let outcome = execute(command, timeout)?;
    Ok(finish(repo, args, outcome, timeout))
}

/// 여러 git 명령을 순서대로 실행하고 하나의 결과로 합친다.
///
/// "checkout --ours 하고 add" 처럼 한 UI 동작이 두 명령인 경우가 있다. 첫 실패에서 멈추고
/// 그 명령을 `command`에 담는다. 터미널 핸드오프가 실패한 지점을 그대로 재현해야 한다.
pub fn run_chain(repo: &str, steps: &[Vec<&str>], timeout: Duration) -> Result<OpResult, String> {
    let mut merged: Option<OpResult> = None;
    for step in steps {
        let result = run_op(repo, step, timeout)?;
        let ok = result.ok;
        merged = Some(match merged.take() {
            None => result,
            Some(previous) => OpResult {
                ok: result.ok,
                stdout: join_output(&previous.stdout, &result.stdout),
                stderr: join_output(&previous.stderr, &result.stderr),
                conflicts: result.conflicts,
                command: result.command,
                needs_auth: previous.needs_auth || result.needs_auth,
            },
        });
        if !ok {
            break;
        }
    }
    merged.ok_or_else(|| "실행할 명령이 없습니다".to_string())
}

fn join_output(first: &str, second: &str) -> String {
    match (first.trim().is_empty(), second.trim().is_empty()) {
        (true, _) => second.to_string(),
        (_, true) => first.to_string(),
        _ => format!("{}\n{}", first.trim_end(), second),
    }
}

pub fn finish(repo: &str, args: &[&str], outcome: Outcome, timeout: Duration) -> OpResult {
    let conflicts = collect_conflicts(repo);
    let command: Vec<String> = args.iter().map(|arg| (*arg).to_string()).collect();

    if outcome.timed_out {
        return OpResult {
            ok: false,
            stdout: tail(&outcome.stdout),
            stderr: format!("timed out after {}s", timeout.as_secs()),
            conflicts,
            command,
            needs_auth: false,
        };
    }

    let ok = outcome.code == Some(0);
    OpResult {
        needs_auth: !ok && looks_like_auth_failure(&outcome.stderr),
        ok,
        stdout: tail(&outcome.stdout),
        stderr: tail(&outcome.stderr),
        conflicts,
        command,
    }
}

/// stderr가 자격증명 문제로 보이는지 본다.
///
/// 오탐은 "터미널에서 실행" 버튼이 쓸데없이 뜨는 정도라 값이 싸다. 반대로 놓치면
/// 사용자는 왜 실패했는지 모른 채 막힌다. 그래서 넓게 잡는다.
pub fn looks_like_auth_failure(stderr: &str) -> bool {
    let lowered = stderr.to_lowercase();
    AUTH_MARKERS.iter().any(|marker| lowered.contains(marker)) || lowered.contains(AUTH_MARKER_403)
}

/// 충돌 파일 목록. 읽기 실패는 빈 목록으로 둔다. 작업 결과 자체를 가릴 이유가 없다.
pub fn collect_conflicts(repo: &str) -> Vec<String> {
    git::run(repo, &CONFLICT_ARGS)
        .map(|out| lines_of(&out))
        .unwrap_or_default()
}

/// 공백만 있는 줄을 버리고 남은 줄을 모은다. git 목록 출력 파싱의 공통 꼴이다.
pub fn lines_of(text: &str) -> Vec<String> {
    text.lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .map(str::to_string)
        .collect()
}

/// 마지막 [`MAX_OUTPUT_LINES`]줄만 남긴다.
pub fn tail(text: &str) -> String {
    let lines: Vec<&str> = text.lines().collect();
    if lines.len() <= MAX_OUTPUT_LINES {
        return text.to_string();
    }
    lines[lines.len() - MAX_OUTPUT_LINES..].join("\n")
}

/// 브랜치/ref 이름을 검증한다. 규칙은 git이 안다.
///
/// `-` 시작을 먼저 막는 이유는 두 가지다. git 인자에서 옵션으로 해석되는 것을 막고,
/// `check-ref-format --branch -x` 자체가 `-x`를 옵션으로 먹기 때문이다.
pub fn validate_ref_name(repo: &str, name: &str) -> Result<String, String> {
    let name = name.trim();
    if name.is_empty() {
        return Err("이름이 비어 있습니다".to_string());
    }
    if name.starts_with('-') {
        return Err(format!("이름 형식이 올바르지 않습니다: {name}"));
    }

    git::run(repo, &["check-ref-format", "--branch", name])
        .map_err(|_| format!("git이 허용하지 않는 이름입니다: {name}"))?;

    Ok(name.to_string())
}

/// 커밋 지시자(sha, `HEAD~2`, 태그 등)를 검증한다.
///
/// `check-ref-format --branch`는 `HEAD~2`나 `abc123^`을 거부해서 브랜치 이름 검증을
/// 그대로 쓸 수 없다. 실제로 가리키는 대상이 있는지를 `rev-parse --verify`로 묻는다.
pub fn validate_commitish(repo: &str, rev: &str) -> Result<String, String> {
    let rev = rev.trim();
    if rev.is_empty() {
        return Err("대상 커밋이 비어 있습니다".to_string());
    }
    if rev.starts_with('-') {
        return Err(format!("대상 형식이 올바르지 않습니다: {rev}"));
    }

    let spec = format!("{rev}^{{commit}}");
    git::run(repo, &["rev-parse", "--verify", "--quiet", spec.as_str()])
        .map_err(|_| format!("가리키는 커밋을 찾을 수 없습니다: {rev}"))?;

    Ok(rev.to_string())
}

/// remote 이름을 검증한다. 등록된 remote 목록에 있어야 한다.
pub fn validate_remote(repo: &str, remote: &str) -> Result<String, String> {
    let remote = remote.trim();
    if remote.is_empty() {
        return Err("remote 이름이 비어 있습니다".to_string());
    }
    if remote.starts_with('-') {
        return Err(format!("remote 이름 형식이 올바르지 않습니다: {remote}"));
    }

    if !remotes(repo).iter().any(|known| known == remote) {
        return Err(format!("등록되지 않은 remote입니다: {remote}"));
    }
    Ok(remote.to_string())
}

/// 파일 경로 목록을 검증한다. `--` 뒤에 놓더라도 빈 문자열은 git이 싫어한다.
///
/// `-` 시작 경로까지 막는 이유는 호출자가 `--`를 빠뜨렸을 때의 사고를 줄이기 위해서다.
pub fn validate_paths(files: &[String]) -> Result<Vec<String>, String> {
    let cleaned: Vec<String> = files
        .iter()
        .map(|file| file.trim().to_string())
        .filter(|file| !file.is_empty())
        .collect();

    if cleaned.is_empty() {
        return Err("대상 파일이 없습니다".to_string());
    }
    if let Some(bad) = cleaned.iter().find(|file| file.starts_with('-')) {
        return Err(format!("경로 형식이 올바르지 않습니다: {bad}"));
    }
    Ok(cleaned)
}

pub fn remotes(repo: &str) -> Vec<String> {
    git::run(repo, &["remote"])
        .map(|out| lines_of(&out))
        .unwrap_or_default()
}

/// 현재 브랜치. detached HEAD면 None.
pub fn current_branch(repo: &str) -> Option<String> {
    git::run(repo, &["symbolic-ref", "--short", "-q", "HEAD"])
        .ok()
        .map(|out| out.trim().to_string())
        .filter(|branch| !branch.is_empty())
}

pub fn local_branch_exists(repo: &str, name: &str) -> bool {
    let refname = format!("refs/heads/{name}");
    git::run(repo, &["show-ref", "--verify", "--quiet", refname.as_str()]).is_ok()
}

/// 현재 브랜치의 upstream. "origin/main" 형태. 없으면 None.
pub fn upstream_of_head(repo: &str) -> Option<String> {
    git::run(
        repo,
        &["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"],
    )
    .ok()
    .map(|out| out.trim().to_string())
    .filter(|upstream| !upstream.is_empty())
}

/// 이 워크트리의 실제 git 디렉토리.
///
/// `<repo>/.git`을 가정하면 안 된다. 링크된 워크트리에서는 `.git`이 파일이고 실제
/// 디렉토리는 `<main>/.git/worktrees/<name>`이다. MERGE_HEAD 같은 표식도 거기 있다.
/// `--absolute-git-dir`은 `--git-dir`과 같은 값을 절대 경로로 준다.
pub fn git_dir(repo: &str) -> Option<std::path::PathBuf> {
    git::run(repo, &["rev-parse", "--absolute-git-dir"])
        .ok()
        .map(|out| std::path::PathBuf::from(out.trim()))
        .filter(|dir| !dir.as_os_str().is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 저장소가 아닌 경로. `collect_conflicts`가 실패해 빈 목록이 되는 것만 쓴다.
    fn nowhere() -> String {
        std::env::temp_dir().to_string_lossy().into_owned()
    }

    fn piped(program: &str, args: &[&str]) -> Command {
        let mut command = Command::new(program);
        command.args(args);
        command.stdin(Stdio::null());
        command.stdout(Stdio::piped());
        command.stderr(Stdio::piped());
        command
    }

    #[test]
    fn 타임아웃이_지나면_kill하고_사유를_남긴다() {
        let started = Instant::now();
        let outcome = execute(piped("sleep", &["30"]), Duration::from_millis(300)).unwrap();

        assert!(outcome.timed_out);
        assert!(
            started.elapsed() < Duration::from_secs(5),
            "kill 없이 자식이 끝날 때까지 기다렸다: {:?}",
            started.elapsed()
        );

        let result = finish(&nowhere(), &["push"], outcome, Duration::from_secs(120));
        assert!(!result.ok);
        assert_eq!(result.stderr, "timed out after 120s");
        assert_eq!(result.command, ["push"]);
        assert!(!result.needs_auth, "타임아웃은 인증 문제가 아니다");
    }

    #[test]
    fn 종료_코드가_0이_아니면_ok가_false다() {
        let command = piped("sh", &["-c", "echo 나가는말; echo 오류 1>&2; exit 3"]);
        let outcome = execute(command, Duration::from_secs(10)).unwrap();
        assert!(!outcome.timed_out);
        assert_eq!(outcome.code, Some(3));

        let result = finish(&nowhere(), &["status"], outcome, LOCAL_TIMEOUT);
        assert!(!result.ok);
        assert!(result.stdout.contains("나가는말"), "{result:?}");
        assert!(result.stderr.contains("오류"), "{result:?}");
    }

    #[test]
    fn 파이프_버퍼보다_큰_출력도_교착되지_않는다() {
        // 64KB 파이프 버퍼를 넘기는 출력. 읽지 않고 기다리면 여기서 타임아웃이 난다.
        let command = piped("sh", &["-c", "yes 0123456789abcdef | head -n 20000"]);
        let outcome = execute(command, Duration::from_secs(10)).unwrap();
        assert!(!outcome.timed_out, "출력이 파이프에 걸려 교착됐다");
        assert_eq!(outcome.code, Some(0));
        assert_eq!(outcome.stdout.lines().count(), 20000);
    }

    #[test]
    fn stdin으로_넘긴_바이트가_그대로_자식에게_간다() {
        let command = piped("cat", &[]);
        let outcome = execute_with_input(
            command,
            Duration::from_secs(10),
            Some("안녕\n".as_bytes().to_vec()),
        )
        .unwrap();
        assert_eq!(outcome.code, Some(0));
        assert_eq!(outcome.stdout, "안녕\n");
    }

    #[test]
    fn 파이프_버퍼보다_큰_stdin도_교착되지_않는다() {
        // 1MB를 넣는다. 부모가 같은 스레드에서 쓰면 자식 출력이 파이프를 채워 교착된다.
        let payload: Vec<u8> = vec![b'x'; 1024 * 1024];
        let command = piped("cat", &[]);
        let started = Instant::now();
        let outcome =
            execute_with_input(command, Duration::from_secs(20), Some(payload.clone())).unwrap();

        assert!(!outcome.timed_out, "stdin 쓰기에서 교착됐다");
        assert_eq!(outcome.stdout.len(), payload.len());
        assert!(started.elapsed() < Duration::from_secs(10));
    }

    #[test]
    fn 출력은_마지막_200줄만_남는다() {
        let long: String = (0..500).map(|i| format!("line {i}\n")).collect();
        let kept = tail(&long);
        let lines: Vec<&str> = kept.lines().collect();
        assert_eq!(lines.len(), MAX_OUTPUT_LINES);
        assert_eq!(lines[0], "line 300");
        assert_eq!(lines[MAX_OUTPUT_LINES - 1], "line 499");

        // 상한 이하는 손대지 않는다
        assert_eq!(tail("a\nb\n"), "a\nb\n");
    }

    #[test]
    fn 인증_실패로_보이는_stderr만_needs_auth다() {
        for stderr in [
            "fatal: Authentication failed for 'https://github.com/x/y.git/'",
            "git@github.com: Permission denied (publickey).",
            "could not read Username for 'https://github.com': terminal prompts disabled",
            "Host key verification failed.",
            "remote: Support for password authentication was removed",
            "remote: HTTP Basic: Access denied",
            "The requested URL returned error: 403 Forbidden",
            "remote: Invalid username or token",
        ] {
            assert!(looks_like_auth_failure(stderr), "놓쳤다: {stderr}");
        }

        for stderr in [
            "",
            " ! [rejected]        main -> main (non-fast-forward)",
            "error: Your local changes would be overwritten by merge.",
            "CONFLICT (content): Merge conflict in a.txt",
        ] {
            assert!(!looks_like_auth_failure(stderr), "오탐: {stderr}");
        }
    }

    #[test]
    fn needs_auth는_실패했을_때만_켜진다() {
        // 성공한 명령의 stderr에 progress가 섞여 들어와도 켜지면 안 된다
        let outcome = Outcome {
            code: Some(0),
            stdout: String::new(),
            stderr: "Permission denied 라는 말이 지나갔다".to_string(),
            timed_out: false,
        };
        let result = finish(&nowhere(), &["fetch"], outcome, NETWORK_TIMEOUT);
        assert!(result.ok);
        assert!(!result.needs_auth);
    }

    #[test]
    fn 비대화식_환경변수가_모두_걸린다() {
        let command = op_command(".", &["status"]);
        let envs: Vec<(String, Option<String>)> = command
            .get_envs()
            .map(|(key, value)| {
                (
                    key.to_string_lossy().into_owned(),
                    value.map(|v| v.to_string_lossy().into_owned()),
                )
            })
            .collect();

        let get = |key: &str| {
            envs.iter()
                .find(|(name, _)| name == key)
                .map(|(_, value)| value.clone())
        };

        assert_eq!(get("GIT_TERMINAL_PROMPT"), Some(Some("0".to_string())));
        assert_eq!(
            get("GIT_SSH_COMMAND"),
            Some(Some("ssh -oBatchMode=yes".to_string()))
        );
        assert_eq!(get("GIT_ASKPASS"), Some(Some(String::new())));
        assert_eq!(get("SSH_ASKPASS"), Some(Some(String::new())));
        assert_eq!(get("LANG"), Some(Some("C".to_string())));
        assert_eq!(get("LC_ALL"), Some(Some("C".to_string())));
        // env_remove는 값이 None으로 실린다
        assert_eq!(get("GIT_DIR"), Some(None));
    }

    #[test]
    fn 경로_검증은_빈_목록과_옵션처럼_보이는_경로를_막는다() {
        assert!(validate_paths(&[]).is_err());
        assert!(validate_paths(&["  ".to_string()]).is_err());
        assert!(validate_paths(&["--cached".to_string()]).is_err());
        assert_eq!(
            validate_paths(&[" a.txt ".to_string(), String::new(), "b/c.txt".to_string()]).unwrap(),
            ["a.txt", "b/c.txt"]
        );
    }
}
