//! 모든 쓰기 command가 공유하는 실행기.
//!
//! 여기 걸어둔 제약이 "앱이 멈추지 않는다"는 보장의 전부다.
//!
//! - **절대 프롬프트를 띄우지 않는다.** stdin을 막고 `GIT_TERMINAL_PROMPT=0`,
//!   `GIT_SSH_COMMAND=<사용자 ssh 명령> -oBatchMode=yes`, `GIT_ASKPASS`/`SSH_ASKPASS`를 빈 값으로 둔다.
//!   자격증명이 없으면 물어보지 않고 실패한다. 앱에는 터미널이 없어서 한 번 물어보면
//!   프로세스가 영구히 멈춘다.
//! - **타임아웃이 있다.** 네트워크 120초, 로컬 60초. 넘으면 kill + wait 후
//!   `ok=false`, `stderr="timed out after Ns"`.
//! - **종료 코드는 오류가 아니다.** non-fast-forward나 인증 실패는 사용자가 읽어야 하는
//!   결과라서 `ok=false` + stderr로 돌려준다. `Err`는 인자 검증 실패에만 쓴다.
//! - **인증 실패는 따로 표시한다.** 프롬프트를 막았다는 것은 ssh-agent나 keychain이
//!   없는 환경에서 반드시 실패한다는 뜻이다. 그 경우 [`OpResult::needs_auth`]를 켜고
//!   실행한 인자를 [`OpResult::command`]에 담아 프론트가 내장 터미널로 넘기게 한다.
//!   예외로 gpg 서명이 비밀번호를 물으려다 실패한 경우는 로컬 명령이어도 같이 켠다.
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

/// git이 끝난 뒤(정상 종료든 kill이든) 읽기 스레드를 기다리는 상한.
///
/// 남은 파이프 버퍼를 비우는 데는 밀리초면 충분하다. 이보다 오래 걸린다면 그룹 밖의
/// 프로세스가 파이프를 쥐고 있다는 뜻이고, 기다려도 끝난다는 보장이 없다.
pub const READER_GRACE: Duration = Duration::from_secs(2);

/// 종료를 기다리는 폴링 간격의 상한. 사람이 못 느끼는 지연이면서 폴링 비용도 없는 값.
const POLL_INTERVAL: Duration = Duration::from_millis(20);

/// 폴링 첫 간격. 읽기 경로의 git은 대부분 수 ms 안에 끝난다. 처음부터 20ms를 자면
/// `rev-parse` 하나가 20ms가 된다. 1ms에서 시작해 두 배씩 늘려 [`POLL_INTERVAL`]에서 멈춘다.
const FIRST_POLL: Duration = Duration::from_millis(1);

/// stdout/stderr에서 보관할 줄 수. 프론트가 토스트에 그대로 뿌리므로 상한이 필요하다.
const MAX_OUTPUT_LINES: usize = 200;

/// 출력이 길 때 앞에서 보존할 줄 수. 나머지([`MAX_OUTPUT_LINES`] - 이 값)는 꼬리에서 남긴다.
const HEAD_LINES: usize = 20;

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

/// HTTP 403. 위 목록과 달리 상태 문구라 대소문자가 섞여 온다. 소문자로 내려 비교한다.
///
/// git 실제 문구는 `The requested URL returned error: 403`이다(`403 Forbidden`은 오래된 curl이
/// 쓰던 꼴). GitHub 토큰 권한 부족, SAML SSO 미승인, 다른 계정으로 로그인한 경우가 여기 온다.
/// 터미널에서 다시 실행해도 같은 계정이면 또 거절되지만, 사용자가 거기서 계정을 바꾸고
/// 재시도할 수 있으므로 needs_auth로 둔다. 어느 계정이 거절됐는지는 `denied_account`가 알린다.
const AUTH_MARKERS_403: [&str; 2] = ["returned error: 403", "403 forbidden"];

/// 자격증명을 쓰는 명령. 네트워크 인증 실패는 여기서만 판정한다(gpg 서명 실패는 별도).
///
/// 로컬 명령도 stderr에 `Permission denied`를 쓴다(`chmod 000` 파일을 add하면
/// `error: open("x"): Permission denied`). 이걸 인증 실패로 보면 스테이징 실패 토스트에
/// "터미널에서 실행"이 뜨는데, 터미널에서도 똑같이 실패한다.
/// 원격 브랜치 삭제와 태그 push는 `push`로 나간다. `submodule`은 우리가 `update`로만 부르고,
/// 거기서 clone과 fetch가 일어난다(v0.19).
const NETWORK_VERBS: [&str; 5] = ["fetch", "pull", "push", "ls-remote", "submodule"];

/// 서명 실패. git이 gpg 오류 앞에 붙이는 문구라 commit, merge, tag, rebase 어디서 서명하든 같다.
const SIGNING_FAILED_MARKER: &str = "gpg failed to sign the data";

/// 서명 키 자체가 없다. 터미널에서 pinentry가 떠도 똑같이 실패하므로 핸드오프하지 않는다
const NO_SECRET_KEY_MARKER: &str = "no secret key";

/// `gpg.format=ssh` 서명이 비밀번호 때문에 실패했다. git은 ssh-keygen의 stderr를 `error: ` 뒤에
/// 그대로 붙인다(gpg 경로와 달리 고정 접두가 없다). TTY가 없으면 ssh-keygen이 프롬프트를 stderr에
/// 쓰고 막힌 stdin에서 빈 비밀번호를 읽어 이 문구로 끝난다. 실측(git 2.50.1, OpenSSH 10.3p1):
/// `error: Enter passphrase for "<키>": Load key "<키>": incorrect passphrase supplied to decrypt private key?`
/// 키 파일이 없으면 `Couldn't load public key`로 끝나 여기 걸리지 않는다(터미널에서도 실패하니 맞다)
const SSH_PASSPHRASE_MARKER: &str = "incorrect passphrase supplied to decrypt private key";

/// gpg가 `--status-fd`로 쓰는 기계용 상태 줄의 접두
const GPG_STATUS_PREFIX: &str = "[GNUPG:]";

/// 바이트 그대로의 실행 결과. 읽기 경로(`git::run_bytes`)는 lossy 변환 전 바이트가 필요하다.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RawOutcome {
    /// 시그널로 죽으면 None
    pub code: Option<i32>,
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
    pub timed_out: bool,
}

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
    cmd.env("GIT_SSH_COMMAND", ssh_command(repo));
    cmd.env("GIT_ASKPASS", "");
    cmd.env("SSH_ASKPASS", "");

    // 오류 메시지를 파싱한다(needs_auth). 로케일에 따라 문구가 흔들리면 판정이 깨진다.
    cmd.env("LANG", "C");
    cmd.env("LC_ALL", "C");

    // 편집기를 띄우려는 경로가 남아 있어도 여기서 막힌다
    cmd.env("GIT_EDITOR", "true");

    // 경로 인자는 glob이 아니라 리터럴이다. 없으면 `note*` 하나를 discard할 때 clean이
    // `note_draft.txt`까지 지운다(untracked라 복구 불가). 확인 다이얼로그에는 파일 하나만 보인다.
    if takes_literal_pathspecs(args) {
        cmd.env("GIT_LITERAL_PATHSPECS", "1");
    }

    cmd.stdin(Stdio::null());
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());
    cmd
}

