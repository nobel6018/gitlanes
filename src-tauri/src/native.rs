//! 파일관리자/터미널 열기와 File > Open Recent 갱신 command 3개.
//!
//! 프로세스를 띄우는 두 command는 유닛 테스트로 검증할 수 없어서, 플랫폼별
//! 명령/인자 조립만 순수 함수([`reveal_candidates`], [`terminal_candidates`])로 떼어
//! 그 부분만 테스트한다. 실제 실행은 후보를 순서대로 spawn해 첫 성공을 취한다.
//! Windows의 `wt`처럼 설치돼 있지 않을 수 있는 것은 spawn 실패로 걸러 다음 후보로 넘어간다.
//!
//! @see CONTRACTS.md

use std::path::Path;
use std::process::Command;

/// File 메뉴의 Open Recent에 넣을 최대 항목 수.
pub const MAX_RECENT: usize = 10;

/// 실행 후보 하나. program은 PATH에서 찾고 args는 그대로 넘긴다.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Spawn {
    pub program: &'static str,
    pub args: Vec<String>,
}

impl Spawn {
    fn new<const N: usize>(program: &'static str, args: [&str; N]) -> Self {
        Self {
            program,
            args: args.iter().map(|arg| (*arg).to_string()).collect(),
        }
    }
}

/// 명령 조립이 갈리는 축. 테스트에서 현재 OS와 무관하게 세 갈래를 모두 검증하려고 둔다.
///
/// `current()`가 cfg로 한 갈래만 만들기 때문에, 어느 타깃으로 빌드해도 나머지 두 변형은
/// 라이브러리 코드에서 생성되지 않는다. 그래서 dead_code를 끈다.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[allow(dead_code)]
pub enum Platform {
    MacOs,
    Windows,
    Linux,
}

impl Platform {
    /// 빌드 대상 OS. macOS/Windows가 아니면 모두 Linux 취급이다.
    pub const fn current() -> Self {
        #[cfg(target_os = "macos")]
        {
            Platform::MacOs
        }
        #[cfg(target_os = "windows")]
        {
            Platform::Windows
        }
        #[cfg(not(any(target_os = "macos", target_os = "windows")))]
        {
            Platform::Linux
        }
    }
}

/// 파일관리자에서 항목을 선택된 상태로 보여주는 명령.
///
/// `target`은 보여줄 항목, `dir`은 그 항목을 담은 디렉토리다. Linux에는 항목 선택을
/// 표준으로 지원하는 수단이 없어 디렉토리만 연다.
pub fn reveal_candidates(target: &str, dir: &str, os: Platform) -> Vec<Spawn> {
    match os {
        Platform::MacOs => vec![Spawn::new("open", ["-R", target])],
        // explorer는 `/select,<path>`를 한 덩어리 인자로 받는다. 쉼표 뒤가 떨어지면 무시된다.
        Platform::Windows => vec![Spawn {
            program: "explorer",
            args: vec![format!("/select,{target}")],
        }],
        Platform::Linux => vec![Spawn::new("xdg-open", [dir])],
    }
}

/// 기본 터미널을 해당 디렉토리에서 여는 명령. 앞에서부터 시도한다.
pub fn terminal_candidates(dir: &str, os: Platform) -> Vec<Spawn> {
    match os {
        Platform::MacOs => vec![Spawn::new("open", ["-a", "Terminal", dir])],
        Platform::Windows => vec![
            Spawn::new("wt", ["-d", dir]),
            // Windows Terminal이 없는 환경(구형 Windows 10 이하)의 폴백
            Spawn::new("cmd", ["/c", "start", "cmd", "/K", "cd", "/d", dir]),
        ],
        Platform::Linux => {
            let working_dir = format!("--working-directory={dir}");
            vec![
                // 데비안 계열 alternatives 링크. 사용자가 고른 기본 터미널을 가리킨다.
                Spawn {
                    program: "x-terminal-emulator",
                    args: vec![working_dir.clone()],
                },
                Spawn {
                    program: "gnome-terminal",
                    args: vec![working_dir],
                },
                Spawn::new("konsole", ["--workdir", dir]),
            ]
        }
    }
}

/// Open Recent 항목 하나. 라벨은 경로의 마지막 디렉토리명이다.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RecentEntry {
    pub path: String,
    pub label: String,
}

