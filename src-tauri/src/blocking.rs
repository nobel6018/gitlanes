//! git 자식 프로세스를 기다리는 동안 tokio 워커를 내놓는다.
//!
//! `#[tauri::command(async)]`를 붙인 동기 command는 tauri 전역 tokio 런타임(멀티스레드,
//! 워커 수 = 코어 수)의 워커에서 그대로 돈다(tauri-macros `body_async` →
//! `async_runtime::spawn`). push 하나가 120초 동안 워커 하나를 붙잡고, 코어 4개 기기에서는
//! push 하나와 새로고침 읽기 서너 개로 워커가 다 찬다. 그러면 다른 IPC와 플러그인 작업이 줄을 선다.
//!
//! 그래서 command가 아니라 실제로 기다리는 실행기(`git::run_bytes`, `ops::run::execute` 등)
//! 안에서 [`wait`]로 감싼다. `block_in_place`는 이 워커의 스케줄러 코어를 다른 스레드에
//! 넘기고, 지금 스레드는 블로킹 스레드가 되어 기다린다.
//!
//! @see CONTRACTS.md

use tokio::runtime::{Handle, RuntimeFlavor};

/// `blocking`을 실행한다. 멀티스레드 tokio 워커 위라면 워커를 내놓은 채로 실행한다.
///
/// 런타임 밖(`#[test]`, `--dump`, 메인 스레드 command)에서는 그냥 부른다. tokio도
/// 이 경우 아무것도 하지 않지만(`EnterRuntime::NotEntered`), current_thread 런타임이나
/// `LocalSet` 안에서 부르면 panic하므로 그 경우를 먼저 걸러 그냥 부른다. 지금 코드에는
/// 그런 호출 경로가 없지만(tauri `async_runtime`은 멀티스레드), 플러그인이나 테스트가
/// 끌고 들어와도 앱이 죽지 않게 한다.
///
/// 중첩 호출은 안전하다. 이미 내놓은 상태면 tokio가 바로 실행한다.
pub fn wait<R>(blocking: impl FnOnce() -> R) -> R {
    match Handle::try_current() {
        Ok(handle) if handle.runtime_flavor() == RuntimeFlavor::MultiThread => {
            tokio::task::block_in_place(blocking)
        }
        _ => blocking(),
    }
}

#[cfg(all(test, unix))]
mod tests {
    use crate::testrepo::TempRepo;
    use std::process::{Command, Stdio};
    use std::time::{Duration, Instant};

    fn sleeping(seconds: &str) -> Command {
        let mut command = Command::new("sleep");
        command.arg(seconds);
        command.stdin(Stdio::null());
        command.stdout(Stdio::piped());
        command.stderr(Stdio::piped());
        command
    }

    #[test]
    fn current_thread_런타임_안에서도_panic하지_않는다() {
        // block_in_place를 그대로 부르면 여기서 panic한다
        let runtime = tokio::runtime::Builder::new_current_thread()
            .build()
            .unwrap();
        assert_eq!(runtime.block_on(async { super::wait(|| 7) }), 7);
    }

    /// 워커 2개 런타임에 2초짜리 실행기 호출을 4개(쓰기 실행기 2, 읽기 실행기 2) 띄운다.
    /// 워커를 붙잡으면 그 뒤의 짧은 async 작업이 2초 이상 기다린다.
    #[test]
    fn 느린_git_실행기가_tokio_워커를_붙잡지_않는다() {
        let repo = TempRepo::linear("gl-blocking", 1);
        repo.git(&["config", "alias.slow", "!sleep 2"]);

        let runtime = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .build()
            .unwrap();

        let mut slow = Vec::new();
        for _ in 0..2 {
            slow.push(runtime.spawn(async {
                crate::ops::run::execute(sleeping("2"), Duration::from_secs(10)).map(|_| ())
            }));
            let path = repo.path();
            slow.push(runtime.spawn(async move { crate::git::run(&path, &["slow"]).map(|_| ()) }));
        }
        // 느린 작업이 워커에 올라탈 시간
        std::thread::sleep(Duration::from_millis(300));

        let started = Instant::now();
        let quick = runtime.spawn(async move { started.elapsed() });
        let waited = runtime.block_on(quick).unwrap();
        assert!(
            waited < Duration::from_millis(500),
            "짧은 작업이 워커를 {waited:?} 기다렸다"
        );

        for task in slow {
            runtime.block_on(task).unwrap().unwrap();
        }
    }
}