/// 사용자가 고른 ssh 명령 뒤에 `-oBatchMode=yes`를 붙인 값. `GIT_SSH_COMMAND`로 넘긴다.
///
/// 환경변수 `GIT_SSH_COMMAND`는 설정보다 우선이라, 고정값을 걸면 사용자의 `core.sshCommand`
/// (계정별 `-i` 키, 1Password SSH agent 래퍼 등)가 통째로 무시된다. git이 고르는 순서를 그대로
/// 따라 사용자 명령을 찾고, 프롬프트를 막는 옵션만 덧붙인다.
///
/// 설정은 저장소 문맥에서 읽어야 한다. `includeIf "gitdir:..."`로 디렉토리마다 키를 고르는
/// 사용자가 있다. 그래서 git 호출이 하나 늘지만(수 ms) 쓰기 작업 하나에 비하면 작다.
fn ssh_command(repo: &str) -> String {
    let from_env = std::env::var("GIT_SSH_COMMAND").ok();
    let from_config = match from_env.as_deref().map(str::trim) {
        Some(command) if !command.is_empty() => None,
        _ => git::run(repo, &["config", "--get", "core.sshCommand"]).ok(),
    };
    let program = std::env::var("GIT_SSH").ok();
    batch_ssh_command(
        from_env.as_deref(),
        from_config.as_deref(),
        program.as_deref(),
    )
}

/// git의 ssh 선택 순서(`GIT_SSH_COMMAND` > `core.sshCommand` > `GIT_SSH` > `ssh`)로 고른 명령에
/// `-oBatchMode=yes`를 붙인다.
///
/// - `GIT_SSH`는 셸을 거치지 않는 프로그램 경로라 공백이 든 경로도 있다. 작은따옴표로 감싸
///   셸 명령으로 바꾼다
/// - ssh는 같은 옵션이 여러 번 오면 **처음 값**을 쓴다. 사용자 명령에 `-oBatchMode=no`가
///   있으면 그쪽이 이긴다. 사용자가 일부러 쓴 값이라 존중한다
/// - plink 같은 비 OpenSSH 클라이언트는 `-o`를 모른다. macOS 앱이라 다루지 않는다
fn batch_ssh_command(
    from_env: Option<&str>,
    from_config: Option<&str>,
    program: Option<&str>,
) -> String {
    let chosen = [from_env, from_config]
        .into_iter()
        .flatten()
        .map(str::trim)
        .find(|command| !command.is_empty())
        .map(str::to_string)
        .or_else(|| {
            program
                .map(str::trim)
                .filter(|path| !path.is_empty())
                .map(|path| format!("'{}'", path.replace('\'', "'\\''")))
        });
    match chosen {
        Some(command) => format!("{command} -oBatchMode=yes"),
        None => "ssh -oBatchMode=yes".to_string(),
    }
}

/// 사용자 훅을 돌리면서 우리에게서 경로 인자를 받지 않는 명령.
///
/// `GIT_LITERAL_PATHSPECS`는 환경변수라 훅 프로세스에 그대로 물려진다(`git --literal-pathspecs`도
/// 내부에서 같은 변수를 세운다). 그러면 pre-commit 훅 안의 `git diff --cached -- '*.py'`가
/// 아무것도 못 찾고, 린트가 조용히 건너뛰어진 채 커밋이 통과한다. 이 명령들은 경로를
/// 받지 않으니 변수를 걸 이유가 없고, 걸지 않아야 사용자 훅이 터미널에서와 똑같이 돈다.
///
/// 기본은 "건다"다. 목록에 빠진 명령이 생겨도 결과는 훅의 glob이 리터럴이 되는 정도지만,
/// 반대로 경로를 받는 명령에서 빠지면 다른 파일이 지워진다.
const HOOK_RUNNING_VERBS: [&str; 8] = [
    "commit",
    "merge",
    "rebase",
    "cherry-pick",
    "revert",
    "push",
    "pull",
    "am",
];

/// `GIT_LITERAL_PATHSPECS`를 걸지 정한다. 예외는 세 갈래다.
///
/// - [`HOOK_RUNNING_VERBS`]: 훅으로 새어 들어가지 않게 뺀다
/// - 경로 없는 `stash`: git이 내부에서 `clean -- :/`, `checkout -- :/`처럼 pathspec magic을
///   쓴다. 변수가 걸리면 `:/`가 리터럴이 돼서 `stash -u`가 untracked 파일을 스태시에 넣고도
///   워킹 트리에 그대로 남기고(pop이 "already exists"로 실패), `--keep-index`는 오류로 끝난다.
///   경로를 넘기면 git이 그 경로를 내부 명령에 그대로 전달해 리터럴 처리가 정상 동작한다
///   (v0.15.1 git 2.50에서 실측)
/// - 경로 없는 `submodule`: 서브모듈 안의 훅으로 새어 들어가지 않게 뺀다(v0.19)
fn takes_literal_pathspecs<S: AsRef<OsStr>>(args: &[S]) -> bool {
    let verb = args.first().and_then(|verb| verb.as_ref().to_str());
    match verb {
        Some(verb) if HOOK_RUNNING_VERBS.contains(&verb) => false,
        Some("stash") => has_paths(args),
        // 서브모듈 update는 서브모듈 안에서 checkout을 돌려 post-checkout 훅이 변수를 물려받는다.
        // 경로가 없으면(전부) 걸 이유가 없다. 경로가 있으면 `lib*`가 확인하지 않은 다른
        // 서브모듈의 HEAD까지 옮기지 않게 리터럴로 둔다
        Some("submodule") => has_paths(args),
        _ => true,
    }
}

/// `--` 뒤에 경로가 하나라도 있는가.
fn has_paths<S: AsRef<OsStr>>(args: &[S]) -> bool {
    args.iter()
        .position(|arg| arg.as_ref() == "--")
        .is_some_and(|at| at + 1 < args.len())
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
///
/// 유닉스에서는 git을 **새 프로세스 그룹**으로 띄운다. git이 낳은 훅의 셸, ssh,
/// git-remote-https는 파이프를 상속해 쥐고 있어서 git만 죽이면 읽기 스레드가 끝나지 않는다.
/// 타임아웃 때 그룹 전체를 죽이고, 그래도 남는 파이프에 대비해 스레드 join에 상한을 둔다.
pub fn execute_with_input(
    command: Command,
    timeout: Duration,
    input: Option<Vec<u8>>,
) -> Result<Outcome, String> {
    let raw = capture(command, timeout, input)?;
    Ok(Outcome {
        code: raw.code,
        stdout: String::from_utf8_lossy(&raw.stdout).into_owned(),
        stderr: String::from_utf8_lossy(&raw.stderr).into_owned(),
        timed_out: raw.timed_out,
    })
}

/// [`execute_with_input`]의 바이트 버전. 읽기 경로(`git.rs`)도 이 실행기를 쓴다.
/// 멈춘 git(잠긴 NFS, fsmonitor 훅 등)이 블로킹 스레드를 영원히 붙잡지 않게 하는 장치가
/// 쓰기와 읽기에서 같아야 해서다.
pub fn capture(
    command: Command,
    timeout: Duration,
    input: Option<Vec<u8>>,
) -> Result<RawOutcome, String> {
    // spawn부터 리더 join까지 전부 기다리는 구간이다. 최대 120초 + 2초 동안 워커를 내놓는다
    crate::blocking::wait(|| execute_blocking(command, timeout, input))
}

/// 자식을 새 세션(곧 새 프로세스 그룹)으로 띄운다. 타임아웃 때 [`kill_group`]이 그룹 전체를 죽인다.
///
/// 그룹만 새로 만들면(`process_group(0)`) 앱의 제어 터미널을 물려받는다. 터미널에서 띄운 앱
/// (`tauri dev`)에서는 ssh-keygen이나 pinentry가 `/dev/tty`를 열어 비밀번호를 기다리고,
/// 백그라운드 그룹이라 SIGTTIN으로 멈춘 채 타임아웃까지 간다. Finder에서 띄운 앱은 제어 터미널이
/// 없어 곧바로 실패한다. setsid로 세션을 새로 열면 제어 터미널이 없어 두 경우가 같아진다.
/// 새 세션의 리더는 pid가 곧 그룹 id라 killpg는 그대로 동작한다.
pub fn isolate_group(command: &mut Command) {
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        // SAFETY: setsid는 async-signal-safe다. fork 뒤 exec 전에 메모리를 할당하지 않는다.
        // fork된 자식은 그룹 리더가 아니라 EPERM이 날 수 없지만, 실패하면 spawn을 실패시킨다.
        unsafe {
            command.pre_exec(|| {
                if libc::setsid() == -1 {
                    return Err(std::io::Error::last_os_error());
                }
                Ok(())
            });
        }
    }
    #[cfg(not(unix))]
    let _ = command;
}

