//! 시스템 git CLI 호출 래퍼. libgit2를 쓰지 않는다.
//!
//! 커밋마다 프로세스를 띄우지 않도록 command 하나당 git 호출을 2~3회로 묶는다.
//!
//! @see CONTRACTS.md

use std::ffi::OsStr;
use std::io::{BufRead, BufReader};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc, OnceLock};
use std::time::{Duration, Instant};

use crate::ops::run::{self as runner, RawOutcome};

/// 읽기 git 한 번의 상한. 넘으면 프로세스 그룹을 죽이고 Err를 돌려준다.
///
/// 상한이 없으면 멈춘 git(잠긴 NFS, 응답 없는 fsmonitor 훅, credential helper 등)이 블로킹
/// 스레드와 그 IPC 응답을 영원히 붙든다. 4만 커밋 저장소에서 가장 무거운 읽기(load_graph의
/// 보조 호출, status)가 1초 안쪽이라(handoff-v16-exec.md 실측) 60초는 멈춘 경우만 걸린다.
pub const READ_TIMEOUT: Duration = Duration::from_secs(60);

/// stdout EOF 뒤 종료를 확인하는 간격. EOF면 git은 거의 끝났으므로 짧게 둔다.
const EXIT_POLL: Duration = Duration::from_millis(1);

/// 스트리밍 읽기(전체 히스토리 검색, 그래프 log)의 상한. 히스토리 전체를 훑는 검색이
/// 가장 길어서 일반 읽기보다 넉넉히 둔다.
pub const STREAM_TIMEOUT: Duration = Duration::from_secs(120);

/// `core.quotepath=false`로 비ASCII 경로가 이스케이프되지 않게 한다.
/// `GIT_OPTIONAL_LOCKS=0`은 읽기 전용 뷰어가 인덱스 잠금을 건드리지 않게 한다.
fn base_command<P: AsRef<OsStr>>(repo: P) -> Command {
    let mut cmd = Command::new("git");
    cmd.arg("-c")
        .arg("core.quotepath=false")
        .arg("--no-optional-locks")
        .arg("-C")
        .arg(repo);
    // 호스트 환경의 git 설정이 새어 들어오지 않게 한다
    cmd.env_remove("GIT_DIR");
    cmd.env_remove("GIT_WORK_TREE");
    cmd.env_remove("GIT_INDEX_FILE");
    cmd.env("GIT_TERMINAL_PROMPT", "0");
    // 경로 인자는 glob이 아니라 리터럴이다. `pages/[id].tsx`의 diff를 읽는데 glob으로 풀리면
    // `pages/i.tsx`까지 섞인 diff가 나오고, 프론트는 그걸 한 파일 diff로 알고 패치를 만든다.
    // 읽기 경로는 훅을 돌리지 않아 쓰기 쪽(ops/run.rs)과 달리 예외 없이 건다.
    // 이 모듈에 pathspec magic(`:(top)`, `*.rs`)을 일부러 쓰는 호출은 없다(v0.15.1 전수 확인).
    cmd.env("GIT_LITERAL_PATHSPECS", "1");
    cmd
}

/// git을 실행해 stdout을 문자열로 돌려준다. 실패하면 stderr를 담은 오류 메시지를 만든다.
pub fn run<P, S>(repo: P, args: &[S]) -> Result<String, String>
where
    P: AsRef<OsStr>,
    S: AsRef<OsStr>,
{
    // git 출력은 커밋 메시지나 diff 본문이 임의 인코딩일 수 있어 lossy 변환을 쓴다.
    run_bytes(repo, args).map(|out| String::from_utf8_lossy(&out).into_owned())
}

/// git을 실행해 stdout을 바이트 그대로 돌려준다.
///
/// [`run`]의 lossy 변환은 잘못된 바이트를 U+FFFD로 바꿔서, 원본이 UTF-8이었는지
/// 판정할 수 없게 만든다. 바이너리 판정처럼 바이트가 그대로 필요한 곳은 이쪽을 쓴다.
pub fn run_bytes<P, S>(repo: P, args: &[S]) -> Result<Vec<u8>, String>
where
    P: AsRef<OsStr>,
    S: AsRef<OsStr>,
{
    run_bytes_within(repo, args, READ_TIMEOUT)
}

