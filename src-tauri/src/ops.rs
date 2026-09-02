//! 쓰기 작업 command 10개와 공통 실행기.
//!
//! v0.15에서 읽기 전용 원칙을 해제했다. 대신 안전장치가 계약이다.
//!
//! - **절대 프롬프트를 띄우지 않는다.** stdin을 /dev/null로 막고 `GIT_TERMINAL_PROMPT=0`,
//!   `GIT_SSH_COMMAND=ssh -oBatchMode=yes`, `GIT_ASKPASS`/`SSH_ASKPASS`를 빈 값으로 둔다.
//!   자격증명이 없으면 물어보지 않고 실패한다. 앱에는 터미널이 없어서 한 번 물어보면
//!   프로세스가 영구히 멈춘다.
//! - **타임아웃이 있다.** 네트워크 120초, 로컬 60초. 넘으면 kill + wait 후
//!   `ok=false`, `stderr="timed out after Ns"`.
//! - **종료 코드는 오류가 아니다.** non-fast-forward나 인증 실패는 사용자가 읽어야 하는
//!   결과라서 `ok=false` + stderr로 돌려준다. `Err`는 인자 검증 실패에만 쓴다.
//! - **이름은 git에게 물어 검증한다.** ref 규칙을 여기서 다시 구현하지 않고
//!   `git check-ref-format --branch`를, remote는 `git remote` 목록을 쓴다.
//! - **`--force`는 쓰지 않는다.** push는 `--force-with-lease`만 허용한다.
//!
//! @see CONTRACTS.md

use std::ffi::OsStr;
use std::io::Read;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use crate::git;
use crate::model::{OpResult, SyncState};

/// 네트워크를 타는 작업(fetch/pull/push)의 상한.
const NETWORK_TIMEOUT: Duration = Duration::from_secs(120);

/// 로컬만 만지는 작업(checkout/branch/merge/stash)의 상한.
const LOCAL_TIMEOUT: Duration = Duration::from_secs(60);

/// 종료를 기다리는 폴링 간격. 사람이 못 느끼는 지연이면서 폴링 비용도 없는 값.
const POLL_INTERVAL: Duration = Duration::from_millis(20);

/// stdout/stderr에서 보관할 줄 수. 프론트가 토스트에 그대로 뿌리므로 상한이 필요하다.
const MAX_OUTPUT_LINES: usize = 200;

/// 충돌 파일 목록을 뽑는 인자.
const CONFLICT_ARGS: [&str; 3] = ["diff", "--name-only", "--diff-filter=U"];

/// 실행 결과 원본. [`finish`]가 이걸 [`OpResult`]로 바꾼다.
#[derive(Debug, Clone, PartialEq, Eq)]
struct Outcome {
    /// 시그널로 죽으면 None
    code: Option<i32>,
    stdout: String,
    stderr: String,
    timed_out: bool,
}

