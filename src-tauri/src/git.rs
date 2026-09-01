//! 시스템 git CLI 호출 래퍼. libgit2를 쓰지 않는다.
//!
//! 커밋마다 프로세스를 띄우지 않도록 command 하나당 git 호출을 2~3회로 묶는다.
//!
//! @see CONTRACTS.md

use std::ffi::OsStr;
use std::io::{BufRead, BufReader, Read};
use std::process::{Command, Stdio};

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
    cmd
}

/// git을 실행해 stdout을 문자열로 돌려준다. 실패하면 stderr를 담은 오류 메시지를 만든다.
pub fn run<P, S>(repo: P, args: &[S]) -> Result<String, String>
where
    P: AsRef<OsStr>,
    S: AsRef<OsStr>,
{
    let output = base_command(repo)
        .args(args)
        .output()
        .map_err(|e| format!("git 실행에 실패했습니다. git이 설치되어 있는지 확인하세요: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        if stderr.is_empty() {
            return Err("git 명령이 실패했습니다".to_string());
        }
        return Err(stderr);
    }

    // git 출력은 커밋 메시지나 diff 본문이 임의 인코딩일 수 있어 lossy 변환을 쓴다.
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
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
    mut on_record: F,
) -> Result<(), String>
where
    P: AsRef<OsStr>,
    S: AsRef<OsStr>,
    F: FnMut(&str) -> Flow,
{
    let mut child = base_command(repo)
        .args(args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("git 실행에 실패했습니다. git이 설치되어 있는지 확인하세요: {e}"))?;

    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "git 출력을 열지 못했습니다".to_string())?;
    let mut reader = BufReader::new(stdout);
    let mut record = Vec::new();
    let mut stopped_early = false;

    loop {
        record.clear();
        let read = reader
            .read_until(separator, &mut record)
            .map_err(|e| format!("git 출력을 읽지 못했습니다: {e}"))?;
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

    if stopped_early {
        // 파이프를 닫으면 대개 SIGPIPE로 끝나지만, 확실히 정리하고 회수한다
        let _ = child.kill();
        let _ = child.wait();
        return Ok(());
    }

    // stdout을 EOF까지 읽은 뒤라 stderr를 마저 읽어도 막히지 않는다
    let mut errors = String::new();
    if let Some(mut stderr) = child.stderr.take() {
        let _ = stderr.read_to_string(&mut errors);
    }
    let status = child
        .wait()
        .map_err(|e| format!("git 종료를 기다리지 못했습니다: {e}"))?;

    if !status.success() {
        let errors = errors.trim();
        return Err(if errors.is_empty() {
            "git 명령이 실패했습니다".to_string()
        } else {
            errors.to_string()
        });
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
}

#[cfg(test)]
mod tests {
    use super::*;

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
        let results = run_all(
            ".",
            &[
                &["--version"] as &[&str],
                &["rev-parse", "--is-inside-work-tree"],
                &["--version"],
            ],
        );
        assert_eq!(results.len(), 3);
        assert!(results[0].as_ref().unwrap().starts_with("git version"));
        assert!(results[2].as_ref().unwrap().starts_with("git version"));
    }

    #[test]
    fn run_all은_실패한_호출만_오류로_남긴다() {
        let results = run_all(
            ".",
            &[&["--version"] as &[&str], &["definitely-not-a-git-command"]],
        );
        assert!(results[0].is_ok());
        assert!(results[1].is_err());
    }

    #[test]
    fn stream_records는_레코드마다_콜백을_부른다() {
        let mut lines = Vec::new();
        stream_records(
            ".",
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
    }

    #[test]
    fn stream_records는_조기_중단해도_오류가_아니다() {
        // 남은 출력을 버리고 프로세스를 정리하므로 SIGPIPE가 오류로 새어나오면 안 된다.
        // 반복해서 돌려 좀비나 파일 디스크립터가 쌓이지 않는지도 함께 본다
        for _ in 0..20 {
            let mut seen = 0usize;
            stream_records(".", &["log", "--all", "--format=%H%x1e"], 0x1e, |_record| {
                seen += 1;
                if seen >= 2 {
                    Flow::Stop
                } else {
                    Flow::Continue
                }
            })
            .expect("조기 중단은 성공이다");
            assert_eq!(seen, 2, "Stop 이후로는 콜백을 부르지 않는다");
        }
    }

    #[test]
    fn stream_records는_실패한_명령의_stderr를_전달한다() {
        let err = stream_records(".", &["log", "--nope-not-an-option"], 0x1e, |_| {
            Flow::Continue
        })
        .unwrap_err();
        assert!(!err.is_empty());
        assert!(!err.contains("성공"), "{err}");
    }

    #[test]
    fn git_버전_조회는_성공한다() {
        let out = run(".", &["--version"]).expect("git --version은 성공해야 한다");
        assert!(out.starts_with("git version"), "{out}");
    }
}