fn run_bytes_within<P, S>(repo: P, args: &[S], timeout: Duration) -> Result<Vec<u8>, String>
where
    P: AsRef<OsStr>,
    S: AsRef<OsStr>,
{
    let output = capture(repo, args, timeout)?;
    if output.code != Some(0) {
        return Err(failure_message(&output.stderr));
    }
    Ok(output.stdout)
}

/// 읽기 git 하나를 상한과 함께 실행한다. 타임아웃은 여기서 Err로 바꾼다.
fn capture<P, S>(repo: P, args: &[S], timeout: Duration) -> Result<RawOutcome, String>
where
    P: AsRef<OsStr>,
    S: AsRef<OsStr>,
{
    let mut command = base_command(repo);
    command.args(args);
    command.stdin(Stdio::null());
    command.stdout(Stdio::piped());
    command.stderr(Stdio::piped());
    let output = runner::capture(command, timeout, None)?;
    if output.timed_out {
        return Err(timeout_message(args, timeout));
    }
    Ok(output)
}

fn failure_message(stderr: &[u8]) -> String {
    let stderr = String::from_utf8_lossy(stderr).trim().to_string();
    if stderr.is_empty() {
        "git 명령이 실패했습니다".to_string()
    } else {
        stderr
    }
}

/// 사람이 읽을 타임아웃 오류. 인자 전체는 `--format=...`처럼 길어서 하위 명령만 보인다.
fn timeout_message<S: AsRef<OsStr>>(args: &[S], timeout: Duration) -> String {
    let verb = args
        .iter()
        .map(|arg| arg.as_ref().to_string_lossy())
        .find(|arg| !arg.starts_with('-'))
        .unwrap_or_default();
    format!(
        "git {verb} 명령이 {}초 안에 끝나지 않아 중단했습니다. 저장소가 매우 크거나 git이 응답하지 않습니다",
        timeout.as_secs()
    )
}

/// git을 실행해 stdout을 바이트 그대로 돌려주되, 종료 코드 1을 성공으로 본다.
///
/// `git diff --no-index`는 두 파일이 다르면 1로 끝난다. 그게 정상 결과라서 [`run`]의
/// 실패 판정(성공 아니면 오류)을 그대로 쓸 수 없다. 2 이상만 실제 오류로 본다.
/// diff 본문의 인코딩을 호출자가 판정하도록 lossy 변환은 하지 않는다.
pub fn run_bytes_allow_diff<P, S>(repo: P, args: &[S]) -> Result<Vec<u8>, String>
where
    P: AsRef<OsStr>,
    S: AsRef<OsStr>,
{
    let output = capture(repo, args, READ_TIMEOUT)?;
    if !matches!(output.code, Some(0 | 1)) {
        return Err(failure_message(&output.stderr));
    }
    Ok(output.stdout)
}

/// 설치된 git의 (major, minor). 읽지 못하면 None.
///
/// 버전에 따라 붙일 수 있는 옵션이 갈린다(`push --force-if-includes`는 2.30부터). 앱이 떠
/// 있는 동안 git이 바뀌는 일은 없다고 보고 프로세스당 한 번만 묻는다.
pub fn version() -> Option<(u32, u32)> {
    static VERSION: OnceLock<Option<(u32, u32)>> = OnceLock::new();
    *VERSION.get_or_init(|| {
        run(".", &["--version"])
            .ok()
            .and_then(|out| parse_version(&out))
    })
}

/// `git version 2.50.1 (Apple Git-155)`, `git version 2.30.0.windows.1` 꼴에서 앞의 두 수를 뽑는다.
fn parse_version(out: &str) -> Option<(u32, u32)> {
    let numbers = out.trim().strip_prefix("git version ")?;
    let mut parts = numbers.split(|c: char| !c.is_ascii_digit());
    let major = parts.next()?.parse().ok()?;
    let minor = parts.next()?.parse().ok()?;
    Some((major, minor))
}

/// 콜백이 계속할지 멈출지 알려주는 신호. `Stop`이면 남은 출력을 버리고 프로세스를 정리한다.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Flow {
    Continue,
    Stop,
}

