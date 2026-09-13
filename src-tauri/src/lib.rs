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
mod native;
mod ops;
mod parse;
mod remote;
mod search;
mod term;
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
        .plugin(tauri_plugin_dialog::init())
        // 창 크기·위치를 저장했다가 다음 실행에 복원한다. tauri.conf.json의 width/height는
        // 저장된 상태가 없는 첫 실행에만 쓰인다.
        .plugin(tauri_plugin_window_state::Builder::default().build());

    // 기본 메뉴를 쓰면 macOS의 Close Window가 ⌘W를 선점해 탭 대신 창이 닫힌다.
    // 직접 구성한 메뉴에는 ⌘W accelerator가 없어서 그 키가 웹뷰로 내려간다.
    #[cfg(desktop)]
    let builder = builder.menu(menu::build).on_menu_event(menu::handle);

    // 메뉴가 설치된 뒤에야 AppKit 쪽 보정이 가능하다
    #[cfg(target_os = "macos")]
    let builder = builder.setup(|_app| {
        menu::fix_shift_accelerators();
        // accelerator가 실제로 어떻게 등록됐는지 확인하는 디버그 경로
        if std::env::var_os("GITLANES_DUMP_MENU").is_some() {
            menu::dump_menu();
        }
        Ok(())
    });

    // PTY 세션 맵. 창이 여러 개여도 하나를 공유한다.
    let builder = builder.manage(term::Terminals::default());

    // v0.18에서 쓰기 command 봉인을 풀었다. 읽기, 터미널, 쓰기가 한 목록이다.
    // 인증이 필요한 작업이 실패하면 OpResult.needsAuth가 켜지고, 프론트가 같은 명령을
    // 하단 PTY로 넘겨 사용자의 셸에서 다시 실행한다(ops 모듈 주석 참고).
    let builder = builder.invoke_handler(tauri::generate_handler![
        commands::open_repo,
        commands::load_graph,
        commands::get_commit_details,
        commands::get_file_diff,
        commands::get_file_content,
        commands::get_startup_repo,
        commands::list_refs,
        commands::search_commits,
        commands::get_repo_state,
        commands::get_remote_url,
        commands::get_wip_details,
        commands::get_wip_file_diff,
        commands::get_wip_file_content,
        native::reveal_path,
        native::open_in_terminal,
        native::set_recent_repos,
        term::term_open,
        term::term_write,
        term::term_resize,
        term::term_close,
        // 스테이징
        ops::stage::git_stage,
        ops::stage::git_unstage,
        ops::stage::git_discard,
        ops::stage::git_stage_all,
        ops::stage::git_unstage_all,
        ops::stage::git_apply_patch,
        ops::stage::git_clean,
        // 커밋
        ops::commit::git_commit,
        ops::commit::get_last_commit_message,
        ops::commit::get_commit_template,
        ops::commit::git_undo_commit,
        // 브랜치
        ops::branch::git_checkout,
        ops::branch::git_create_branch,
        ops::branch::git_delete_branch,
        ops::branch::git_rename_branch,
        ops::branch::git_set_upstream,
        // 네트워크
        ops::network::git_fetch,
        ops::network::git_pull,
        ops::network::git_push,
        // 히스토리
        ops::sync::get_sync_state,
        ops::history::git_merge,
        ops::history::git_rebase,
        ops::history::git_cherry_pick,
        ops::history::git_revert,
        ops::history::git_reset,
        ops::history::git_pending_action,
        ops::interactive::git_rebase_interactive,
        // 태그
        ops::tag::git_create_tag,
        ops::tag::git_delete_tag,
        ops::tag::git_push_tag,
        // 스태시
        ops::stash::git_stash_push,
        ops::stash::git_stash_apply,
        ops::stash::git_stash_drop,
        ops::stash::git_stash_branch,
        // remote
        ops::remote::list_remotes,
        ops::remote::git_add_remote,
        ops::remote::git_remove_remote,
        ops::remote::git_rename_remote,
        ops::remote::git_set_remote_url,
        // 충돌
        ops::conflict::get_conflicts,
        ops::conflict::git_resolve_with,
        ops::conflict::git_mark_resolved,
        ops::conflict::get_conflict_side,
        // 워크트리
        ops::worktree::list_worktrees,
        ops::worktree::git_add_worktree,
        ops::worktree::git_remove_worktree,
        // 패치
        ops::stage::git_create_patch,
        ops::stage::git_apply_patch_file,
    ]);

    // RunEvent를 받으려면 build + run으로 나눠야 한다. 앱이 닫힐 때 남은 셸을 죽인다.
    let app = builder
        .build(tauri::generate_context!())
        .expect("error while running tauri application");

    app.run(|handle, event| {
        if matches!(event, tauri::RunEvent::Exit) {
            term::kill_all(handle);
        }
    });
}