/// 최근 목록을 메뉴에 넣을 형태로 정리한다. 공백 제거, 중복 제거, [`MAX_RECENT`] 상한.
///
/// 앞쪽이 최신이라고 보고 중복은 처음 나온 것만 남긴다.
pub fn recent_entries(paths: &[String]) -> Vec<RecentEntry> {
    let mut entries: Vec<RecentEntry> = Vec::new();

    for raw in paths {
        let path = raw.trim();
        if path.is_empty() {
            continue;
        }
        if entries.iter().any(|entry| entry.path == path) {
            continue;
        }
        entries.push(RecentEntry {
            path: path.to_string(),
            label: last_segment(path).to_string(),
        });
        if entries.len() == MAX_RECENT {
            break;
        }
    }

    entries
}

/// 경로의 마지막 구간. `Path::file_name`을 쓰지 않는 이유는 macOS에서 Windows 경로가
/// 통째로 한 구간으로 잡히기 때문이다(구분자가 플랫폼에 고정된다).
fn last_segment(path: &str) -> &str {
    path.trim_end_matches(['/', '\\'])
        .rsplit(['/', '\\'])
        .find(|segment| !segment.is_empty())
        .unwrap_or(path)
}

/// 파일관리자에서 항목을 보여준다.
#[tauri::command]
pub fn reveal_path(path: String) -> Result<(), String> {
    let target = validate_path(&path)?;
    let dir = enclosing_dir(&target);
    spawn_first(&reveal_candidates(&target, &dir, Platform::current()))
        .map_err(|reason| format!("파일관리자에서 열지 못했습니다: {reason}"))
}

/// 기본 터미널을 해당 디렉토리에서 연다. 파일 경로가 오면 그 파일이 든 디렉토리를 쓴다.
#[tauri::command]
pub fn open_in_terminal(path: String) -> Result<(), String> {
    let target = validate_path(&path)?;
    let dir = enclosing_dir(&target);
    spawn_first(&terminal_candidates(&dir, Platform::current()))
        .map_err(|reason| format!("터미널을 열지 못했습니다: {reason}"))
}

/// File > Open Recent 서브메뉴를 다시 만든다.
#[tauri::command]
pub fn set_recent_repos(app: tauri::AppHandle, paths: Vec<String>) -> Result<(), String> {
    let entries = recent_entries(&paths);

    #[cfg(desktop)]
    {
        crate::menu::apply_recent(&app, &entries)?;
    }
    #[cfg(not(desktop))]
    {
        let _ = (&app, &entries);
    }

    Ok(())
}

/// 경로를 검증한다. 빈 값과 옵션처럼 생긴 값(`-`로 시작)은 인자 주입이 되므로 막는다.
fn validate_path(path: &str) -> Result<String, String> {
    let path = path.trim();
    if path.is_empty() {
        return Err("경로가 비어 있습니다".to_string());
    }
    if path.starts_with('-') {
        return Err(format!("경로 형식이 올바르지 않습니다: {path}"));
    }
    if !Path::new(path).exists() {
        return Err(format!("경로를 찾을 수 없습니다: {path}"));
    }
    Ok(path.to_string())
}

/// 디렉토리면 자기 자신, 파일이면 부모 디렉토리.
fn enclosing_dir(target: &str) -> String {
    let path = Path::new(target);
    if path.is_dir() {
        return target.to_string();
    }
    path.parent()
        .map(|parent| parent.to_string_lossy().into_owned())
        .filter(|parent| !parent.is_empty())
        .unwrap_or_else(|| target.to_string())
}

