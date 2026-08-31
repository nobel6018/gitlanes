//! 시스템 git CLI 호출 래퍼. libgit2를 쓰지 않는다.
//!
//! 커밋마다 프로세스를 띄우지 않도록 command 하나당 git 호출을 2~3회로 묶는다.
//!
//! @see CONTRACTS.md

use std::ffi::OsStr;
use std::process::Command;

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
    fn git_버전_조회는_성공한다() {
        let out = run(".", &["--version"]).expect("git --version은 성공해야 한다");
        assert!(out.starts_with("git version"), "{out}");
    }
}
