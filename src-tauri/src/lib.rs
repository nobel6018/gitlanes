//! GitLanes 백엔드. 시스템 git CLI를 파싱해 커밋 그래프를 만든다.
//!
//! @see CONTRACTS.md

mod commands;
mod dump;
mod git;
mod layout;
mod model;
mod parse;

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

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            commands::open_repo,
            commands::load_graph,
            commands::get_commit_details,
            commands::get_file_diff,
            commands::get_startup_repo,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
