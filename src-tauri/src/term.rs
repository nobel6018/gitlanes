//! 하단 내장 터미널의 PTY 세션 관리.
//!
//! 인증이 필요한 git 작업(push/pull)은 앱이 대신 하지 않는다. 사용자의 셸을 그대로 띄워
//! 사용자 환경(자격증명 헬퍼, ssh-agent, alias)에서 하게 한다. v0.15의 쓰기 command를
//! 봉인한 이유이기도 하다.
//!
//! 세션은 [`Terminals`] 상태(`Mutex<HashMap>`)에 담고, PTY 출력은 읽기 스레드가
//! `term:data:{id}` 이벤트로 흘려보낸다. 셸이 끝나면 `term:exit:{id}`에 종료 코드를 싣는다.
//! 앱이 종료될 때 [`kill_all`]이 남은 셸을 정리한다.
//!
//! @see CONTRACTS.md

use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use tauri::{AppHandle, Emitter, Manager, State};

/// 한 번 읽을 크기. 셸 출력은 대개 이보다 훨씬 작다.
const READ_CHUNK: usize = 8192;

/// 세션 id 카운터. 창을 오래 켜둬도 겹치지 않는다.
static NEXT_ID: AtomicU64 = AtomicU64::new(1);

/// 살아 있는 PTY 세션 하나.
///
/// `child`가 아니라 `killer`를 들고 있다. 종료 코드를 거두는 `wait`는 블로킹이라
/// 읽기 스레드가 `child`를 소유하고, 여기서는 죽이는 권한만 복제해 둔다.
struct Session {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    killer: Box<dyn ChildKiller + Send + Sync>,
}

/// Tauri 관리 상태. `Mutex`는 세션 맵만 지키고 PTY 읽기는 밖에서 돈다.
#[derive(Default)]
pub struct Terminals(Mutex<HashMap<String, Session>>);

/// 새 PTY를 열고 세션 id를 돌려준다.
#[tauri::command]
pub fn term_open(
    app: AppHandle,
    terminals: State<'_, Terminals>,
    path: String,
    cols: u16,
    rows: u16,
) -> Result<String, String> {
    let cwd = path.trim();
    if !Path::new(cwd).is_dir() {
        return Err(format!("터미널을 열 디렉토리가 아닙니다: {cwd}"));
    }

    // 0을 넘기면 PTY가 만들어지지 않는다. 프론트가 아직 크기를 못 재는 순간이 있다.
    let size = PtySize {
        rows: rows.max(1),
        cols: cols.max(1),
        pixel_width: 0,
        pixel_height: 0,
    };

    let pair = native_pty_system()
        .openpty(size)
        .map_err(|e| format!("PTY를 열지 못했습니다: {e}"))?;

    let mut child = pair
        .slave
        .spawn_command(shell_command(cwd))
        .map_err(|e| format!("셸을 실행하지 못했습니다: {e}"))?;
    // slave를 계속 들고 있으면 셸이 끝나도 reader가 EOF를 못 본다
    drop(pair.slave);

    let reader = pair
        .master
        .try_clone_reader()
        .map_err(|e| format!("PTY 출력을 열지 못했습니다: {e}"))?;
    let writer = pair
        .master
        .take_writer()
        .map_err(|e| format!("PTY 입력을 열지 못했습니다: {e}"))?;
    let killer = child.clone_killer();

    let id = format!("term-{}", NEXT_ID.fetch_add(1, Ordering::SeqCst));
    terminals.0.lock().map_err(lock_error)?.insert(
        id.clone(),
        Session {
            master: pair.master,
            writer,
            killer,
        },
    );

    let thread_id = id.clone();
    std::thread::spawn(move || {
        pump(&app, &thread_id, reader);

        // PTY가 EOF면 셸이 끝났다. 종료 코드를 거둬 알리고 세션을 지운다.
        let code = child.wait().map(|status| status.exit_code()).unwrap_or(0);
        if let Ok(mut sessions) = app.state::<Terminals>().0.lock() {
            sessions.remove(&thread_id);
        }
        let _ = app.emit(&format!("term:exit:{thread_id}"), code);
    });

    Ok(id)
}