/// 후보를 순서대로 spawn해 첫 성공에서 멈춘다.
///
/// 자식을 기다리지 않는다. 후보들은 모두 창을 띄우고 곧 끝나거나(open, xdg-open)
/// 앱이 사는 동안 계속 도는 터미널 프로세스라서 기다릴 것이 없다.
fn spawn_first(candidates: &[Spawn]) -> Result<(), String> {
    let mut last = "실행할 명령이 없습니다".to_string();

    for candidate in candidates {
        match Command::new(candidate.program)
            .args(&candidate.args)
            .spawn()
        {
            Ok(_) => return Ok(()),
            Err(error) => last = format!("{} 실행 실패({error})", candidate.program),
        }
    }

    Err(last)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn paths(values: &[&str]) -> Vec<String> {
        values.iter().map(|v| (*v).to_string()).collect()
    }

    #[test]
    fn 라벨은_경로의_마지막_디렉토리명이다() {
        let entries = recent_entries(&paths(&[
            "/Users/me/code/gitlanes",
            "/Users/me/code/other/",
            "C:\\src\\repo",
        ]));
        let labels: Vec<&str> = entries.iter().map(|e| e.label.as_str()).collect();
        assert_eq!(labels, ["gitlanes", "other", "repo"]);
    }

    #[test]
    fn 구간이_없는_경로는_경로_전체를_라벨로_쓴다() {
        let entries = recent_entries(&paths(&["/"]));
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].label, "/");
    }

    #[test]
    fn 중복은_처음_나온_것만_남긴다() {
        let entries = recent_entries(&paths(&["/a/repo", "/b/repo", "/a/repo", " /a/repo "]));
        let all: Vec<&str> = entries.iter().map(|e| e.path.as_str()).collect();
        assert_eq!(all, ["/a/repo", "/b/repo"]);
    }

    #[test]
    fn 공백만_있는_항목은_버린다() {
        let entries = recent_entries(&paths(&["", "   ", "/a/repo"]));
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].path, "/a/repo");
    }

    #[test]
    fn 최대_10개까지만_남긴다() {
        let many: Vec<String> = (0..25).map(|i| format!("/repo/{i}")).collect();
        let entries = recent_entries(&many);
        assert_eq!(entries.len(), MAX_RECENT);
        assert_eq!(entries[0].path, "/repo/0");
        assert_eq!(entries[MAX_RECENT - 1].path, "/repo/9");
    }

    #[test]
    fn macos_reveal은_open의_r_옵션을_쓴다() {
        let candidates = reveal_candidates("/a/b/c.txt", "/a/b", Platform::MacOs);
        assert_eq!(candidates.len(), 1);
        assert_eq!(candidates[0].program, "open");
        assert_eq!(candidates[0].args, ["-R", "/a/b/c.txt"]);
    }

    #[test]
    fn windows_reveal은_select를_한_인자로_붙인다() {
        let candidates = reveal_candidates("C:\\a\\b.txt", "C:\\a", Platform::Windows);
        assert_eq!(candidates[0].program, "explorer");
        assert_eq!(candidates[0].args, ["/select,C:\\a\\b.txt"]);
    }

    #[test]
    fn linux_reveal은_디렉토리를_연다() {
        let candidates = reveal_candidates("/a/b/c.txt", "/a/b", Platform::Linux);
        assert_eq!(candidates[0].program, "xdg-open");
        assert_eq!(candidates[0].args, ["/a/b"]);
    }

    #[test]
    fn macos_터미널은_terminal_앱을_연다() {
        let candidates = terminal_candidates("/a/b", Platform::MacOs);
        assert_eq!(candidates.len(), 1);
        assert_eq!(candidates[0].program, "open");
        assert_eq!(candidates[0].args, ["-a", "Terminal", "/a/b"]);
    }

    #[test]
    fn windows_터미널은_wt_다음에_cmd로_폴백한다() {
        let candidates = terminal_candidates("C:\\a", Platform::Windows);
        let programs: Vec<&str> = candidates.iter().map(|c| c.program).collect();
        assert_eq!(programs, ["wt", "cmd"]);
        assert_eq!(candidates[0].args, ["-d", "C:\\a"]);
        assert_eq!(
            candidates[1].args,
            ["/c", "start", "cmd", "/K", "cd", "/d", "C:\\a"]
        );
    }

    #[test]
    fn linux_터미널은_세_후보를_순서대로_시도한다() {
        let candidates = terminal_candidates("/a/b", Platform::Linux);
        let programs: Vec<&str> = candidates.iter().map(|c| c.program).collect();
        assert_eq!(
            programs,
            ["x-terminal-emulator", "gnome-terminal", "konsole"]
        );
        assert_eq!(candidates[0].args, ["--working-directory=/a/b"]);
        assert_eq!(candidates[2].args, ["--workdir", "/a/b"]);
    }

    #[test]
    fn 옵션처럼_생긴_경로와_빈_경로는_거부한다() {
        assert!(validate_path("   ").is_err());
        assert!(validate_path("-R").is_err());
        assert!(validate_path("/없는/경로/입니다").is_err());
    }

    #[test]
    fn 디렉토리는_자기_자신이_작업_디렉토리다() {
        assert_eq!(enclosing_dir("."), ".");
    }

    #[test]
    fn 없는_명령만_주면_실패_이유를_돌려준다() {
        let candidates = vec![Spawn::new("gitlanes-없는-명령", ["-x"])];
        assert!(spawn_first(&candidates).is_err());
    }
}