fn execute_blocking(
    mut command: Command,
    timeout: Duration,
    input: Option<Vec<u8>>,
) -> Result<RawOutcome, String> {
    if input.is_some() {
        command.stdin(Stdio::piped());
    }
    isolate_group(&mut command);

    let mut child = command
        .spawn()
        .map_err(|e| format!("Could not run git. Check that git is installed: {e}"))?;

    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let stdin = child.stdin.take();

    // scope를 쓰지 않는다. scope는 끝에서 join을 강제해서, 손자 프로세스가 파이프를 놓지
    // 않으면 상한 없이 막힌다. 상한을 넘긴 스레드는 버려야 하므로 'static 스레드로 띄운다.
    let out_reader = std::thread::spawn(move || drain(stdout));
    let err_reader = std::thread::spawn(move || drain(stderr));
    // 쓰기가 끝나면 stdin을 drop해서 파이프를 닫는다. 닫지 않으면 자식이 EOF를
    // 못 보고 영원히 기다린다.
    let in_writer = std::thread::spawn(move || {
        if let (Some(mut pipe), Some(bytes)) = (stdin, input) {
            let _ = pipe.write_all(&bytes);
            let _ = pipe.flush();
        }
    });

    let deadline = Instant::now() + timeout;
    let mut status = None;
    let mut pause = FIRST_POLL;
    loop {
        match child.try_wait() {
            Ok(Some(done)) => {
                status = Some(done);
                break;
            }
            Ok(None) => {}
            Err(error) => {
                kill_tree(&mut child);
                return Err(format!("Could not wait for git to exit: {error}"));
            }
        }
        if Instant::now() >= deadline {
            break;
        }
        std::thread::sleep(pause);
        pause = (pause * 2).min(POLL_INTERVAL);
    }

    let timed_out = status.is_none();
    if timed_out {
        kill_tree(&mut child);
    }

    // git이 끝난 뒤에도 파이프를 쥔 프로세스가 있을 수 있다. 정상 종료 쪽은 훅이
    // `서버 &`처럼 백그라운드로 띄운 것이고, 그건 사용자가 의도한 것이라 죽이지 않는다.
    // 어느 쪽이든 git의 출력은 이미 다 나왔으니 기다리는 시간만 자른다.
    let joined = Instant::now() + READER_GRACE;
    join_within(in_writer, joined);
    Ok(RawOutcome {
        code: status.and_then(|status| status.code()),
        stdout: join_within(out_reader, joined).unwrap_or_default(),
        stderr: join_within(err_reader, joined).unwrap_or_default(),
        timed_out,
    })
}

/// 타임아웃으로 죽일 때 git과 그 자손을 함께 죽인다.
///
/// 유닉스는 그룹 id(= git pid)로 `killpg`한다. pid 재사용 걱정은 없다. 아직 `wait`로
/// 거두지 않은 자식은 끝났더라도 좀비로 남아 pid와 그룹 id를 붙들고 있다.
/// `setsid`로 그룹을 빠져나간 프로세스(ssh ControlPersist 마스터 등)는 여기서 못 죽인다.
/// 그 경우는 [`join_within`]의 상한이 반환을 보장한다.
fn kill_tree(child: &mut std::process::Child) {
    kill_group(child.id());
    // killpg가 실패해도 git 자신은 확실히 죽인다
    let _ = child.kill();
    let _ = child.wait();
}

/// [`isolate_group`]으로 띄운 자식의 그룹 전체에 SIGKILL을 보낸다.
///
/// 호출자는 그 자식을 아직 `wait`로 거두지 않았어야 한다. 거두기 전에는 좀비가 pid와
/// 그룹 id를 붙들고 있어 엉뚱한 그룹을 죽일 일이 없다.
#[cfg(unix)]
pub fn kill_group(pid: u32) {
    if let Ok(pgid) = libc::pid_t::try_from(pid) {
        // SAFETY: 인자는 정수뿐이고, 실패(ESRCH 등)는 반환값으로만 알린다.
        unsafe {
            libc::killpg(pgid, libc::SIGKILL);
        }
    }
}

/// Windows는 정식 지원 전이라 그룹을 죽이지 않는다. [`kill_tree`]가 git만 죽인다.
#[cfg(not(unix))]
pub fn kill_group(_pid: u32) {}

/// 스레드가 `deadline` 안에 끝나면 결과를, 아니면 None을 준다.
///
/// 표준 라이브러리에는 시간 제한 join이 없어 `is_finished`를 폴링한다. 끝나지 않은 스레드는
/// handle을 drop해서 떼어낸다(detach). 그 스레드는 파이프 읽기 끝을 쥔 채 `read`에서
/// 기다리다가, 마지막 writer(그룹 밖으로 빠져나간 손자)가 끝나는 순간 EOF를 보고 스스로
/// 끝난다. 그때까지 남는 것은 스레드 스택 하나와 그동안 읽은 출력뿐이고, 그 writer가 영원히
/// 살아 있지 않는 한 새는 것은 없다. 타임아웃이 날 때마다 쌓일 수 있지만 그룹 kill이 대부분을
/// 정리하므로 실제로 남는 경우는 드물다.
pub fn join_within<T>(handle: std::thread::JoinHandle<T>, deadline: Instant) -> Option<T> {
    let mut pause = FIRST_POLL;
    while !handle.is_finished() {
        if Instant::now() >= deadline {
            return None;
        }
        std::thread::sleep(pause);
        pause = (pause * 2).min(POLL_INTERVAL);
    }
    handle.join().ok()
}

/// 파이프를 끝까지 읽는다. 문자열 변환은 호출자 몫이다(임의 인코딩이 올 수 있다).
pub fn drain<R: Read>(source: Option<R>) -> Vec<u8> {
    let Some(mut source) = source else {
        return Vec::new();
    };
    let mut buffer = Vec::new();
    let _ = source.read_to_end(&mut buffer);
    buffer
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
                denied_account: result.denied_account.or(previous.denied_account),
            },
        });
        if !ok {
            break;
        }
    }
    merged.ok_or_else(|| "No command to run.".to_string())
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
            stdout: clip_output(&outcome.stdout),
            stderr: format!("timed out after {}s", timeout.as_secs()),
            conflicts,
            command,
            needs_auth: false,
            denied_account: None,
        };
    }

    let ok = outcome.code == Some(0);
    let judged = !ok && is_network_command(args);
    let denied_account = if judged {
        parse_denied_account(&outcome.stderr)
    } else {
        None
    };
    let network_auth =
        judged && (denied_account.is_some() || looks_like_auth_failure(&outcome.stderr));
    // 서명은 네트워크 명령이 아니어도 TTY가 있는 내장 터미널에서만 풀린다. 판정은 원문으로 한다
    let signing_prompt = !ok && looks_like_signing_prompt_failure(&outcome.stderr);
    OpResult {
        needs_auth: network_auth || signing_prompt,
        denied_account,
        ok,
        stdout: clip_output(&outcome.stdout),
        stderr: clip_output(&drop_gpg_status_lines(&outcome.stderr)),
        conflicts,
        command,
    }
}

/// 서명(gpg 또는 ssh)이 비밀번호를 물으려다 TTY가 없어 실패했는지 본다.
///
/// 앱은 stdin을 막고 터미널 없이 git을 돌려서, 비밀번호가 걸린 키는 pinentry(curses/tty)나
/// ssh-keygen 프롬프트가 답을 받지 못하고 곧바로 exit 128로 끝난다(멈추지는 않는다). 내장
/// 터미널에는 TTY가 있어 같은 명령을 거기서 돌리면 비밀번호를 묻는다. 키가 아예 없는 경우는
/// 터미널에서도 똑같이 실패하므로 뺀다.
pub fn looks_like_signing_prompt_failure(stderr: &str) -> bool {
    let lowered = stderr.to_lowercase();
    let gpg = lowered.contains(SIGNING_FAILED_MARKER) && !lowered.contains(NO_SECRET_KEY_MARKER);
    gpg || lowered.contains(SSH_PASSPHRASE_MARKER)
}

