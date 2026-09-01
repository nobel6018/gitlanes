//! 네이티브 앱 메뉴와 단축키.
//!
//! macOS 기본 메뉴는 Close Window가 ⌘W를 선점해서, 탭을 닫으려는 ⌘W가 창을 닫아버린다.
//! 기본 메뉴를 쓰지 않고 직접 구성해 Close Window를 ⌥⌘W로 옮기고 ⌘W를 Close Tab에 준다.
//! 복사/붙여넣기처럼 웹뷰 입력에 필요한 항목은 표준 PredefinedMenuItem으로 유지한다.
//!
//! File 메뉴와 탭 이동 항목은 동작을 rust 쪽에서 하지 않고 웹뷰로 이벤트만 브로드캐스트한다.
//! 탭 상태는 프론트가 들고 있어서 무엇을 닫고 무엇을 새로 열지는 프론트가 판단한다.
//! File 메뉴 이벤트는 payload가 없고, 탭 이동(`menu:goto-tab`)만 1~9 숫자를 함께 보낸다.
//!
//! @see CONTRACTS.md

#![cfg(desktop)]

#[cfg(target_os = "macos")]
use tauri::menu::AboutMetadata;
use tauri::menu::{IsMenuItem, Menu, MenuEvent, MenuItem, PredefinedMenuItem, Submenu};
use tauri::{AppHandle, Emitter, Manager, Runtime};

/// (메뉴 항목 id, 웹뷰로 emit할 이벤트 이름). payload는 없다.
const FILE_EVENTS: [(&str, &str); 4] = [
    ("file:new-tab", "menu:new-tab"),
    ("file:open-repo", "menu:open-repo"),
    ("file:close-tab", "menu:close-tab"),
    ("file:refresh", "menu:refresh"),
];

/// 창 닫기는 프론트로 넘기지 않고 여기서 처리한다.
const CLOSE_WINDOW_ID: &str = "window:close";

/// 탭 이동 항목의 id 접두사. 뒤에 1~9가 붙는다.
const TAB_ID_PREFIX: &str = "window:goto-tab:";

/// 탭 이동 이벤트. 다른 메뉴 이벤트와 달리 payload(1~9 숫자)가 붙는다.
const GOTO_TAB_EVENT: &str = "menu:goto-tab";

/// ⌘1~⌘9. 마지막 슬롯(9)은 번호가 아니라 "마지막 탭"이다.
const TAB_SLOTS: u8 = 9;