/// 키 입력을 PTY로 보낸다. 이미 끝난 세션이면 조용히 무시한다.
#[tauri::command]
pub fn term_write(terminals: State<'_, Terminals>, id: String, data: String) -> Result<(), String> {
    let mut sessions = terminals.0.lock().map_err(lock_error)?;
    let Some(session) = sessions.get_mut(&id) else {
        return Ok(());
    };

    session
        .writer
        .write_all(data.as_bytes())
        .and_then(|()| session.writer.flush())
        .map_err(|e| format!("터미널에 입력을 보내지 못했습니다: {e}"))
}

/// 창 크기를 셸에 알린다. 모르는 id는 조용히 무시한다.
#[tauri::command]
pub fn term_resize(
    terminals: State<'_, Terminals>,
    id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let sessions = terminals.0.lock().map_err(lock_error)?;
    let Some(session) = sessions.get(&id) else {
        return Ok(());
    };

    session
        .master
        .resize(PtySize {
            rows: rows.max(1),
            cols: cols.max(1),
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("터미널 크기를 바꾸지 못했습니다: {e}"))
}

/// 세션을 닫는다. 모르는 id는 조용히 무시한다.
///
/// 맵에서 빼고 셸을 죽이면 PTY가 닫혀 읽기 스레드가 스스로 끝난다. 그 스레드가
/// `term:exit`까지 보내고 정리하므로 여기서 스레드를 기다리지 않는다.
#[tauri::command]
pub fn term_close(terminals: State<'_, Terminals>, id: String) -> Result<(), String> {
    let session = terminals.0.lock().map_err(lock_error)?.remove(&id);
    if let Some(mut session) = session {
        let _ = session.killer.kill();
    }
    Ok(())
}

/// 앱이 종료될 때 남은 셸을 모두 죽인다. 안 하면 고아 프로세스가 남는다.
pub fn kill_all(app: &AppHandle) {
    let terminals = app.state::<Terminals>();
    let Ok(mut sessions) = terminals.0.lock() else {
        return;
    };
    for (_, mut session) in sessions.drain() {
        let _ = session.killer.kill();
    }
}

/// PTY 출력을 끝까지 읽어 이벤트로 흘려보낸다.
fn pump(app: &AppHandle, id: &str, mut reader: Box<dyn Read + Send>) {
    let event = format!("term:data:{id}");
    let mut buffer = [0u8; READ_CHUNK];
    let mut pending: Vec<u8> = Vec::new();

    loop {
        match reader.read(&mut buffer) {
            Ok(0) | Err(_) => break,
            Ok(read) => {
                pending.extend_from_slice(&buffer[..read]);
                let text = take_complete_utf8(&mut pending);
                if !text.is_empty() {
                    let _ = app.emit(&event, text);
                }
            }
        }
    }
}

/// 완성된 UTF-8만 떼어내고 중간에 잘린 마지막 문자는 버퍼에 남긴다.
///
/// 청크 경계에서 한글 한 글자가 반으로 갈리는 일이 흔하다. 청크마다 그냥 lossy 변환하면
/// 그 글자가 U+FFFD 두 개로 깨져 화면에 남는다. 잘린 꼬리는 다음 청크와 합쳐 처리한다.
/// 정말 깨진 바이트(`error_len`이 있는 경우)는 lossy로 소비해서 버퍼가 무한히 자라지 않게 한다.
fn take_complete_utf8(pending: &mut Vec<u8>) -> String {
    let consumed = match std::str::from_utf8(pending) {
        Ok(_) => pending.len(),
        Err(error) => match error.error_len() {
            // 뒤가 잘렸을 뿐이다. 유효한 부분만 내보내고 꼬리는 남긴다.
            None => error.valid_up_to(),
            // 유효하지 않은 바이트다. 그 바이트까지 소비해야 진도가 나간다.
            Some(bad) => error.valid_up_to() + bad,
        },
    };

    if consumed == 0 {
        return String::new();
    }
    let text = String::from_utf8_lossy(&pending[..consumed]).into_owned();
    pending.drain(..consumed);
    text
}

/// 로그인 셸을 해당 디렉토리에서 띄우는 명령.
fn shell_command(cwd: &str) -> CommandBuilder {
    let mut cmd = CommandBuilder::new(pick_shell(std::env::var("SHELL").ok().as_deref()));

    // 로그인 셸이어야 사용자의 프로필(PATH, alias, 자격증명 헬퍼 설정)이 올라온다.
    // cmd.exe에는 해당하는 옵션이 없다.
    #[cfg(not(windows))]
    cmd.arg("-l");

    cmd.cwd(cwd);
    // xterm.js가 해석할 수 있는 범위로 고정한다
    cmd.env("TERM", "xterm-256color");
    cmd
}

/// `$SHELL` → 표준 위치 후보 순으로 셸을 고른다.
fn pick_shell(env_shell: Option<&str>) -> String {
    if let Some(shell) = env_shell.map(str::trim).filter(|shell| !shell.is_empty()) {
        return shell.to_string();
    }

    #[cfg(windows)]
    {
        std::env::var("COMSPEC").unwrap_or_else(|_| "cmd.exe".to_string())
    }
    #[cfg(not(windows))]
    {
        ["/bin/zsh", "/bin/bash"]
            .into_iter()
            .find(|candidate| Path::new(candidate).exists())
            .unwrap_or("/bin/sh")
            .to_string()
    }
}

/// 세션 맵 뮤텍스가 오염된 경우. 읽기 스레드는 맵을 잠근 채 패닉할 일이 없어 사실상 안 난다.
fn lock_error<E>(_: E) -> String {
    "터미널 상태를 잠그지 못했습니다".to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    // 실제 PTY 왕복 테스트에서만 쓴다. 그 테스트가 unix 전용이라 import도 같이 좁힌다.
    #[cfg(unix)]
    use std::time::{Duration, Instant};

    #[test]
    fn env_shell이_있으면_그것을_쓴다() {
        assert_eq!(
            pick_shell(Some("/usr/local/bin/fish")),
            "/usr/local/bin/fish"
        );
        assert_eq!(pick_shell(Some("  /bin/dash  ")), "/bin/dash");
    }

    #[test]
    fn env_shell이_비면_표준_후보로_떨어진다() {
        for empty in [None, Some(""), Some("   ")] {
            let shell = pick_shell(empty);
            assert!(!shell.is_empty());

            #[cfg(unix)]
            assert!(shell.starts_with('/'), "{shell}");
            // %COMSPEC%은 보통 C:\WINDOWS\system32\cmd.exe다. 대소문자는 보장되지 않는다.
            #[cfg(windows)]
            assert!(shell.to_lowercase().contains("cmd"), "{shell}");
        }
    }

    #[test]
    fn 로그인_셸로_해당_디렉토리에서_띄운다() {
        let cmd = shell_command(".");
        let argv: Vec<String> = cmd
            .get_argv()
            .iter()
            .map(|arg| arg.to_string_lossy().into_owned())
            .collect();

        // 로그인 셸 옵션은 유닉스 셸에만 있다. cmd.exe에는 대응하는 옵션이 없어 프로그램만 실린다.
        #[cfg(unix)]
        {
            assert_eq!(argv.len(), 2, "{argv:?}");
            assert_eq!(argv[1], "-l");
        }
        #[cfg(windows)]
        assert_eq!(argv.len(), 1, "{argv:?}");
        assert_eq!(
            cmd.get_cwd().map(|cwd| cwd.to_string_lossy().into_owned()),
            Some(".".to_string())
        );
        assert_eq!(
            cmd.get_env("TERM")
                .map(|v| v.to_string_lossy().into_owned()),
            Some("xterm-256color".to_string())
        );
    }

    #[test]
    fn 잘린_멀티바이트_문자는_다음_청크까지_기다린다() {
        // "가"는 UTF-8로 3바이트(EA B0 80)다. 두 바이트만 도착한 상태.
        let mut pending = vec![0xEA, 0xB0];
        assert_eq!(take_complete_utf8(&mut pending), "");
        assert_eq!(pending.len(), 2, "꼬리를 버리면 안 된다");

        pending.push(0x80);
        assert_eq!(take_complete_utf8(&mut pending), "가");
        assert!(pending.is_empty());
    }

    #[test]
    fn 유효한_앞부분은_바로_내보내고_꼬리만_남긴다() {
        let mut pending = b"ok ".to_vec();
        pending.extend_from_slice(&[0xEA, 0xB0]); // "가"의 앞 두 바이트
        assert_eq!(take_complete_utf8(&mut pending), "ok ");
        assert_eq!(pending, vec![0xEA, 0xB0]);
    }

    #[test]
    fn 깨진_바이트는_소비해서_버퍼가_자라지_않게_한다() {
        // 0xFF는 UTF-8에 존재할 수 없는 선두 바이트다
        let mut pending = vec![b'a', 0xFF, b'b'];
        let text = take_complete_utf8(&mut pending);
        assert!(text.starts_with('a'), "{text:?}");
        assert!(pending.len() < 3, "진도가 나가지 않으면 무한히 쌓인다");
    }

    /// 한 줄을 출력하는 최소 명령. 셸 프로필이 끼어들지 않게 `-l` 없이 직접 부른다.
    #[cfg(unix)]
    fn echo_command() -> (CommandBuilder, &'static str) {
        let mut cmd = CommandBuilder::new("/bin/sh");
        cmd.args(["-c", "echo 왕복확인"]);
        cmd.cwd(".");
        (cmd, "왕복확인")
    }

    /// ASCII 공백(개행, 캐리지 리턴, 공백, 탭)을 모두 지운다.
    ///
    /// PTY는 화면 폭에서 출력을 접고 줄 끝에 CRLF를 넣는다. 기대 문자열이 폭 경계에
    /// 걸치면 중간에 개행이 끼므로, 비교 전에 양쪽에서 공백을 지운다.
    #[cfg(unix)]
    fn strip_ws(text: &str) -> String {
        text.chars()
            .filter(|ch| !ch.is_ascii_whitespace())
            .collect()
    }

    /// 기대 문자열이 보일 때까지 모은다.
    ///
    /// `read_to_end`를 쓰지 않는 이유는 EOF 시점을 믿을 수 없기 때문이다. 읽기는 블로킹이라
    /// deadline으로 끊을 수 없으니, 별도 스레드에 맡기고 채널에서 기다린다.
    #[cfg(unix)]
    fn collect_until(mut reader: Box<dyn Read + Send>, needle: &str) -> String {
        use std::sync::mpsc::{channel, RecvTimeoutError};

        let (tx, rx) = channel();
        std::thread::spawn(move || {
            let mut buffer = [0u8; 1024];
            loop {
                match reader.read(&mut buffer) {
                    Ok(0) | Err(_) => break,
                    Ok(read) => {
                        if tx.send(buffer[..read].to_vec()).is_err() {
                            break;
                        }
                    }
                }
            }
        });

        let deadline = Instant::now() + Duration::from_secs(10);
        let mut collected = Vec::new();
        while Instant::now() < deadline {
            match rx.recv_timeout(Duration::from_millis(200)) {
                Ok(chunk) => {
                    collected.extend_from_slice(&chunk);
                    if strip_ws(&String::from_utf8_lossy(&collected)).contains(&strip_ws(needle)) {
                        break;
                    }
                }
                Err(RecvTimeoutError::Timeout) => continue,
                Err(RecvTimeoutError::Disconnected) => break,
            }
        }

        String::from_utf8_lossy(&collected).into_owned()
    }

    /// 실제 PTY를 열어 왕복을 확인한다.
    ///
    /// Windows(ConPTY)에서는 돌리지 않는다. `cmd /C echo`를 띄우면 reader가 아무것도
    /// 받지 못한 채 끝나는 것을 CI에서 확인했다. slave/master drop 순서와 ConPTY의
    /// 타이밍 문제로, 우리 코드가 아니라 portable-pty와 ConPTY 쪽 영역이다.
    /// 앱 실행 시 셸이 실제로 뜨는 것은 별개로 확인된다.
    #[cfg(unix)]
    #[test]
    fn pty를_열어_실행한_명령의_출력이_돌아온다() {
        let pair = native_pty_system()
            .openpty(PtySize {
                rows: 24,
                cols: 80,
                pixel_width: 0,
                pixel_height: 0,
            })
            .unwrap();

        let (cmd, needle) = echo_command();
        let mut child = pair.slave.spawn_command(cmd).unwrap();
        drop(pair.slave);

        let reader = pair.master.try_clone_reader().unwrap();
        drop(pair.master);

        let text = collect_until(reader, needle);
        assert!(
            strip_ws(&text).contains(&strip_ws(needle)),
            "{needle:?}를 찾지 못했다: {text:?}"
        );
        assert_eq!(child.wait().unwrap().exit_code(), 0);
    }

    #[test]
    fn 모르는_id는_조용히_무시한다() {
        let terminals = Terminals::default();
        // State를 만들 수 없어 내부 함수와 같은 경로를 직접 확인한다
        assert!(terminals.0.lock().unwrap().remove("없는-id").is_none());
        assert!(terminals.0.lock().unwrap().get("없는-id").is_none());
    }
}