/// gpg의 `[GNUPG:]` 상태 줄을 뺀다. 지문과 내부 코드뿐이라 사용자에게는 소음이고,
/// 사람이 읽을 이유(`gpg: signing failed: ...`)를 토스트 아래로 밀어낸다.
/// 원문이 필요하면 `command`를 내장 터미널에서 다시 실행하면 그대로 보인다.
fn drop_gpg_status_lines(stderr: &str) -> String {
    if !stderr.contains(GPG_STATUS_PREFIX) {
        return stderr.to_string();
    }
    stderr
        .split_inclusive('\n')
        .filter(|line| !line.trim_start().starts_with(GPG_STATUS_PREFIX))
        .collect()
}

/// stderr가 자격증명 문제로 보이는지 본다.
///
/// 오탐은 "터미널에서 실행" 버튼이 쓸데없이 뜨는 정도라 값이 싸다. 반대로 놓치면
/// 사용자는 왜 실패했는지 모른 채 막힌다. 그래서 넓게 잡는다.
pub fn looks_like_auth_failure(stderr: &str) -> bool {
    let lowered = stderr.to_lowercase();
    AUTH_MARKERS
        .iter()
        .chain(AUTH_MARKERS_403.iter())
        .any(|marker| lowered.contains(marker))
}

fn is_network_command(args: &[&str]) -> bool {
    args.first()
        .is_some_and(|verb| NETWORK_VERBS.contains(verb))
}