/// 앱 메뉴를 만든다. `--dump` 경로는 GUI를 띄우지 않으므로 여기까지 오지 않는다.
pub fn build<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Menu<R>> {
    let new_tab = MenuItem::with_id(app, "file:new-tab", "New Tab", true, Some("CmdOrCtrl+T"))?;
    let open_repo = MenuItem::with_id(
        app,
        "file:open-repo",
        "Open Repository…",
        true,
        Some("CmdOrCtrl+O"),
    )?;
    let close_tab = MenuItem::with_id(
        app,
        "file:close-tab",
        "Close Tab",
        true,
        Some("CmdOrCtrl+W"),
    )?;
    // PredefinedMenuItem::close_window는 단축키가 ⌘W로 고정이라 직접 만든다.
    // ⇧⌘W는 muda/AppKit 경로에서 실제 키 입력에 반응하지 않는 것을 실측으로 확인해서
    // Shift를 쓰지 않는 ⌥⌘W로 둔다. 자세한 내용은 fix_shift_accelerators 주석 참고.
    let close_window = MenuItem::with_id(
        app,
        CLOSE_WINDOW_ID,
        "Close Window",
        true,
        Some("Alt+CmdOrCtrl+W"),
    )?;
    let refresh = MenuItem::with_id(app, "file:refresh", "Refresh", true, Some("CmdOrCtrl+R"))?;

    let after_open = PredefinedMenuItem::separator(app)?;
    let before_refresh = PredefinedMenuItem::separator(app)?;

    #[cfg(target_os = "macos")]
    let file = Submenu::with_items(
        app,
        "File",
        true,
        &[
            &new_tab,
            &open_repo,
            &after_open,
            &close_tab,
            &close_window,
            &before_refresh,
            &refresh,
        ],
    )?;

    // macOS는 Quit이 애플리케이션 메뉴에 있고, 나머지 플랫폼은 File 끝에 둔다
    #[cfg(not(target_os = "macos"))]
    let file = {
        let before_quit = PredefinedMenuItem::separator(app)?;
        let quit = PredefinedMenuItem::quit(app, None)?;
        Submenu::with_items(
            app,
            "File",
            true,
            &[
                &new_tab,
                &open_repo,
                &after_open,
                &close_tab,
                &close_window,
                &before_refresh,
                &refresh,
                &before_quit,
                &quit,
            ],
        )?
    };

    // 웹뷰 입력창의 복사/붙여넣기가 죽지 않도록 표준 항목을 그대로 둔다
    let edit = Submenu::with_items(
        app,
        "Edit",
        true,
        &[
            &PredefinedMenuItem::undo(app, None)?,
            &PredefinedMenuItem::redo(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::cut(app, None)?,
            &PredefinedMenuItem::copy(app, None)?,
            &PredefinedMenuItem::paste(app, None)?,
            &PredefinedMenuItem::select_all(app, None)?,
        ],
    )?;

    // 브라우저 관례대로 ⌘1~⌘8은 그 번호 탭, ⌘9는 마지막 탭이다.
    // 숫자 키는 Shift를 쓰지 않아 fix_shift_accelerators의 대상이 아니다.
    // 탭이 실제로 있는지는 확인하지 않고 그냥 emit한다. 탭 상태는 프론트에 있고,
    // 활성/비활성을 맞추려면 탭이 바뀔 때마다 왕복이 필요해 값이 비싸다.
    let tabs: Vec<MenuItem<R>> = (1..=TAB_SLOTS)
        .map(|slot| {
            let label = if slot == TAB_SLOTS {
                "Last Tab".to_string()
            } else {
                format!("Tab {slot}")
            };
            MenuItem::with_id(
                app,
                format!("{TAB_ID_PREFIX}{slot}"),
                label,
                true,
                Some(format!("CmdOrCtrl+{slot}")),
            )
        })
        .collect::<tauri::Result<_>>()?;

    let minimize = PredefinedMenuItem::minimize(app, None)?;
    let zoom = PredefinedMenuItem::maximize(app, None)?;
    let before_tabs = PredefinedMenuItem::separator(app)?;

    let mut window_items: Vec<&dyn IsMenuItem<R>> = vec![&minimize, &zoom, &before_tabs];
    window_items.extend(tabs.iter().map(|item| item as &dyn IsMenuItem<R>));

    let window = Submenu::with_items(app, "Window", true, &window_items)?;

    #[cfg(target_os = "macos")]
    {
        // macOS는 첫 서브메뉴가 애플리케이션 메뉴다
        let app_menu = Submenu::with_items(
            app,
            "GitLanes",
            true,
            &[
                &PredefinedMenuItem::about(app, None, Some(AboutMetadata::default()))?,
                &PredefinedMenuItem::separator(app)?,
                &PredefinedMenuItem::services(app, None)?,
                &PredefinedMenuItem::separator(app)?,
                &PredefinedMenuItem::hide(app, None)?,
                &PredefinedMenuItem::hide_others(app, None)?,
                &PredefinedMenuItem::show_all(app, None)?,
                &PredefinedMenuItem::separator(app)?,
                &PredefinedMenuItem::quit(app, None)?,
            ],
        )?;
        Menu::with_items(app, &[&app_menu, &file, &edit, &window])
    }
    #[cfg(not(target_os = "macos"))]
    Menu::with_items(app, &[&file, &edit, &window])
}

/// 메뉴 이벤트를 처리한다. File 항목은 열려 있는 모든 웹뷰로 브로드캐스트한다.
pub fn handle<R: Runtime>(app: &AppHandle<R>, event: MenuEvent) {
    let id = event.id().as_ref();

    if id == CLOSE_WINDOW_ID {
        close_focused_window(app);
        return;
    }

    if let Some(slot) = id
        .strip_prefix(TAB_ID_PREFIX)
        .and_then(|slot| slot.parse::<u8>().ok())
    {
        if let Err(error) = app.emit(GOTO_TAB_EVENT, slot) {
            eprintln!("메뉴 이벤트 {GOTO_TAB_EVENT}을 보내지 못했습니다: {error}");
        }
        return;
    }

    if let Some((_, name)) = FILE_EVENTS.iter().find(|(item, _)| *item == id) {
        if let Err(error) = app.emit(name, ()) {
            eprintln!("메뉴 이벤트 {name}을 보내지 못했습니다: {error}");
        }
    }
}

/// muda가 Shift 조합에 넣는 소문자 keyEquivalent를 대문자로 고친다. macOS 전용.
///
/// muda는 `Shift+CmdOrCtrl+Z`를 keyEquivalent `"z"` + mask `Command|Shift`로 등록한다.
/// AppKit의 `performKeyEquivalent`는 Shift가 섞인 key equivalent를 대문자로 비교해서
/// 소문자로 등록된 항목은 매칭되지 않는다(NSMenu 직접 실험으로 확인). Tauri 공개 API는
/// accelerator를 문자열로만 받고 muda가 `Code::KeyZ`를 항상 소문자로 바꾸므로
/// Shift + 알파벳 조합은 이 보정 없이는 매칭 자체가 성립하지 않는다.
///
/// 메뉴 트리를 훑어 "Shift가 켜져 있고 keyEquivalent가 ASCII 소문자 한 글자"인 항목만
/// 대문자로 바꾼다. 특정 항목 제목에 의존하지 않아 항목이 늘어도 그대로 적용된다.
/// 표준 항목인 Redo(⇧⌘Z)가 이 버그로 죽어 있어서 그것까지 함께 살아난다.
///
/// # 한계
///
/// **이 보정만으로 Shift 조합 accelerator가 실제 키 입력에 반응한다고 보장되지 않는다.**
/// 보정 후 AppKit 상태는 의도대로 바뀌지만(CmdChar=W, CmdModifiers=Command|Shift),
/// 실물 키 입력(System Events keystroke, CGEvent hidSystemTap) 어느 쪽에도 반응하지
/// 않는 것을 확인했다. 같은 항목의 마우스 클릭은 정상이므로 muda/AppKit 경로에 아직
/// 규명되지 않은 변수가 남아 있다.
///
/// 그래서 **사용자 향 단축키에는 Shift 조합을 쓰지 않는다.** Close Window가 ⇧⌘W 대신
/// ⌥⌘W인 이유다. 이 함수는 표준 항목 복구와 앞으로의 안전망으로만 남긴다.
#[cfg(target_os = "macos")]
pub fn fix_shift_accelerators() {
    use objc2::MainThreadMarker;
    use objc2_app_kit::{NSApplication, NSEventModifierFlags, NSMenu};
    use objc2_foundation::NSString;

    fn walk(menu: &NSMenu) -> usize {
        let mut fixed = 0;
        for index in 0..menu.numberOfItems() {
            let Some(item) = menu.itemAtIndex(index) else {
                continue;
            };
            if let Some(submenu) = item.submenu() {
                fixed += walk(&submenu);
            }

            if !item
                .keyEquivalentModifierMask()
                .contains(NSEventModifierFlags::Shift)
            {
                continue;
            }
            let current = item.keyEquivalent().to_string();
            let mut chars = current.chars();
            let (Some(letter), None) = (chars.next(), chars.next()) else {
                continue;
            };
            if !letter.is_ascii_lowercase() {
                continue;
            }
            let upper = letter.to_ascii_uppercase().to_string();
            item.setKeyEquivalent(&NSString::from_str(&upper));
            fixed += 1;
        }
        fixed
    }

    let Some(mtm) = MainThreadMarker::new() else {
        eprintln!("메뉴 단축키 보정은 메인 스레드에서만 가능합니다");
        return;
    };
    let app = NSApplication::sharedApplication(mtm);
    match app.mainMenu() {
        Some(menu) => {
            walk(&menu);
        }
        None => eprintln!("앱 메뉴가 아직 설치되지 않아 단축키를 보정하지 못했습니다"),
    }
}

/// 포커스된 창을 닫는다. 판별에 실패하면 기본 창으로 떨어진다.
fn close_focused_window<R: Runtime>(app: &AppHandle<R>) {
    let target = app
        .webview_windows()
        .into_values()
        .find(|window| window.is_focused().unwrap_or(false))
        .or_else(|| app.get_webview_window("main"));

    if let Some(window) = target {
        if let Err(error) = window.close() {
            eprintln!("창을 닫지 못했습니다: {error}");
        }
    }
}
