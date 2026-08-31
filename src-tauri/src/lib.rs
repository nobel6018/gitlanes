//! GitLanes 백엔드. 시스템 git CLI를 파싱해 커밋 그래프를 만든다.
//!
//! @see CONTRACTS.md

mod commands;
mod git;
mod layout;
mod model;
mod parse;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            commands::open_repo,
            commands::load_graph,
            commands::get_commit_details,
            commands::get_file_diff,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
