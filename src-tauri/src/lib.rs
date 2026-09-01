//! GitLanes 백엔드. 시스템 git CLI를 파싱해 커밋 그래프를 만든다.
//!
//! @see CONTRACTS.md

mod commands;
mod dump;
mod git;
mod layout;
#[cfg(desktop)]
mod menu;
mod model;
mod parse;
mod remote;
mod search;
#[cfg(test)]
mod testrepo;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // `--dump`는 GUI를 띄우지 않는 디버그 경로다
    if let Some(request) = dump::from_args(std::env::args().skip(1)) {
        let result = request.and_then(|request| {
            let mut stdout = std::io::stdout().lock();
            dump::run(&request, &mut stdout)
        });
        if let Err(message) = result {
            eprintln!("{message}");
            std::process::exit(1);
        }
        return;
    }

    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init());

    // 기본 메뉴를 쓰면 macOS의 Close Window가 ⌘W를 선점해 탭 대신 창이 닫힌다
    #[cfg(desktop)]
    let builder = builder.menu(menu::build).on_menu_event(menu::handle);

    // 메뉴가 설치된 뒤에야 AppKit 쪽 보정이 가능하다
    #[cfg(target_os = "macos")]
    let builder = builder.setup(|_app| {
        menu::fix_shift_accelerators();
        Ok(())
    });

    builder
        .invoke_handler(tauri::generate_handler![
            commands::open_repo,
            commands::load_graph,
            commands::get_commit_details,
            commands::get_file_diff,
            commands::get_startup_repo,
            commands::list_refs,
            commands::search_commits,
            commands::get_repo_state,
            commands::get_remote_url,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