/// 원격이 거절하며 밝힌 계정 이름을 뽑는다.
///
/// GitHub만 지원한다. 문구는 HTTPS(`remote: ` 접두)와 SSH(`ERROR: ` 접두) 모두
/// `Permission to <owner>/<repo>.git denied to <계정>.`이다. GitLab(`You are not allowed to
/// push code to this project.`), Bitbucket, Gitea의 거절 문구에는 계정 이름이 없다(2026-10 조사).
///
/// 계정 자리에 공백이 있으면 계정이 아니다. SSH deploy key로 거절되면 `denied to deploy key.`가
/// 온다. 그때는 계정을 바꿔 풀 문제가 아니라 None으로 둔다.
pub fn parse_denied_account(stderr: &str) -> Option<String> {
    const MARK: &str = "denied to ";
    stderr.lines().find_map(|line| {
        let line = line.trim();
        let rest = &line[line.find("Permission to ")?..];
        let at = rest.find(MARK)?;
        let account = rest[at + MARK.len()..].trim().trim_end_matches('.');
        let valid = !account.is_empty() && !account.contains(char::is_whitespace);
        valid.then(|| account.to_string())
    })
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

/// 토스트에 뿌릴 출력을 정리한다.
///
/// - 파이프로 받은 진행 표시는 `\r`로 덮어쓰는 문구가 한 줄에 이어 붙어 온다
///   (`Rebasing (2/3)\rRebasing (3/3)\r...`). 터미널이 보여주는 것처럼 줄마다 마지막 `\r`
///   뒤만 남긴다
/// - [`MAX_OUTPUT_LINES`]를 넘으면 앞 [`HEAD_LINES`]줄과 뒤 나머지를 남기고 가운데를
///   생략 표시 한 줄로 바꾼다. git은 오류 문장을 첫 줄에, 요약을 끝에 쓴다. 꼬리만 남기면
///   덮어쓸 파일 목록만 보이고 무엇이 실패했는지가 사라진다
pub fn clip_output(text: &str) -> String {
    let has_progress = text.contains('\r');
    let mut lines: Vec<&str> = text.lines().collect();
    if !has_progress && lines.len() <= MAX_OUTPUT_LINES {
        return text.to_string();
    }

    if has_progress {
        lines = lines.into_iter().map(last_overwrite).collect();
    }
    let mut kept: Vec<String> = Vec::with_capacity(MAX_OUTPUT_LINES + 1);
    if lines.len() > MAX_OUTPUT_LINES {
        let tail_lines = MAX_OUTPUT_LINES - HEAD_LINES;
        let omitted = lines.len() - MAX_OUTPUT_LINES;
        kept.extend(lines[..HEAD_LINES].iter().map(|line| (*line).to_string()));
        kept.push(format!("... ({omitted} lines omitted) ..."));
        kept.extend(
            lines[lines.len() - tail_lines..]
                .iter()
                .map(|line| (*line).to_string()),
        );
    } else {
        kept.extend(lines.iter().map(|line| (*line).to_string()));
    }

    let mut joined = kept.join("\n");
    if text.ends_with('\n') {
        joined.push('\n');
    }
    joined
}

/// `\r`로 덮어쓴 줄에서 화면에 남는 마지막 조각. 끝에 붙은 `\r`은 덮어쓸 내용이 없어 버린다.
fn last_overwrite(line: &str) -> &str {
    let line = line.trim_end_matches('\r');
    line.rsplit('\r').next().unwrap_or(line)
}

/// 브랜치/ref 이름을 검증한다. 규칙은 git이 안다.
///
/// `-` 시작을 먼저 막는 이유는 두 가지다. git 인자에서 옵션으로 해석되는 것을 막고,
/// `check-ref-format --branch -x` 자체가 `-x`를 옵션으로 먹기 때문이다.
pub fn validate_ref_name(repo: &str, name: &str) -> Result<String, String> {
    let name = name.trim();
    if name.is_empty() {
        return Err("Name is empty.".to_string());
    }
    if name.starts_with('-') {
        return Err(format!("Invalid name: {name}"));
    }

    let expanded = git::run(repo, &["check-ref-format", "--branch", name])
        .map_err(|_| format!("git does not allow this name: {name}"))?;

    // `--branch`는 `@{-1}`(직전 브랜치), `@{u}`(upstream)를 실제 이름으로 풀어 성공한다.
    // 확인 다이얼로그에는 `@{-1}`이 보이는데 git은 다른 브랜치를 지우게 된다.
    // 사용자가 적은 글자 그대로가 이름일 때만 받는다.
    if expanded.trim() != name {
        return Err(format!(
            "Use the branch name itself, not a shorthand: {name} points to {}",
            expanded.trim()
        ));
    }

    Ok(name.to_string())
}

/// 커밋 지시자(sha, `HEAD~2`, 태그 등)를 검증한다.
///
/// `check-ref-format --branch`는 `HEAD~2`나 `abc123^`을 거부해서 브랜치 이름 검증을
/// 그대로 쓸 수 없다. 실제로 가리키는 대상이 있는지를 `rev-parse --verify`로 묻는다.
pub fn validate_commitish(repo: &str, rev: &str) -> Result<String, String> {
    let rev = rev.trim();
    if rev.is_empty() {
        return Err("No target commit was given.".to_string());
    }
    if rev.starts_with('-') {
        return Err(format!("Invalid target: {rev}"));
    }

    let spec = format!("{rev}^{{commit}}");
    git::run(repo, &["rev-parse", "--verify", "--quiet", spec.as_str()])
        .map_err(|_| format!("Commit not found: {rev}"))?;

    Ok(rev.to_string())
}

/// remote 이름을 검증한다. 등록된 remote 목록에 있어야 한다.
pub fn validate_remote(repo: &str, remote: &str) -> Result<String, String> {
    let remote = remote.trim();
    if remote.is_empty() {
        return Err("Remote name is empty.".to_string());
    }
    if remote.starts_with('-') {
        return Err(format!("Invalid remote name: {remote}"));
    }

    if !remotes(repo).iter().any(|known| known == remote) {
        return Err(format!("Unknown remote: {remote}"));
    }
    Ok(remote.to_string())
}

/// 파일 경로 목록을 검증한다. `--` 뒤에 놓더라도 빈 문자열은 git이 싫어한다.
///
/// 경로는 **바이트 그대로** 쓴다. trim하면 ` a.txt`(앞에 공백)를 discard할 때 `a.txt`를
/// 되돌린다. 공백으로 시작하거나 끝나는 파일 이름은 합법이고, 그 파일을 고른 것은 사용자다.
///
/// NUL은 프로세스 인자에 실을 수 없어 spawn이 "git이 설치되어 있는지 확인하세요"로 실패한다.
/// 엉뚱한 안내가 뜨지 않게 여기서 먼저 거절한다.
///
/// `-` 시작 경로까지 막는 이유는 호출자가 `--`를 빠뜨렸을 때의 사고를 줄이기 위해서다.
pub fn validate_paths(files: &[String]) -> Result<Vec<String>, String> {
    if let Some(bad) = files.iter().find(|file| file.contains('\0')) {
        return Err(format!(
            "Path contains a NUL character: {}",
            bad.replace('\0', "\\0")
        ));
    }
    let cleaned: Vec<String> = files
        .iter()
        .filter(|file| !file.is_empty())
        .cloned()
        .collect();

    if cleaned.is_empty() {
        return Err("No files were selected.".to_string());
    }
    if let Some(bad) = cleaned.iter().find(|file| file.starts_with('-')) {
        return Err(format!("Invalid path: {bad}"));
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

    /// 테스트 프로세스 자신이 제어 터미널을 가졌는지. 없으면(CI, 파이프로 띄운 셸) 아래 단정이
    /// 실행기와 상관없이 성립해 아무것도 검증하지 못한다
    #[cfg(unix)]
    fn has_controlling_tty() -> bool {
        std::fs::File::open("/dev/tty").is_ok()
    }

    #[test]
    #[cfg(unix)] // 제어 터미널과 세션은 유닉스 개념이다
    fn 실행기로_띄운_자식은_제어_터미널이_없다() {
        if !has_controlling_tty() {
            eprintln!("테스트 프로세스에 제어 터미널이 없어 건너뛴다(`script -q /dev/null cargo test`로 돌린다)");
            return;
        }
        let outcome = execute(piped("sh", &["-c", "exec 3</dev/tty"]), LOCAL_TIMEOUT).unwrap();
        assert!(!outcome.timed_out, "{outcome:?}");
        assert_ne!(
            outcome.code,
            Some(0),
            "자식이 /dev/tty를 열었다: {outcome:?}"
        );
    }

    #[test]
    #[cfg(unix)] // pgid는 유닉스 개념이다
    fn 실행기로_띄운_자식은_자기_그룹의_리더다() {
        // kill_group은 자식 pid를 그룹 id로 쓴다. setsid로 바꿔도 이 전제가 유지돼야 한다
        let outcome = execute(
            piped("sh", &["-c", "echo $$; ps -o pgid= -p $$"]),
            LOCAL_TIMEOUT,
        )
        .unwrap();
        let numbers: Vec<&str> = outcome.stdout.split_whitespace().collect();
        assert_eq!(numbers.len(), 2, "{outcome:?}");
        assert_eq!(numbers[0], numbers[1], "{outcome:?}");
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
    fn 긴_출력은_머리와_꼬리를_남기고_가운데를_줄인다() {
        // checkout이 덮어쓸 파일 300개를 나열하는 꼴. 오류 문장은 첫 줄에 있다
        let mut long = String::from("error: Your local changes would be overwritten:\n");
        for i in 0..299 {
            long.push_str(&format!("\tf{i}\n"));
        }
        let kept = clip_output(&long);
        let lines: Vec<&str> = kept.lines().collect();

        assert_eq!(
            lines.len(),
            MAX_OUTPUT_LINES + 1,
            "생략 표시 한 줄이 더 붙는다"
        );
        assert_eq!(lines[0], "error: Your local changes would be overwritten:");
        assert_eq!(lines[19], "\tf18");
        assert_eq!(lines[20], "... (100 lines omitted) ...");
        assert_eq!(lines[21], "\tf119");
        assert_eq!(lines[MAX_OUTPUT_LINES], "\tf298");

        // 상한 이하는 손대지 않는다
        assert_eq!(clip_output("a\nb\n"), "a\nb\n");
    }

    #[test]
    fn 캐리지_리턴_진행_표시는_줄마다_마지막_것만_남긴다() {
        let raw = "Rebasing (2/3)\rRebasing (3/3)\rExecuting: make\nerror: boom\r\nReceiving objects:  50%\rReceiving objects: 100%, done.\r\r\n";
        assert_eq!(
            clip_output(raw),
            "Executing: make\nerror: boom\nReceiving objects: 100%, done.\n"
        );
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
            "fatal: unable to access 'https://github.com/x/y.git/': The requested URL returned error: 403",
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

    fn failed(stderr: &str) -> Outcome {
        Outcome {
            code: Some(128),
            stdout: String::new(),
            stderr: stderr.to_string(),
            timed_out: false,
        }
    }

    #[test]
    fn 로컬_명령의_permission_denied는_needs_auth가_아니다() {
        let stderr = "error: open(\"locked.txt\"): Permission denied\nerror: unable to index file 'locked.txt'";
        for args in [
            &["add", "--", "locked.txt"][..],
            &["checkout", "main"],
            &["commit", "-m", "x"],
        ] {
            let result = finish(&nowhere(), args, failed(stderr), LOCAL_TIMEOUT);
            assert!(!result.needs_auth, "{args:?}");
        }
        // 같은 문구라도 네트워크 명령이면 자격증명 문제다
        let ssh = "git@github.com: Permission denied (publickey).";
        for args in [&["push"][..], &["fetch", "--all"], &["pull", "--ff-only"]] {
            let result = finish(&nowhere(), args, failed(ssh), NETWORK_TIMEOUT);
            assert!(result.needs_auth, "{args:?}");
        }
    }

    /// 비밀번호가 걸린 키를 pinentry가 물을 TTY 없이 쓰면 이렇게 끝난다(감독 실측, 2026-10-07)
    const GPG_PASSPHRASE: &str = "error: gpg failed to sign the data:\n[GNUPG:] KEY_CONSIDERED 0123456789ABCDEF0123456789ABCDEF01234567 2\n[GNUPG:] BEGIN_SIGNING H10\n[GNUPG:] PINENTRY_LAUNCHED 4242 curses 1.2.1 - - - - 0/0 0\ngpg: signing failed: Inappropriate ioctl for device\n[GNUPG:] FAILURE sign 83918950\ngpg: signing failed: Inappropriate ioctl for device\n\nfatal: failed to write commit object";

    /// user.signingkey가 가리키는 비밀 키가 없다. 터미널에서도 똑같이 실패한다
    const GPG_NO_SECRET_KEY: &str = "error: gpg failed to sign the data:\n[GNUPG:] KEY_CONSIDERED 0123456789ABCDEF0123456789ABCDEF01234567 0\ngpg: skipped \"DEADBEEF\": No secret key\n[GNUPG:] INV_SGNR 9 DEADBEEF\n[GNUPG:] FAILURE sign 17\ngpg: signing failed: No secret key\n\nfatal: failed to write commit object";

    /// gpg.format=ssh, 비밀번호 걸린 키, TTY 없음(실측, git 2.50.1, OpenSSH 10.3p1)
    const SSH_PASSPHRASE: &str = "error: Enter passphrase for \"/k/key\": Load key \"/k/key\": incorrect passphrase supplied to decrypt private key?\n\nfatal: failed to write commit object";

    /// gpg.format=ssh인데 user.signingkey 파일이 없다(실측). 터미널에서도 실패한다
    const SSH_NO_KEY: &str = "error: Couldn't load public key /k/nope: No such file or directory?\n\nfatal: failed to write commit object";

    #[test]
    fn gpg_비밀번호_실패는_로컬_명령이어도_needs_auth다() {
        for args in [
            &["commit", "--gpg-sign", "-m", "x"][..],
            &["commit", "-m", "x"],
            &["merge", "--no-ff", "side"],
            &["tag", "-s", "v1", "-m", "v1"],
        ] {
            let result = finish(&nowhere(), args, failed(GPG_PASSPHRASE), LOCAL_TIMEOUT);
            assert!(result.needs_auth, "{args:?}");
            assert!(result.denied_account.is_none());
        }
    }

    #[test]
    fn gpg_비밀_키가_없으면_needs_auth가_아니다() {
        let args = ["commit", "--gpg-sign", "-m", "x"];
        let result = finish(&nowhere(), &args, failed(GPG_NO_SECRET_KEY), LOCAL_TIMEOUT);
        assert!(!result.needs_auth, "{result:?}");
    }

    #[test]
    fn gpg_상태_줄은_stderr에서_빠지고_사람이_읽을_줄은_남는다() {
        for raw in [GPG_PASSPHRASE, GPG_NO_SECRET_KEY] {
            let args = ["commit", "--gpg-sign", "-m", "x"];
            let result = finish(&nowhere(), &args, failed(raw), LOCAL_TIMEOUT);
            assert!(!result.stderr.contains("[GNUPG:]"), "{}", result.stderr);
            assert!(result.stderr.contains("gpg failed to sign the data"));
            assert!(result.stderr.contains("gpg: signing failed"));
            assert!(result
                .stderr
                .contains("fatal: failed to write commit object"));
        }
    }

    /// 비밀번호 걸린 ssh 키로 실제 서명을 시켜 git의 stderr를 받는다. ssh-keygen이 없으면 None.
    ///
    /// 우리 실행기(op_command + execute)로 돌린다. 실행기가 제어 터미널을 떼므로 테스트를 터미널에서
    /// 돌려도 ssh-keygen이 /dev/tty에서 비밀번호를 기다리지 않는다.
    /// ssh-agent가 키를 갖고 있으면 서명이 성공해 버리니 `SSH_AUTH_SOCK`을 비운다.
    #[cfg(unix)]
    fn ssh_signing_failure(args: &[&str], key_file: Option<&str>) -> Option<Outcome> {
        let probe = Command::new("ssh-keygen")
            .arg("-?")
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
        if probe.is_err() {
            eprintln!("ssh-keygen이 없어 ssh 서명 테스트를 건너뛴다");
            return None;
        }

        let repo = crate::testrepo::TempRepo::linear("gitlanes-ssh-sign", 1);
        let key = format!("{}/.git/signing-key", repo.path());
        let made = Command::new("ssh-keygen")
            .args([
                "-q",
                "-t",
                "ed25519",
                "-N",
                "secret-pass",
                "-C",
                "test",
                "-f",
            ])
            .arg(&key)
            .stdin(Stdio::null())
            .status()
            .expect("ssh-keygen 실행");
        assert!(made.success());
        repo.git(&["config", "gpg.format", "ssh"]);
        let signing_key = key_file.map_or(key.clone(), |name| format!("{}/{name}", repo.path()));
        repo.git(&["config", "user.signingkey", &signing_key]);
        repo.git(&["config", "commit.gpgsign", "true"]);
        repo.git(&["config", "tag.gpgsign", "true"]);

        let mut command = op_command(&repo.path(), args);
        command.env("SSH_AUTH_SOCK", "");
        let outcome = execute(command, LOCAL_TIMEOUT).expect("git 실행");
        assert!(!outcome.timed_out, "ssh-keygen이 비밀번호를 기다렸다");
        Some(outcome)
    }

    #[test]
    #[cfg(unix)] // setsid와 ssh-keygen 키 파일 권한(0600)이 유닉스 전제다
    fn ssh_서명_비밀번호_실패는_로컬_명령이어도_needs_auth다() {
        for args in [
            &["commit", "--allow-empty", "-m", "x"][..],
            &["tag", "-m", "v1", "v1"],
        ] {
            let Some(outcome) = ssh_signing_failure(args, None) else {
                return;
            };
            assert_ne!(outcome.code, Some(0), "{outcome:?}");
            assert!(
                outcome.stderr.contains(SSH_PASSPHRASE_MARKER),
                "실측 문구가 바뀌었다: {}",
                outcome.stderr
            );
            let result = finish(&nowhere(), args, outcome, LOCAL_TIMEOUT);
            assert!(result.needs_auth, "{args:?} {result:?}");
            assert!(!result.command.is_empty(), "{result:?}");
        }
    }

    #[test]
    #[cfg(unix)] // 위와 같은 픽스처
    fn ssh_서명_키_파일이_없으면_needs_auth가_아니다() {
        let args = ["commit", "--allow-empty", "-m", "x"];
        let Some(outcome) = ssh_signing_failure(&args, Some("missing-key")) else {
            return;
        };
        assert_ne!(outcome.code, Some(0), "{outcome:?}");
        let result = finish(&nowhere(), &args, outcome, LOCAL_TIMEOUT);
        assert!(!result.needs_auth, "{result:?}");
    }

    #[test]
    fn gpg_실패를_가르는_판정은_stderr만_본다() {
        assert!(looks_like_signing_prompt_failure(GPG_PASSPHRASE));
        assert!(!looks_like_signing_prompt_failure(GPG_NO_SECRET_KEY));
        assert!(looks_like_signing_prompt_failure(SSH_PASSPHRASE));
        assert!(!looks_like_signing_prompt_failure(SSH_NO_KEY));
        assert!(!looks_like_signing_prompt_failure(""));
        assert!(!looks_like_signing_prompt_failure(
            "error: Your local changes would be overwritten by merge."
        ));
    }

    const GITHUB_403: &str = "remote: Permission to nobel6018/gitlanes.git denied to younghoon-lee-ilevit-com.\nfatal: unable to access 'https://github.com/nobel6018/gitlanes.git/': The requested URL returned error: 403";

    #[test]
    fn https_403은_needs_auth다() {
        let result = finish(&nowhere(), &["push"], failed(GITHUB_403), NETWORK_TIMEOUT);
        assert!(result.needs_auth, "{result:?}");
        assert_eq!(
            result.denied_account.as_deref(),
            Some("younghoon-lee-ilevit-com")
        );
    }

    #[test]
    fn 거절된_계정은_로컬_명령과_성공에서는_뽑지_않는다() {
        let local = finish(
            &nowhere(),
            &["commit", "-m", "x"],
            failed(GITHUB_403),
            LOCAL_TIMEOUT,
        );
        assert_eq!(local.denied_account, None);
        let mut done = failed(GITHUB_403);
        done.code = Some(0);
        let ok = finish(&nowhere(), &["push"], done, NETWORK_TIMEOUT);
        assert_eq!(ok.denied_account, None);
        assert!(!ok.needs_auth);
    }

    #[test]
    fn 거절_문구에서_계정_이름을_뽑는다() {
        assert_eq!(
            parse_denied_account(GITHUB_403).as_deref(),
            Some("younghoon-lee-ilevit-com")
        );
        for (stderr, account) in [
            // SSH는 접두가 ERROR:다
            (
                "ERROR: Permission to nobel6018/gitlanes.git denied to nobel6018.\nfatal: Could not read from remote repository.",
                Some("nobel6018"),
            ),
            // GitHub App, Actions 토큰
            (
                "remote: Permission to o/r.git denied to github-actions[bot].",
                Some("github-actions[bot]"),
            ),
            // 진행 표시 뒤에 이어 붙어 와도 찾는다
            (
                "Enumerating objects: 3, done.\nremote: Permission to o/r.git denied to a.b_c.\r\n",
                Some("a.b_c"),
            ),
            // deploy key는 계정이 아니다
            ("ERROR: Permission to o/r.git denied to deploy key", None),
            // 계정이 없는 거절 문구들 (GitLab, Bitbucket)
            ("remote: You are not allowed to push code to this project.\nfatal: unable to access 'https://gitlab.com/o/r.git/': The requested URL returned error: 403", None),
            ("remote: Forbidden\nfatal: unable to access 'https://bitbucket.org/o/r.git/': The requested URL returned error: 403", None),
            ("remote: Permission to o/r.git denied to .", None),
            ("", None),
        ] {
            assert_eq!(parse_denied_account(stderr).as_deref(), account, "{stderr}");
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
        assert!(
            get("GIT_SSH_COMMAND")
                .flatten()
                .is_some_and(|command| command.ends_with(" -oBatchMode=yes")),
            "{:?}",
            get("GIT_SSH_COMMAND")
        );
        assert_eq!(get("GIT_ASKPASS"), Some(Some(String::new())));
        assert_eq!(get("SSH_ASKPASS"), Some(Some(String::new())));
        assert_eq!(get("LANG"), Some(Some("C".to_string())));
        assert_eq!(get("LC_ALL"), Some(Some("C".to_string())));
        // env_remove는 값이 None으로 실린다
        assert_eq!(get("GIT_DIR"), Some(None));
    }

    fn literal_env(args: &[&str]) -> Option<Option<String>> {
        op_command(".", args)
            .get_envs()
            .find(|(key, _)| *key == "GIT_LITERAL_PATHSPECS")
            .map(|(_, value)| value.map(|v| v.to_string_lossy().into_owned()))
    }

    #[test]
    fn 경로를_받는_명령에는_리터럴_pathspec이_걸린다() {
        for args in [
            &["add", "--", "a"][..],
            &["restore", "--worktree", "--", "a"],
            &["clean", "-q", "-fd", "--", "a"],
            &["checkout", "--ours", "--", "a"],
            &["stash", "push", "--", "a"],
            &["status"],
        ] {
            assert_eq!(literal_env(args), Some(Some("1".to_string())), "{args:?}");
        }
    }

    #[test]
    fn 훅을_돌리는_명령에는_리터럴_pathspec을_걸지_않는다() {
        // 걸면 훅 안의 `git diff -- '*.py'`가 리터럴이 돼서 린트가 조용히 빠진다
        for verb in HOOK_RUNNING_VERBS {
            assert_eq!(literal_env(&[verb]), None, "{verb}");
        }
    }

    #[test]
    fn 경로_없는_stash에는_리터럴_pathspec을_걸지_않는다() {
        // git stash가 내부에서 쓰는 `:/` magic이 리터럴이 되면 -u, --keep-index가 깨진다
        for args in [
            &["stash", "push", "--include-untracked"][..],
            &["stash", "push", "--keep-index", "--"],
            &["stash", "pop", "stash@{0}"],
        ] {
            assert_eq!(literal_env(args), None, "{args:?}");
        }
    }

    #[test]
    fn ref_이름_검증은_다른_브랜치로_풀리는_표기를_거절한다() {
        let repo = crate::testrepo::TempRepo::linear("gl-refname", 1);
        repo.git(&["branch", "prev"]);
        repo.git(&["checkout", "-q", "prev"]);
        repo.git(&["checkout", "-q", "main"]);
        repo.git(&["branch", "--set-upstream-to", "prev"]);
        let path = repo.path();

        // check-ref-format --branch는 @{-1}을 prev로, @{u}를 upstream으로 풀어 성공한다
        for name in ["@{-1}", "@{u}", "@{upstream}"] {
            assert!(validate_ref_name(&path, name).is_err(), "{name}");
        }
        assert_eq!(
            validate_ref_name(&path, " feature/x ").unwrap(),
            "feature/x"
        );
        assert_eq!(validate_ref_name(&path, "prev").unwrap(), "prev");
    }

    #[test]
    fn 경로_검증은_빈_목록과_옵션처럼_보이는_경로를_막는다() {
        assert!(validate_paths(&[]).is_err());
        assert!(validate_paths(&[String::new()]).is_err());
        assert!(validate_paths(&["--cached".to_string()]).is_err());
        assert!(validate_paths(&["a\0b".to_string()]).is_err());
        // 앞뒤 공백은 이름의 일부다. 빈 문자열만 버린다
        assert_eq!(
            validate_paths(&[" a.txt ".to_string(), String::new(), "b/c.txt".to_string()]).unwrap(),
            [" a.txt ", "b/c.txt"]
        );
    }
}

/// 타임아웃 뒤 프로세스 그룹 정리. 손자 프로세스가 파이프를 쥐는 경우를 재현한다.
///
/// 각 시나리오를 별도 스레드에서 돌리고 상한을 걸어 기다린다. 고치기 전 코드는 여기서
/// 영원히 반환하지 않아서, 상한이 없으면 테스트가 실패하는 대신 멈춘다.
#[cfg(all(test, unix))]
mod group_kill_tests {
    use super::*;
    use crate::testrepo::TempRepo;
    use std::sync::mpsc;

    fn within<T: Send + 'static>(limit: Duration, job: impl FnOnce() -> T + Send + 'static) -> T {
        let (sender, receiver) = mpsc::channel();
        std::thread::spawn(move || {
            let _ = sender.send(job());
        });
        receiver
            .recv_timeout(limit)
            .unwrap_or_else(|_| panic!("{limit:?} 안에 반환하지 않았다"))
    }

    /// 그룹에 살아 있는 프로세스가 없어질 때까지 잠깐 기다린다. 고아는 launchd/init이 거둔다.
    fn group_is_gone(pgid: i32) -> bool {
        let deadline = Instant::now() + Duration::from_secs(2);
        loop {
            // SAFETY: 시그널 0은 존재 확인만 한다. 아무 프로세스에도 영향이 없다.
            let alive = unsafe { libc::kill(-pgid, 0) } == 0;
            if !alive {
                return true;
            }
            if Instant::now() >= deadline {
                return false;
            }
            std::thread::sleep(POLL_INTERVAL);
        }
    }

    fn read_number(path: &std::path::Path) -> i32 {
        let deadline = Instant::now() + Duration::from_secs(2);
        loop {
            if let Ok(text) = std::fs::read_to_string(path) {
                if let Ok(number) = text.trim().parse() {
                    return number;
                }
            }
            assert!(Instant::now() < deadline, "{path:?}를 읽지 못했다");
            std::thread::sleep(POLL_INTERVAL);
        }
    }

    /// `sleep 30`을 자식으로 두고 기다리는 pre-commit 훅. sleep이 stdout/stderr 파이프를 상속한다.
    fn repo_with_sleeping_hook() -> (TempRepo, std::path::PathBuf) {
        let repo = TempRepo::linear("gl-group-hook", 1);
        let marks = std::path::PathBuf::from(repo.path()).join(".git");
        let hook = marks.join("hooks").join("pre-commit");
        std::fs::write(
            &hook,
            format!(
                "#!/bin/sh\nps -o pgid= -p $$ > '{dir}/hook.pgid'\nsleep 30 &\necho $! > '{dir}/hook.sleep'\nwait\n",
                dir = marks.display()
            ),
        )
        .unwrap();
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&hook, std::fs::Permissions::from_mode(0o755)).unwrap();
        repo.write("counter.txt", "changed\n");
        repo.git(&["add", "-A"]);
        (repo, marks)
    }

    #[test]
    fn 훅이_파이프를_쥐어도_타임아웃에_반환한다() {
        let (repo, _marks) = repo_with_sleeping_hook();
        let path = repo.path();
        let started = Instant::now();
        let result = within(Duration::from_secs(15), move || {
            run_op(&path, &["commit", "-m", "x"], Duration::from_secs(1)).unwrap()
        });

        assert!(
            started.elapsed() < Duration::from_secs(3),
            "타임아웃 1초인데 {:?} 걸렸다",
            started.elapsed()
        );
        assert!(!result.ok);
        assert!(result.stderr.contains("timed out"), "{result:?}");
    }

    #[test]
    fn 타임아웃_뒤_훅의_프로세스_그룹에_남은_프로세스가_없다() {
        let (repo, marks) = repo_with_sleeping_hook();
        let path = repo.path();
        let result = within(Duration::from_secs(15), move || {
            run_op(&path, &["commit", "-m", "x"], Duration::from_secs(1)).unwrap()
        });
        assert!(!result.ok);

        let pgid = read_number(&marks.join("hook.pgid"));
        let sleeper = read_number(&marks.join("hook.sleep"));
        // SAFETY: getpgrp는 인자가 없고 실패하지 않는다.
        let own = unsafe { libc::getpgrp() };
        assert_ne!(pgid, own, "git이 테스트 프로세스와 같은 그룹에서 돌았다");
        assert!(group_is_gone(pgid), "그룹 {pgid}에 프로세스가 남았다");
        // SAFETY: 시그널 0은 존재 확인만 한다.
        assert_ne!(
            unsafe { libc::kill(sleeper, 0) },
            0,
            "훅의 sleep이 살아 있다"
        );
    }

    #[test]
    fn 배너를_안_보내는_ssh_서버로_fetch해도_타임아웃에_반환한다() {
        // accept만 하고 아무것도 보내지 않는다. ssh는 서버 배너를 영원히 기다린다.
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        std::thread::spawn(move || {
            let mut held = Vec::new();
            for stream in listener.incoming().flatten() {
                held.push(stream);
            }
        });

        let repo = TempRepo::linear("gl-group-ssh", 1);
        let path = repo.path();
        let url = format!("ssh://git@127.0.0.1:{port}/x.git");
        let started = Instant::now();
        let result = within(Duration::from_secs(15), move || {
            run_op(&path, &["fetch", url.as_str()], Duration::from_secs(2)).unwrap()
        });

        assert!(
            started.elapsed() < Duration::from_secs(5),
            "타임아웃 2초인데 {:?} 걸렸다",
            started.elapsed()
        );
        assert!(!result.ok);
        assert!(result.stderr.contains("timed out"), "{result:?}");

        // ssh가 고아로 남지 않았다
        let pattern = format!("[-]p {port} ");
        let deadline = Instant::now() + Duration::from_secs(2);
        loop {
            let found = Command::new("pgrep")
                .args(["-f", pattern.as_str()])
                .output()
                .unwrap();
            if !found.status.success() {
                break;
            }
            assert!(
                Instant::now() < deadline,
                "ssh가 남아 있다: {}",
                String::from_utf8_lossy(&found.stdout)
            );
            std::thread::sleep(POLL_INTERVAL);
        }
    }
}

/// 인증 판정을 실제 git 출력으로 확인한다. 문구가 git 버전마다 흔들리므로 손으로 적은
/// 문자열만으로는 판정이 실물과 맞는지 알 수 없다.
#[cfg(all(test, unix))]
mod auth_tests {
    use super::*;
    use crate::testrepo::TempRepo;

    /// 모든 요청에 GitHub처럼 403 + text/plain 본문을 돌려주는 HTTP 서버. git은 본문을
    /// `remote: ` 접두로 stderr에 옮긴다.
    fn forbidding_server(message: &'static str) -> u16 {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        std::thread::spawn(move || {
            for mut stream in listener.incoming().flatten() {
                let mut request = [0u8; 8192];
                let _ = stream.read(&mut request);
                let response = format!(
                    "HTTP/1.1 403 Forbidden\r\nContent-Type: text/plain\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{message}",
                    message.len()
                );
                let _ = stream.write_all(response.as_bytes());
            }
        });
        port
    }

    #[test]
    fn https_403_fetch는_needs_auth와_거절된_계정을_싣는다() {
        let port = forbidding_server(
            "Permission to nobel6018/gitlanes.git denied to younghoon-lee-ilevit-com.\n",
        );
        let repo = TempRepo::linear("gl-auth-403", 1);
        let url = format!("http://127.0.0.1:{port}/nobel6018/gitlanes.git");

        let result = run_op(&repo.path(), &["fetch", url.as_str()], NETWORK_TIMEOUT).unwrap();
        assert!(!result.ok);
        assert!(result.stderr.contains("returned error: 403"), "{result:?}");
        assert!(result.needs_auth, "{result:?}");
        assert_eq!(
            result.denied_account.as_deref(),
            Some("younghoon-lee-ilevit-com")
        );
    }

    #[test]
    fn 읽을_수_없는_파일의_add_실패는_needs_auth가_아니다() {
        let repo = TempRepo::linear("gl-auth-chmod", 1);
        repo.write("locked.txt", "secret\n");
        let locked = std::path::Path::new(&repo.path()).join("locked.txt");
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o000)).unwrap();

        let result = run_op(&repo.path(), &["add", "--", "locked.txt"], LOCAL_TIMEOUT).unwrap();
        std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o644)).unwrap();

        assert!(!result.ok);
        assert!(
            result.stderr.to_lowercase().contains("permission denied"),
            "{result:?}"
        );
        assert!(!result.needs_auth, "{result:?}");
        assert_eq!(result.denied_account, None);
    }
}