/// git stdout을 `separator` 단위로 흘려보내며 레코드마다 `on_record`를 부른다.
///
/// 출력을 통째로 받아 파싱하는 대신 읽으면서 파싱해 git 실행 시간과 파싱 시간을 겹친다.
/// 대형 저장소에서 `git log` 출력이 수 MB라 메모리도 아낀다.
/// `on_record`가 [`Flow::Stop`]을 돌려주면 파이프를 닫고 프로세스를 kill + wait 해서
/// 좀비를 남기지 않는다.
pub fn stream_records<P, S, F>(
    repo: P,
    args: &[S],
    separator: u8,
    on_record: F,
) -> Result<(), String>
where
    P: AsRef<OsStr>,
    S: AsRef<OsStr>,
    F: FnMut(&str) -> Flow,
{
    stream_records_within(repo, args, separator, STREAM_TIMEOUT, on_record)
}

fn stream_records_within<P, S, F>(
    repo: P,
    args: &[S],
    separator: u8,
    timeout: Duration,
    on_record: F,
) -> Result<(), String>
where
    P: AsRef<OsStr>,
    S: AsRef<OsStr>,
    F: FnMut(&str) -> Flow,
{
    // 읽기 루프 전체가 git 출력을 기다리는 구간이다
    crate::blocking::wait(|| stream_blocking(repo, args, separator, timeout, on_record))
}

/// 상한이 지나면 프로세스 그룹을 죽이는 감시 스레드.
///
/// 읽기 루프는 `read_until`에서 막혀 있어 스스로 시계를 볼 수 없다. 감시자가 그룹을 죽이면
/// 파이프가 닫혀 루프가 EOF를 보고 빠져나온다. [`Watchdog::stop`]은 자식을 `wait`로
/// 거두기 **전에** 불러야 한다. 거둔 뒤에는 pid가 재사용될 수 있어 엉뚱한 그룹을 죽인다.
struct Watchdog {
    cancel: Option<mpsc::Sender<()>>,
    handle: Option<std::thread::JoinHandle<()>>,
    fired: Arc<AtomicBool>,
}

impl Watchdog {
    fn start(pid: u32, timeout: Duration) -> Self {
        let (cancel, cancelled) = mpsc::channel::<()>();
        let fired = Arc::new(AtomicBool::new(false));
        let flag = Arc::clone(&fired);
        let handle = std::thread::spawn(move || {
            // 송신자가 drop되면 Disconnected로 깨어나 아무것도 하지 않는다
            if let Err(mpsc::RecvTimeoutError::Timeout) = cancelled.recv_timeout(timeout) {
                flag.store(true, Ordering::SeqCst);
                runner::kill_group(pid);
            }
        });
        Self {
            cancel: Some(cancel),
            handle: Some(handle),
            fired,
        }
    }

    /// 감시를 끝내고, 그사이 상한이 지나 그룹을 죽였는지 돌려준다.
    fn stop(&mut self) -> bool {
        drop(self.cancel.take());
        if let Some(handle) = self.handle.take() {
            let _ = handle.join();
        }
        self.fired.load(Ordering::SeqCst)
    }
}