/// 비대화식 git 명령을 만든다. 여기 걸어둔 환경변수가 "멈추지 않는다"는 보장의 전부다.
fn op_command<S: AsRef<OsStr>>(repo: &str, args: &[S]) -> Command {
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

    // 오류 메시지를 파싱하지는 않지만, 사용자가 보는 문구를 로케일에 따라 흔들지 않는다
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
/// stdout/stderr는 별도 스레드로 끝까지 읽는다. 파이프 버퍼(보통 64KB)가 차면 자식이
/// 쓰기에서 멈추고, 그 상태로 종료를 기다리면 타임아웃까지 교착된다.
fn execute(mut command: Command, timeout: Duration) -> Result<Outcome, String> {
    let mut child = command
        .spawn()
        .map_err(|e| format!("git 실행에 실패했습니다. git이 설치되어 있는지 확인하세요: {e}"))?;

    let mut stdout = child.stdout.take();
    let mut stderr = child.stderr.take();

    std::thread::scope(|scope| {
        let out_reader = scope.spawn(move || drain(stdout.as_mut()));
        let err_reader = scope.spawn(move || drain(stderr.as_mut()));

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
fn run_op(repo: &str, args: &[&str], timeout: Duration) -> Result<OpResult, String> {
    let outcome = execute(op_command(repo, args), timeout)?;
    Ok(finish(repo, outcome, timeout))
}

fn finish(repo: &str, outcome: Outcome, timeout: Duration) -> OpResult {
    let conflicts = collect_conflicts(repo);

    if outcome.timed_out {
        return OpResult {
            ok: false,
            stdout: tail(&outcome.stdout),
            stderr: format!("timed out after {}s", timeout.as_secs()),
            conflicts,
        };
    }

    OpResult {
        ok: outcome.code == Some(0),
        stdout: tail(&outcome.stdout),
        stderr: tail(&outcome.stderr),
        conflicts,
    }
}

/// 충돌 파일 목록. 읽기 실패는 빈 목록으로 둔다. 작업 결과 자체를 가릴 이유가 없다.
fn collect_conflicts(repo: &str) -> Vec<String> {
    git::run(repo, &CONFLICT_ARGS)
        .map(|out| {
            out.lines()
                .map(str::trim)
                .filter(|line| !line.is_empty())
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default()
}

/// 마지막 [`MAX_OUTPUT_LINES`]줄만 남긴다.
fn tail(text: &str) -> String {
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
fn validate_ref_name(repo: &str, name: &str) -> Result<String, String> {
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

/// remote 이름을 검증한다. 등록된 remote 목록에 있어야 한다.
fn validate_remote(repo: &str, remote: &str) -> Result<String, String> {
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

fn remotes(repo: &str) -> Vec<String> {
    git::run(repo, &["remote"])
        .map(|out| {
            out.lines()
                .map(str::trim)
                .filter(|line| !line.is_empty())
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default()
}

/// 현재 브랜치. detached HEAD면 None.
fn current_branch(repo: &str) -> Option<String> {
    git::run(repo, &["symbolic-ref", "--short", "-q", "HEAD"])
        .ok()
        .map(|out| out.trim().to_string())
        .filter(|branch| !branch.is_empty())
}

fn local_branch_exists(repo: &str, name: &str) -> bool {
    let refname = format!("refs/heads/{name}");
    git::run(repo, &["show-ref", "--verify", "--quiet", refname.as_str()]).is_ok()
}

/// 현재 브랜치의 upstream. "origin/main" 형태. 없으면 None.
fn upstream_of_head(repo: &str) -> Option<String> {
    git::run(
        repo,
        &["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"],
    )
    .ok()
    .map(|out| out.trim().to_string())
    .filter(|upstream| !upstream.is_empty())
}

/// 현재 브랜치의 upstream 대비 상태. 폴링에서 5초마다 불려서 네 호출을 병렬로 돈다.
#[tauri::command]
pub fn get_sync_state(path: String) -> Result<SyncState, String> {
    const BRANCH_ARGS: [&str; 4] = ["symbolic-ref", "--short", "-q", "HEAD"];
    const UPSTREAM_ARGS: [&str; 4] = ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"];
    const COUNT_ARGS: [&str; 4] = ["rev-list", "--left-right", "--count", "@{u}...HEAD"];
    const STASH_ARGS: [&str; 2] = ["stash", "list"];

    let outputs = git::run_all(
        &path,
        &[
            &BRANCH_ARGS[..],
            &UPSTREAM_ARGS[..],
            &COUNT_ARGS[..],
            &STASH_ARGS[..],
        ],
    );
    let [branch_out, upstream_out, count_out, stash_out] =
        <[_; 4]>::try_from(outputs).expect("run_all은 넘긴 수만큼 결과를 돌려준다");

    let branch = branch_out
        .ok()
        .map(|out| out.trim().to_string())
        .filter(|branch| !branch.is_empty());
    let upstream = upstream_out
        .ok()
        .map(|out| out.trim().to_string())
        .filter(|upstream| !upstream.is_empty());

    // upstream이 없으면 이 호출도 실패한다. 그때는 0/0이다.
    let (behind, ahead) = count_out
        .ok()
        .and_then(|out| parse_left_right(&out))
        .unwrap_or((0, 0));

    let stash_count = stash_out
        .map(|out| out.lines().filter(|line| !line.trim().is_empty()).count() as u32)
        .unwrap_or(0);

    Ok(SyncState {
        branch,
        upstream,
        ahead,
        behind,
        stash_count,
    })
}

/// `rev-list --left-right --count @{u}...HEAD`의 "behind\tahead"를 쪼갠다.
///
/// 왼쪽이 upstream에만 있는 커밋(= behind), 오른쪽이 HEAD에만 있는 커밋(= ahead)이다.
fn parse_left_right(out: &str) -> Option<(u32, u32)> {
    let mut parts = out.split_whitespace();
    let left = parts.next()?.parse().ok()?;
    let right = parts.next()?.parse().ok()?;
    Some((left, right))
}

/// `remote`가 None이면 `--all`.
#[tauri::command]
pub fn git_fetch(path: String, remote: Option<String>, prune: bool) -> Result<OpResult, String> {
    let remote = match remote.as_deref().map(str::trim).filter(|r| !r.is_empty()) {
        Some(remote) => Some(validate_remote(&path, remote)?),
        None => None,
    };

    let mut args: Vec<&str> = vec!["fetch"];
    match remote.as_deref() {
        Some(remote) => args.push(remote),
        None => args.push("--all"),
    }
    if prune {
        args.push("--prune");
    }

    run_op(&path, &args, NETWORK_TIMEOUT)
}

/// `mode`는 `PullMode`("ff-only" | "merge" | "rebase").
#[tauri::command]
pub fn git_pull(path: String, mode: String) -> Result<OpResult, String> {
    let args: &[&str] = match mode.as_str() {
        "ff-only" => &["pull", "--ff-only"],
        // --no-rebase가 곧 merge다. --no-ff는 아니라서 ff가 가능하면 ff로 끝난다.
        "merge" => &["pull", "--no-rebase", "--no-edit"],
        "rebase" => &["pull", "--rebase"],
        other => return Err(format!("알 수 없는 pull 모드입니다: {other}")),
    };

    run_op(&path, args, NETWORK_TIMEOUT)
}

/// 현재 브랜치를 푸시한다. 일반 `--force`는 어떤 경로로도 붙지 않는다.
#[tauri::command]
pub fn git_push(
    path: String,
    set_upstream: bool,
    force_with_lease: bool,
) -> Result<OpResult, String> {
    let branch = current_branch(&path)
        .ok_or_else(|| "detached HEAD 상태에서는 푸시할 수 없습니다".to_string())?;
    let has_upstream = upstream_of_head(&path).is_some();

    let args = push_args(&branch, has_upstream, set_upstream, force_with_lease);
    let args: Vec<&str> = args.iter().map(String::as_str).collect();

    run_op(&path, &args, NETWORK_TIMEOUT)
}

/// push 인자를 조립한다. 순수 함수로 떼어낸 이유는 `--force`가 어떤 조합에서도 나오지
/// 않는다는 것을 테스트로 못 박기 위해서다.
fn push_args(
    branch: &str,
    has_upstream: bool,
    set_upstream: bool,
    force_with_lease: bool,
) -> Vec<String> {
    let mut args = vec!["push".to_string()];
    if force_with_lease {
        args.push("--force-with-lease".to_string());
    }
    // upstream이 없고 설정도 안 하겠다면 그냥 push한다. git이 "no upstream" 안내를 낸다.
    if !has_upstream && set_upstream {
        args.push("-u".to_string());
        args.push("origin".to_string());
        args.push(branch.to_string());
    }
    args
}

/// 로컬 브랜치 이름이나 `origin/x` 형태를 받는다.
#[tauri::command]
pub fn git_checkout(path: String, target: String) -> Result<OpResult, String> {
    let target = validate_ref_name(&path, &target)?;

    // "origin/x"에서 origin이 실제 remote일 때만 원격 브랜치로 본다.
    // 로컬에 "feature/x" 같은 슬래시 이름이 있으면 그건 그대로 로컬 체크아웃이다.
    if let Some((remote, rest)) = target.split_once('/') {
        if !rest.is_empty() && remotes(&path).iter().any(|known| known == remote) {
            if local_branch_exists(&path, rest) {
                return run_op(&path, &["checkout", rest], LOCAL_TIMEOUT);
            }
            return run_op(
                &path,
                &["checkout", "--track", target.as_str()],
                LOCAL_TIMEOUT,
            );
        }
    }

    run_op(&path, &["checkout", target.as_str()], LOCAL_TIMEOUT)
}

#[tauri::command]
pub fn git_create_branch(
    path: String,
    name: String,
    start_point: Option<String>,
    checkout: bool,
) -> Result<OpResult, String> {
    let name = validate_ref_name(&path, &name)?;
    let start = match start_point
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        Some(start) => Some(validate_ref_name(&path, start)?),
        None => None,
    };

    let mut args: Vec<&str> = if checkout {
        vec!["checkout", "-b", name.as_str()]
    } else {
        vec!["branch", name.as_str()]
    };
    if let Some(start) = start.as_deref() {
        args.push(start);
    }

    run_op(&path, &args, LOCAL_TIMEOUT)
}

/// 로컬 브랜치만 삭제한다. 현재 브랜치는 거부한다.
#[tauri::command]
pub fn git_delete_branch(path: String, name: String, force: bool) -> Result<OpResult, String> {
    let name = validate_ref_name(&path, &name)?;

    if current_branch(&path).as_deref() == Some(name.as_str()) {
        return Err(format!(
            "현재 체크아웃된 브랜치는 삭제할 수 없습니다: {name}"
        ));
    }

    let flag = if force { "-D" } else { "-d" };
    run_op(&path, &["branch", flag, name.as_str()], LOCAL_TIMEOUT)
}

/// `source`를 현재 브랜치로 머지한다. 충돌하면 `ok=false` + `conflicts`가 채워진다.
#[tauri::command]
pub fn git_merge(path: String, source: String) -> Result<OpResult, String> {
    let source = validate_ref_name(&path, &source)?;
    run_op(
        &path,
        &["merge", "--no-edit", source.as_str()],
        LOCAL_TIMEOUT,
    )
}

#[tauri::command]
pub fn git_stash_push(
    path: String,
    message: Option<String>,
    include_untracked: bool,
) -> Result<OpResult, String> {
    let message = message
        .as_deref()
        .map(str::trim)
        .filter(|message| !message.is_empty());

    let mut args: Vec<&str> = vec!["stash", "push"];
    if include_untracked {
        args.push("--include-untracked");
    }
    // -m이 다음 인자를 값으로 먹으므로 메시지가 "-"로 시작해도 옵션이 되지 않는다
    if let Some(message) = message {
        args.push("-m");
        args.push(message);
    }

    run_op(&path, &args, LOCAL_TIMEOUT)
}

/// 가장 최근 스태시를 적용하고 목록에서 지운다. 충돌하면 `conflicts`가 채워진다.
#[tauri::command]
pub fn git_stash_pop(path: String) -> Result<OpResult, String> {
    run_op(&path, &["stash", "pop", "stash@{0}"], LOCAL_TIMEOUT)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 타임아웃이_지나면_kill하고_사유를_남긴다() {
        let mut command = Command::new("sleep");
        command.arg("30");
        command.stdin(Stdio::null());
        command.stdout(Stdio::piped());
        command.stderr(Stdio::piped());

        let started = Instant::now();
        let outcome = execute(command, Duration::from_millis(300)).unwrap();

        assert!(outcome.timed_out);
        assert!(
            started.elapsed() < Duration::from_secs(5),
            "kill 없이 자식이 끝날 때까지 기다렸다: {:?}",
            started.elapsed()
        );

        let result = finish(".", outcome, Duration::from_secs(120));
        assert!(!result.ok);
        assert_eq!(result.stderr, "timed out after 120s");
    }

    #[test]
    fn 종료_코드가_0이_아니면_ok가_false다() {
        let mut command = Command::new("sh");
        command.args(["-c", "echo 나가는말; echo 오류 1>&2; exit 3"]);
        command.stdin(Stdio::null());
        command.stdout(Stdio::piped());
        command.stderr(Stdio::piped());

        let outcome = execute(command, Duration::from_secs(10)).unwrap();
        assert!(!outcome.timed_out);
        assert_eq!(outcome.code, Some(3));

        let result = finish(".", outcome, LOCAL_TIMEOUT);
        assert!(!result.ok);
        assert!(result.stdout.contains("나가는말"), "{result:?}");
        assert!(result.stderr.contains("오류"), "{result:?}");
    }

    #[test]
    fn 파이프_버퍼보다_큰_출력도_교착되지_않는다() {
        // 64KB 파이프 버퍼를 넘기는 출력. 읽지 않고 기다리면 여기서 타임아웃이 난다.
        let mut command = Command::new("sh");
        command.args(["-c", "yes 0123456789abcdef | head -n 20000"]);
        command.stdin(Stdio::null());
        command.stdout(Stdio::piped());
        command.stderr(Stdio::piped());

        let outcome = execute(command, Duration::from_secs(10)).unwrap();
        assert!(!outcome.timed_out, "출력이 파이프에 걸려 교착됐다");
        assert_eq!(outcome.code, Some(0));
        assert_eq!(outcome.stdout.lines().count(), 20000);
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
    fn push_인자에는_어떤_조합에서도_force가_없다() {
        for has_upstream in [false, true] {
            for set_upstream in [false, true] {
                for force_with_lease in [false, true] {
                    let args = push_args("main", has_upstream, set_upstream, force_with_lease);
                    assert!(
                        !args.iter().any(|arg| arg == "--force" || arg == "-f"),
                        "{args:?}"
                    );
                    assert_eq!(
                        args.iter().any(|arg| arg == "--force-with-lease"),
                        force_with_lease,
                        "{args:?}"
                    );
                }
            }
        }

        // upstream이 이미 있으면 -u를 붙이지 않는다
        assert_eq!(push_args("main", true, true, false), ["push"]);
        assert_eq!(
            push_args("feature", false, true, false),
            ["push", "-u", "origin", "feature"]
        );
    }

    #[test]
    fn left_right_출력을_behind_ahead로_읽는다() {
        assert_eq!(parse_left_right("2\t5\n"), Some((2, 5)));
        assert_eq!(parse_left_right("0 0"), Some((0, 0)));
        assert_eq!(parse_left_right(""), None);
        assert_eq!(parse_left_right("fatal: no upstream"), None);
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
}

/// 로컬 bare 리모트를 세워 네트워크 없이 fetch/pull/push를 검증한다.
#[cfg(test)]
mod integration_tests {
    use super::*;
    use crate::testrepo::TempRepo;

    /// (origin bare, 작업 사본). 둘 다 살려둬야 Drop이 디렉토리를 지우지 않는다.
    fn remote_fixture() -> (TempRepo, TempRepo) {
        let origin = TempRepo::init_bare("gitlanes-origin");
        let repo = TempRepo::init("gitlanes-ops");
        repo.write("a.txt", "1\n");
        repo.git(&["add", "-A"]);
        repo.git(&["commit", "-qm", "c1"]);
        repo.git(&["remote", "add", "origin", &origin.path()]);
        repo.git(&["push", "-q", "-u", "origin", "main"]);
        (origin, repo)
    }

    /// 두 번째 사본에서 origin/main에 커밋 하나를 올린다.
    fn push_remote_commit(origin: &TempRepo, message: &str) {
        let other = TempRepo::clone_of("gitlanes-other", &origin.path());
        other.write("other.txt", &format!("{message}\n"));
        other.git(&["add", "-A"]);
        other.git(&["commit", "-qm", message]);
        other.git(&["push", "-q", "origin", "main"]);
    }

    /// 리모트와 로컬이 서로 다른 커밋을 하나씩 갖게 만든다.
    fn diverge(origin: &TempRepo, repo: &TempRepo) {
        push_remote_commit(origin, "remote side");
        repo.write("local.txt", "local\n");
        repo.git(&["add", "-A"]);
        repo.git(&["commit", "-qm", "local side"]);
    }

    fn exists(repo: &TempRepo, name: &str) -> bool {
        std::path::Path::new(&repo.path()).join(name).exists()
    }

    #[test]
    fn fetch는_리모트_변경을_가져와_behind로_보인다() {
        let (origin, repo) = remote_fixture();
        push_remote_commit(&origin, "remote work");

        let result = git_fetch(repo.path(), None, false).unwrap();
        assert!(result.ok, "{result:?}");
        assert!(result.conflicts.is_empty());

        let state = get_sync_state(repo.path()).unwrap();
        assert_eq!(state.branch.as_deref(), Some("main"));
        assert_eq!(state.upstream.as_deref(), Some("origin/main"));
        assert_eq!((state.ahead, state.behind), (0, 1));
    }

    #[test]
    fn 등록되지_않은_remote는_거부한다() {
        let (_origin, repo) = remote_fixture();
        assert!(git_fetch(repo.path(), Some("upstream".to_string()), false).is_err());
        assert!(git_fetch(repo.path(), Some("-x".to_string()), false).is_err());
        // 등록된 remote는 prune과 함께 통과한다
        assert!(
            git_fetch(repo.path(), Some("origin".to_string()), true)
                .unwrap()
                .ok
        );
    }

    #[test]
    fn pull_ff_only는_앞선_리모트를_따라간다() {
        let (origin, repo) = remote_fixture();
        push_remote_commit(&origin, "remote work");

        let result = git_pull(repo.path(), "ff-only".to_string()).unwrap();
        assert!(result.ok, "{result:?}");
        assert!(exists(&repo, "other.txt"));

        let state = get_sync_state(repo.path()).unwrap();
        assert_eq!((state.ahead, state.behind), (0, 0));
    }

    #[test]
    fn pull_ff_only는_분기하면_실패하고_stderr를_담는다() {
        let (origin, repo) = remote_fixture();
        diverge(&origin, &repo);

        let result = git_pull(repo.path(), "ff-only".to_string()).unwrap();
        assert!(!result.ok, "{result:?}");
        assert!(!result.stderr.is_empty(), "{result:?}");
    }

    #[test]
    fn pull_rebase는_로컬_커밋을_위로_올린다() {
        let (origin, repo) = remote_fixture();
        diverge(&origin, &repo);

        let result = git_pull(repo.path(), "rebase".to_string()).unwrap();
        assert!(result.ok, "{result:?}");

        let state = get_sync_state(repo.path()).unwrap();
        assert_eq!((state.ahead, state.behind), (1, 0));
    }

    #[test]
    fn pull_merge는_분기를_합친다() {
        let (origin, repo) = remote_fixture();
        diverge(&origin, &repo);

        let result = git_pull(repo.path(), "merge".to_string()).unwrap();
        assert!(result.ok, "{result:?}");
        assert!(exists(&repo, "other.txt"));
        assert!(exists(&repo, "local.txt"));

        let state = get_sync_state(repo.path()).unwrap();
        assert_eq!(state.behind, 0);
        // 로컬 커밋 + 머지 커밋
        assert_eq!(state.ahead, 2);
    }

    #[test]
    fn 알_수_없는_pull_모드는_거부한다() {
        let (_origin, repo) = remote_fixture();
        assert!(git_pull(repo.path(), "force".to_string()).is_err());
        assert!(git_pull(repo.path(), String::new()).is_err());
    }

    #[test]
    fn push는_upstream이_없으면_설정하며_올린다() {
        let (_origin, repo) = remote_fixture();
        repo.git(&["checkout", "-qb", "feature"]);
        repo.write("f.txt", "f\n");
        repo.git(&["add", "-A"]);
        repo.git(&["commit", "-qm", "feature work"]);

        assert_eq!(get_sync_state(repo.path()).unwrap().upstream, None);

        let result = git_push(repo.path(), true, false).unwrap();
        assert!(result.ok, "{result:?}");

        let state = get_sync_state(repo.path()).unwrap();
        assert_eq!(state.upstream.as_deref(), Some("origin/feature"));
        assert_eq!((state.ahead, state.behind), (0, 0));
    }

    #[test]
    fn push는_upstream도_설정도_없으면_git_안내로_실패한다() {
        let (_origin, repo) = remote_fixture();
        repo.git(&["checkout", "-qb", "feature"]);

        let result = git_push(repo.path(), false, false).unwrap();
        assert!(!result.ok, "{result:?}");
        assert!(!result.stderr.is_empty(), "{result:?}");
    }

    #[test]
    fn push는_non_fast_forward를_ok_false로_돌려준다() {
        let (origin, repo) = remote_fixture();
        diverge(&origin, &repo);

        let result = git_push(repo.path(), false, false).unwrap();
        assert!(!result.ok, "{result:?}");
        assert!(result.stderr.contains("rejected"), "{result:?}");
    }

    #[test]
    fn force_with_lease는_fetch로_lease를_갱신한_뒤에만_통한다() {
        let (origin, repo) = remote_fixture();
        diverge(&origin, &repo);

        // 원격 추적 ref가 낡아서 lease 검사에 걸린다
        let stale = git_push(repo.path(), false, true).unwrap();
        assert!(!stale.ok, "{stale:?}");

        assert!(git_fetch(repo.path(), None, false).unwrap().ok);
        let fresh = git_push(repo.path(), false, true).unwrap();
        assert!(fresh.ok, "{fresh:?}");
    }

    #[test]
    fn checkout은_로컬_브랜치로_옮긴다() {
        let (_origin, repo) = remote_fixture();
        repo.git(&["branch", "topic"]);

        let result = git_checkout(repo.path(), "topic".to_string()).unwrap();
        assert!(result.ok, "{result:?}");
        assert_eq!(current_branch(&repo.path()).as_deref(), Some("topic"));
    }

    #[test]
    fn checkout은_원격_브랜치를_추적_생성하고_두_번째부터는_그냥_옮긴다() {
        let (origin, repo) = remote_fixture();
        let other = TempRepo::clone_of("gitlanes-other", &origin.path());
        other.git(&["checkout", "-qb", "topic"]);
        other.write("t.txt", "t\n");
        other.git(&["add", "-A"]);
        other.git(&["commit", "-qm", "topic work"]);
        other.git(&["push", "-q", "origin", "topic"]);

        assert!(git_fetch(repo.path(), None, false).unwrap().ok);

        let created = git_checkout(repo.path(), "origin/topic".to_string()).unwrap();
        assert!(created.ok, "{created:?}");
        assert_eq!(current_branch(&repo.path()).as_deref(), Some("topic"));
        assert_eq!(
            get_sync_state(repo.path()).unwrap().upstream.as_deref(),
            Some("origin/topic")
        );

        assert!(git_checkout(repo.path(), "main".to_string()).unwrap().ok);
        // 로컬 topic이 이미 있으니 --track 경로를 타지 않는다
        let again = git_checkout(repo.path(), "origin/topic".to_string()).unwrap();
        assert!(again.ok, "{again:?}");
        assert_eq!(current_branch(&repo.path()).as_deref(), Some("topic"));
    }

    #[test]
    fn create_branch는_checkout_여부를_따른다() {
        let (_origin, repo) = remote_fixture();

        let stay = git_create_branch(repo.path(), "keep-here".to_string(), None, false).unwrap();
        assert!(stay.ok, "{stay:?}");
        assert_eq!(current_branch(&repo.path()).as_deref(), Some("main"));
        assert!(local_branch_exists(&repo.path(), "keep-here"));

        let moved = git_create_branch(
            repo.path(),
            "go-there".to_string(),
            Some("main".to_string()),
            true,
        )
        .unwrap();
        assert!(moved.ok, "{moved:?}");
        assert_eq!(current_branch(&repo.path()).as_deref(), Some("go-there"));
    }

    #[test]
    fn 현재_브랜치_삭제는_호출_오류다() {
        let (_origin, repo) = remote_fixture();
        let error = git_delete_branch(repo.path(), "main".to_string(), false).unwrap_err();
        assert!(error.contains("현재"), "{error}");
    }

    #[test]
    fn 미머지_브랜치는_force_없이_지워지지_않는다() {
        let (_origin, repo) = remote_fixture();
        repo.git(&["checkout", "-qb", "unmerged"]);
        repo.write("u.txt", "u\n");
        repo.git(&["add", "-A"]);
        repo.git(&["commit", "-qm", "unmerged work"]);
        repo.git(&["checkout", "-q", "main"]);

        let refused = git_delete_branch(repo.path(), "unmerged".to_string(), false).unwrap();
        assert!(!refused.ok, "{refused:?}");
        assert!(local_branch_exists(&repo.path(), "unmerged"));

        let forced = git_delete_branch(repo.path(), "unmerged".to_string(), true).unwrap();
        assert!(forced.ok, "{forced:?}");
        assert!(!local_branch_exists(&repo.path(), "unmerged"));
    }

    #[test]
    fn merge_충돌은_conflicts를_채운다() {
        let repo = TempRepo::init("gitlanes-merge");
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

        let result = git_merge(repo.path(), "other".to_string()).unwrap();
        assert!(!result.ok, "{result:?}");
        assert_eq!(result.conflicts, ["c.txt"]);
    }

    #[test]
    fn 충돌이_없는_merge는_conflicts가_비어_있다() {
        let repo = TempRepo::init("gitlanes-merge-clean");
        repo.write("base.txt", "base\n");
        repo.git(&["add", "-A"]);
        repo.git(&["commit", "-qm", "base"]);

        repo.git(&["checkout", "-qb", "other"]);
        repo.write("other.txt", "other\n");
        repo.git(&["add", "-A"]);
        repo.git(&["commit", "-qm", "other side"]);
        repo.git(&["checkout", "-q", "main"]);

        let result = git_merge(repo.path(), "other".to_string()).unwrap();
        assert!(result.ok, "{result:?}");
        assert!(result.conflicts.is_empty(), "{result:?}");
    }

    #[test]
    fn stash_push와_pop이_왕복한다() {
        let (_origin, repo) = remote_fixture();
        repo.write("a.txt", "changed\n");
        repo.write("fresh.txt", "new\n");

        let pushed = git_stash_push(repo.path(), Some("작업 중".to_string()), true).unwrap();
        assert!(pushed.ok, "{pushed:?}");
        assert_eq!(get_sync_state(repo.path()).unwrap().stash_count, 1);
        assert!(!exists(&repo, "fresh.txt"), "untracked도 스태시로 들어간다");

        let popped = git_stash_pop(repo.path()).unwrap();
        assert!(popped.ok, "{popped:?}");
        assert_eq!(get_sync_state(repo.path()).unwrap().stash_count, 0);
        assert!(exists(&repo, "fresh.txt"));
    }

    #[test]
    fn 스태시가_없으면_pop이_ok_false다() {
        let (_origin, repo) = remote_fixture();
        let result = git_stash_pop(repo.path()).unwrap();
        assert!(!result.ok, "{result:?}");
        assert!(!result.stderr.is_empty(), "{result:?}");
    }

    #[test]
    fn sync_state는_ahead_behind_스태시_수를_함께_센다() {
        let (origin, repo) = remote_fixture();
        push_remote_commit(&origin, "remote side");
        repo.write("local.txt", "local\n");
        repo.git(&["add", "-A"]);
        repo.git(&["commit", "-qm", "local side"]);

        repo.write("a.txt", "dirty\n");
        assert!(git_stash_push(repo.path(), None, false).unwrap().ok);
        assert!(git_fetch(repo.path(), None, false).unwrap().ok);

        let state = get_sync_state(repo.path()).unwrap();
        assert_eq!((state.ahead, state.behind), (1, 1));
        assert_eq!(state.stash_count, 1);
    }

    #[test]
    fn detached_head는_브랜치가_없고_푸시도_거부한다() {
        let (_origin, repo) = remote_fixture();
        let head = repo.rev("HEAD");
        repo.git(&["checkout", "-q", "--detach", &head]);

        let state = get_sync_state(repo.path()).unwrap();
        assert_eq!(state.branch, None);
        assert_eq!(state.upstream, None);
        assert_eq!((state.ahead, state.behind), (0, 0));

        assert!(git_push(repo.path(), true, false).is_err());
    }

    #[test]
    fn 이름_검증은_옵션과_git이_거부하는_ref를_막는다() {
        let (_origin, repo) = remote_fixture();
        let path = repo.path();

        for bad in [
            "",
            "   ",
            "-x",
            "a..b",
            "a b",
            "he@{ad}",
            "back\\slash",
            "star*",
        ] {
            assert!(
                git_create_branch(path.clone(), bad.to_string(), None, false).is_err(),
                "허용하면 안 되는 이름: {bad:?}"
            );
        }
        // start_point와 merge/checkout/delete도 같은 검증을 통과해야 한다
        assert!(git_create_branch(
            path.clone(),
            "ok".to_string(),
            Some("-x".to_string()),
            false
        )
        .is_err());
        assert!(git_merge(path.clone(), "a b".to_string()).is_err());
        assert!(git_checkout(path.clone(), "-x".to_string()).is_err());
        assert!(git_delete_branch(path.clone(), "a..b".to_string(), true).is_err());

        // 슬래시가 들어간 정상 이름은 통과한다
        assert!(
            git_create_branch(path, "feature/ok".to_string(), None, false)
                .unwrap()
                .ok
        );
    }
}