/// 사용자가 고른 ssh 명령을 덮지 않는다(R-M3). 계정별 키를 `core.sshCommand`로 고르는
/// 사용자(GitHub 계정 여럿)는 덮이면 기본 키로 붙어 다른 계정으로 거절당한다.
#[cfg(all(test, unix))]
mod ssh_command_tests {
    use super::*;
    use crate::testrepo::TempRepo;

    /// 받은 인자를 파일에 남기고 실패하는 가짜 ssh.
    fn recording_ssh(repo: &TempRepo) -> (std::path::PathBuf, std::path::PathBuf) {
        let dir = std::path::PathBuf::from(repo.path()).join(".git");
        let script = dir.join("myssh.sh");
        let log = dir.join("myssh.log");
        std::fs::write(
            &script,
            format!("#!/bin/sh\necho \"$@\" > '{}'\nexit 255\n", log.display()),
        )
        .unwrap();
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
        (script, log)
    }

    #[test]
    fn ssh_명령은_git과_같은_순서로_고른다() {
        assert_eq!(batch_ssh_command(None, None, None), "ssh -oBatchMode=yes");
        assert_eq!(
            batch_ssh_command(None, Some("ssh -i ~/.ssh/work\n"), None),
            "ssh -i ~/.ssh/work -oBatchMode=yes"
        );
        // 환경변수가 설정보다, 설정이 GIT_SSH보다 우선
        assert_eq!(
            batch_ssh_command(Some("env-ssh"), Some("config-ssh"), Some("/bin/prog")),
            "env-ssh -oBatchMode=yes"
        );
        assert_eq!(
            batch_ssh_command(Some("  "), Some("config-ssh"), Some("/bin/prog")),
            "config-ssh -oBatchMode=yes"
        );
        assert_eq!(
            batch_ssh_command(None, None, Some("/Applications/My SSH/it's")),
            "'/Applications/My SSH/it'\\''s' -oBatchMode=yes"
        );
    }

    #[test]
    fn core_ssh_command를_쓰고_batch_mode를_덧붙인다() {
        if std::env::var_os("GIT_SSH_COMMAND").is_some() {
            // 호스트 환경변수가 core.sshCommand보다 우선이라 이 시나리오를 만들 수 없다
            return;
        }
        let repo = TempRepo::linear("gl-ssh-config", 1);
        let (script, log) = recording_ssh(&repo);
        let configured = format!("{} -i ~/.ssh/work_key", script.display());
        repo.git(&["config", "core.sshCommand", configured.as_str()]);

        let result = run_op(
            &repo.path(),
            &["fetch", "git@example.invalid:a/b.git"],
            Duration::from_secs(20),
        )
        .unwrap();
        assert!(!result.ok);

        let args = std::fs::read_to_string(&log)
            .unwrap_or_else(|_| panic!("core.sshCommand가 불리지 않았다: {result:?}"));
        // 셸을 거치므로 ~는 홈 경로로 풀린다
        assert!(args.contains("/.ssh/work_key -oBatchMode=yes"), "{args}");
        assert!(args.contains("example.invalid"), "{args}");
    }
}