fn stream_blocking<P, S, F>(
    repo: P,
    args: &[S],
    separator: u8,
    timeout: Duration,
    mut on_record: F,
) -> Result<(), String>
where
    P: AsRef<OsStr>,
    S: AsRef<OsStr>,
    F: FnMut(&str) -> Flow,
{
    let mut command = base_command(repo);
    command
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    runner::isolate_group(&mut command);
    let mut child = command
        .spawn()
        .map_err(|e| format!("git 실행에 실패했습니다. git이 설치되어 있는지 확인하세요: {e}"))?;

    let deadline = Instant::now() + timeout;
    let mut watchdog = Watchdog::start(child.id(), timeout);
    // stderr를 stdout 다 읽은 뒤에 읽으면, git이 stderr에 64KB 넘게 쓰는 순간 서로를 기다린다
    let stderr = child.stderr.take();
    let err_reader = std::thread::spawn(move || runner::drain(stderr));

    let Some(stdout) = child.stdout.take() else {
        watchdog.stop();
        runner::kill_group(child.id());
        let _ = child.kill();
        let _ = child.wait();
        return Err("git 출력을 열지 못했습니다".to_string());
    };
    let mut reader = BufReader::new(stdout);
    let mut record = Vec::new();
    let mut stopped_early = false;
    let mut read_error = None;

    loop {
        record.clear();
        let read = match reader.read_until(separator, &mut record) {
            Ok(read) => read,
            Err(error) => {
                read_error = Some(format!("git 출력을 읽지 못했습니다: {error}"));
                break;
            }
        };
        if read == 0 {
            break;
        }
        // 마지막 레코드는 구분자 없이 끝날 수 있다
        if record.last() == Some(&separator) {
            record.pop();
        }
        // 마지막 구분자 뒤의 개행만 남은 꼬리는 레코드가 아니다
        if record.iter().all(u8::is_ascii_whitespace) {
            continue;
        }
        // 커밋 메시지가 임의 인코딩일 수 있어 lossy 변환을 쓴다
        if on_record(&String::from_utf8_lossy(&record)) == Flow::Stop {
            stopped_early = true;
            break;
        }
    }

    drop(reader);
    let timed_out = watchdog.stop();

    if stopped_early || read_error.is_some() || timed_out {
        // 파이프를 닫으면 대개 SIGPIPE로 끝나지만, 확실히 정리하고 회수한다
        runner::kill_group(child.id());
        let _ = child.kill();
        let _ = child.wait();
        // 그룹 밖으로 빠져나간 손자가 stderr를 쥐고 있을 수 있어 기다리는 시간을 자른다
        runner::join_within(err_reader, Instant::now() + runner::READER_GRACE);
        if timed_out {
            return Err(timeout_message(args, timeout));
        }
        return read_error.map_or(Ok(()), Err);
    }

    // stdout을 닫고도 끝나지 않는 git이 있을 수 있다. 감시자는 이미 멈췄으니 남은 시간만큼만 기다린다
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if Instant::now() < deadline => std::thread::sleep(EXIT_POLL),
            Ok(None) => {
                runner::kill_group(child.id());
                let _ = child.kill();
                let _ = child.wait();
                return Err(timeout_message(args, timeout));
            }
            Err(e) => return Err(format!("git 종료를 기다리지 못했습니다: {e}")),
        }
    };
    let errors =
        runner::join_within(err_reader, Instant::now() + runner::READER_GRACE).unwrap_or_default();

    if !status.success() {
        return Err(failure_message(&errors));
    }
    Ok(())
}

/// 여러 git 호출을 동시에 실행한다.
///
/// `load_graph`가 쓰는 log, for-each-ref, rev-parse, status, stash list는 서로 값을 주고받지
/// 않아 순차로 돌릴 이유가 없다. 전부 읽기 전용이고 `--no-optional-locks`라 인덱스 잠금도
/// 건드리지 않는다. 결과는 넘긴 순서 그대로 돌아온다.
pub fn run_all<P, S>(repo: P, commands: &[&[S]]) -> Vec<Result<String, String>>
where
    P: AsRef<OsStr> + Sync,
    S: AsRef<OsStr> + Sync,
{
    if commands.len() <= 1 {
        return commands.iter().map(|args| run(&repo, args)).collect();
    }

    // 각 호출은 scope가 띄운 스레드(런타임 밖)에서 돈다. 기다리는 쪽은 이 스레드라 여기를 감싼다
    crate::blocking::wait(|| {
        std::thread::scope(|scope| {
            let handles: Vec<_> = commands
                .iter()
                .map(|args| scope.spawn(|| run(&repo, args)))
                .collect();

            handles
                .into_iter()
                .map(|handle| {
                    handle
                        .join()
                        .unwrap_or_else(|_| Err("git 호출 중 내부 오류가 발생했습니다".to_string()))
                })
                .collect()
        })
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testrepo::TempRepo;
    use std::time::{Duration, Instant};

    #[test]
    fn 저장소가_아닌_경로는_git_stderr를_그대로_전달한다() {
        let err = run(std::env::temp_dir(), &["rev-parse", "--show-toplevel"]);
        // 임시 디렉토리가 어쩌다 저장소 안일 수도 있으니 오류일 때만 검증한다
        if let Err(message) = err {
            assert!(!message.is_empty());
        }
    }

    #[test]
    fn run_all은_넘긴_순서대로_결과를_돌려준다() {
        let repo = TempRepo::linear("gitlanes-runall", 1);
        let results = run_all(
            repo.path(),
            &[
                &["--version"] as &[&str],
                &["rev-parse", "--is-inside-work-tree"],
                &["--version"],
            ],
        );
        assert_eq!(results.len(), 3);
        assert!(results[0].as_ref().unwrap().starts_with("git version"));
        assert_eq!(results[1].as_ref().unwrap().trim(), "true");
        assert!(results[2].as_ref().unwrap().starts_with("git version"));
    }

    #[test]
    fn run_all은_실패한_호출만_오류로_남긴다() {
        let repo = TempRepo::linear("gitlanes-runall-err", 1);
        let results = run_all(
            repo.path(),
            &[&["--version"] as &[&str], &["definitely-not-a-git-command"]],
        );
        assert!(results[0].is_ok());
        assert!(results[1].is_err());
    }

    #[test]
    fn stream_records는_레코드마다_콜백을_부른다() {
        // 실행 환경의 히스토리 깊이에 묶이지 않도록 저장소를 직접 만든다
        let repo = TempRepo::linear("gitlanes-stream", 5);

        let mut lines = Vec::new();
        stream_records(
            repo.path(),
            &["log", "-n", "3", "--format=%H%x1e"],
            0x1e,
            |record| {
                lines.push(record.trim().to_string());
                Flow::Continue
            },
        )
        .expect("성공해야 한다");

        assert_eq!(lines.len(), 3);
        assert!(lines.iter().all(|sha| sha.len() >= 40), "{lines:?}");
        assert_eq!(lines[0], repo.rev("HEAD"), "topo 순서 선두부터다");
    }

    #[test]
    fn stream_records는_조기_중단해도_오류가_아니다() {
        // 남은 출력을 버리고 프로세스를 정리하므로 SIGPIPE가 오류로 새어나오면 안 된다.
        // 반복해서 돌려 좀비나 파일 디스크립터가 쌓이지 않는지도 함께 본다
        let repo = TempRepo::linear("gitlanes-stream-stop", 5);

        for _ in 0..20 {
            let mut seen = 0usize;
            stream_records(
                repo.path(),
                &["log", "--all", "--format=%H%x1e"],
                0x1e,
                |_record| {
                    seen += 1;
                    if seen >= 2 {
                        Flow::Stop
                    } else {
                        Flow::Continue
                    }
                },
            )
            .expect("조기 중단은 성공이다");
            assert_eq!(seen, 2, "Stop 이후로는 콜백을 부르지 않는다");
        }

        // 조기 중단을 반복한 뒤에도 같은 저장소를 온전히 읽을 수 있다
        let mut all = 0usize;
        stream_records(
            repo.path(),
            &["log", "--all", "--format=%H%x1e"],
            0x1e,
            |_record| {
                all += 1;
                Flow::Continue
            },
        )
        .unwrap();
        assert_eq!(all, 5);
    }

    #[test]
    fn stream_records는_실패한_명령의_stderr를_전달한다() {
        let repo = TempRepo::linear("gitlanes-stream-err", 1);
        let err = stream_records(repo.path(), &["log", "--nope-not-an-option"], 0x1e, |_| {
            Flow::Continue
        })
        .unwrap_err();
        assert!(!err.is_empty());
        assert!(!err.contains("성공"), "{err}");
    }

    #[test]
    fn git_버전_문자열에서_major_minor를_뽑는다() {
        assert_eq!(
            parse_version("git version 2.50.1 (Apple Git-155)\n"),
            Some((2, 50))
        );
        assert_eq!(parse_version("git version 2.30.0.windows.1"), Some((2, 30)));
        assert_eq!(parse_version("git version 2.29.2"), Some((2, 29)));
        assert_eq!(parse_version("git version 3.0"), Some((3, 0)));
        assert_eq!(parse_version("hub version 2.14"), None);
        assert_eq!(parse_version("git version x"), None);
        assert!(version().is_some(), "테스트 환경의 git 버전을 읽지 못했다");
    }

    /// 셸 alias로 멈춘 git을 흉내 낸다. sleep의 pid를 남겨 그룹 kill로 죽었는지 확인한다.
    #[cfg(unix)]
    fn stuck_repo(prefix: &str) -> (TempRepo, std::path::PathBuf) {
        let repo = TempRepo::linear(prefix, 1);
        let mark = std::path::PathBuf::from(repo.path())
            .join(".git")
            .join("stuck.pid");
        // pid를 먼저 남기고 exec한다. 부하가 큰 기계에서는 셸이 상한 안에 다음 줄까지 못 갈 수 있다
        let alias = format!("!echo $$ > '{}'; exec sleep 30", mark.display());
        repo.git(&["config", "alias.stuck", alias.as_str()]);
        (repo, mark)
    }

    #[cfg(unix)]
    fn assert_sleeper_dead(mark: &std::path::Path) {
        let pid: i32 = std::fs::read_to_string(mark)
            .unwrap_or_else(|e| panic!("alias가 pid를 남기지 못했다: {e}"))
            .trim()
            .parse()
            .unwrap();
        let deadline = Instant::now() + Duration::from_secs(2);
        // SAFETY: 시그널 0은 존재 확인만 한다
        while unsafe { libc::kill(pid, 0) } == 0 {
            assert!(Instant::now() < deadline, "alias의 sleep {pid}가 살아 있다");
            std::thread::sleep(Duration::from_millis(20));
        }
    }

    #[cfg(unix)]
    #[test]
    fn 멈춘_읽기_git은_상한에서_그룹째_죽이고_사람이_읽을_오류를_준다() {
        let (repo, mark) = stuck_repo("gl-read-timeout");
        let started = Instant::now();
        let err = run_bytes_within(repo.path(), &["stuck"], Duration::from_secs(3)).unwrap_err();

        assert!(
            started.elapsed() < Duration::from_secs(8),
            "상한 3초인데 {:?} 걸렸다",
            started.elapsed()
        );
        assert!(
            err.contains("git stuck 명령이 3초 안에 끝나지 않아"),
            "{err}"
        );
        assert_sleeper_dead(&mark);
    }

    #[cfg(unix)]
    #[test]
    fn 멈춘_스트리밍_git도_상한에서_그룹째_죽인다() {
        let (repo, mark) = stuck_repo("gl-stream-timeout");
        let started = Instant::now();
        let err = stream_records_within(
            repo.path(),
            &["stuck"],
            0x1e,
            Duration::from_secs(3),
            |_| Flow::Continue,
        )
        .unwrap_err();

        assert!(
            started.elapsed() < Duration::from_secs(8),
            "상한 3초인데 {:?} 걸렸다",
            started.elapsed()
        );
        assert!(err.contains("3초 안에 끝나지 않아"), "{err}");
        assert_sleeper_dead(&mark);
    }

    #[test]
    fn 실행기를_바꿔도_읽기_결과는_그대로다() {
        let repo = TempRepo::linear("gl-read-same", 3);
        // 종료 코드 1을 성공으로 보는 diff --no-index
        repo.write("x.txt", "a\n");
        repo.write("y.txt", "b\n");
        let diff =
            run_bytes_allow_diff(repo.path(), &["diff", "--no-index", "--", "x.txt", "y.txt"])
                .unwrap();
        let diff = String::from_utf8(diff).unwrap();
        assert!(diff.contains("-a") && diff.contains("+b"), "{diff}");
        // 실패는 stderr가 오류가 된다
        let err = run(repo.path(), &["rev-parse", "--verify", "nope"]).unwrap_err();
        assert!(err.contains("fatal"), "{err}");
        // 바이트 그대로 돌려준다
        let count = run(repo.path(), &["rev-list", "--count", "HEAD"]).unwrap();
        assert_eq!(count.trim(), "3");
    }

    #[test]
    fn git_버전_조회는_성공한다() {
        let out = run(".", &["--version"]).expect("git --version은 성공해야 한다");
        assert!(out.starts_with("git version"), "{out}");
    }
}
