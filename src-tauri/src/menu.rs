//! 네이티브 앱 메뉴와 단축키.
//!
//! macOS 기본 메뉴는 Close Window가 ⌘W를 선점해서, 탭을 닫으려는 ⌘W가 창을 닫아버린다.
//! 기본 메뉴를 쓰지 않고 직접 구성해 ⌘W를 Close Tab에 주고, Close Window는 단축키 없이
//! 메뉴 클릭으로만 쓴다.
//! 복사/붙여넣기처럼 웹뷰 입력에 필요한 항목은 표준 PredefinedMenuItem으로 유지한다.
//!
//! File 메뉴와 탭 이동 항목은 동작을 rust 쪽에서 하지 않고 웹뷰로 이벤트만 브로드캐스트한다.
//! 탭 상태는 프론트가 들고 있어서 무엇을 닫고 무엇을 새로 열지는 프론트가 판단한다.
//! payload가 붙는 것은 탭 번호 이동(`menu:goto-tab`, 1~9)과 최근 항목 클릭
//! (`menu:open-recent`, 경로 문자열) 둘뿐이고 나머지는 없다.
//!
//! 구성은 macOS에서 App/File/Edit/View/Window/Help, 나머지 플랫폼에서 App 메뉴를 뺀 것이다.
//! File > Open Recent는 빈 서브메뉴로 만들어 두고 [`apply_recent`]가 나중에 채운다.
//! View/Help의 accelerator는 전부 Shift 없는 조합이다([`fix_shift_accelerators`]의 한계 참고).
//!
//! @see CONTRACTS.md

#![cfg(desktop)]

#[cfg(target_os = "macos")]
use tauri::menu::AboutMetadata;
use tauri::menu::{
    IsMenuItem, Menu, MenuEvent, MenuItem, MenuItemKind, PredefinedMenuItem, Submenu,
};
use tauri::{AppHandle, Emitter, Manager, Runtime};

use crate::native::RecentEntry;

/// (메뉴 항목 id, 웹뷰로 emit할 이벤트 이름). payload는 없다.
const FILE_EVENTS: [(&str, &str); 5] = [
    ("file:new-tab", "menu:new-tab"),
    ("file:open-repo", "menu:open-repo"),
    ("file:close-tab", "menu:close-tab"),
    ("file:refresh", "menu:refresh"),
    (CLEAR_RECENT_ID, "menu:clear-recent"),
];

/// View 메뉴 항목. payload는 없다.
const VIEW_EVENTS: [(&str, &str); 4] = [
    ("view:toggle-sidebar", "menu:toggle-sidebar"),
    ("view:zoom-in", "menu:zoom-in"),
    ("view:zoom-out", "menu:zoom-out"),
    ("view:zoom-reset", "menu:zoom-reset"),
];

/// Help 메뉴 항목. payload는 없다.
const HELP_EVENTS: [(&str, &str); 1] = [("help:shortcuts", "menu:shortcuts")];

/// 업데이트 확인. macOS에서는 App 메뉴의 About 아래, 나머지 플랫폼에서는 Help 끝에 붙는다.
/// 어느 쪽이든 id와 이벤트는 같다. payload와 accelerator는 없다.
const CHECK_UPDATES: (&str, &str) = ("app:check-updates", "menu:check-updates");

/// `set_recent_repos`가 다시 찾아야 하는 두 메뉴의 id.
const FILE_MENU_ID: &str = "file";
const RECENT_MENU_ID: &str = "file:open-recent";

/// 최근 항목 id 접두사. 뒤에 경로가 그대로 붙는다.
///
/// 경로를 인덱스로 바꿔 상태에 따로 보관하지 않는다. 클릭 시점에 id에서 경로를 바로 읽으면
/// 메뉴와 상태가 갈라질 여지가 없다.
const RECENT_ITEM_PREFIX: &str = "file:recent:";

/// 최근 목록이 비었을 때 넣는 비활성 안내 항목. 접두사를 피해 클릭 경로와 겹치지 않게 한다.
const RECENT_EMPTY_ID: &str = "file:recent-empty";

/// 목록 비우기. `RECENT_ITEM_PREFIX`로 시작하지 않아 경로 항목과 구분된다.
const CLEAR_RECENT_ID: &str = "file:clear-recent";

/// 최근 항목 클릭 이벤트. 다른 File 이벤트와 달리 payload(경로 String)가 붙는다.
const OPEN_RECENT_EVENT: &str = "menu:open-recent";

/// 창 닫기는 프론트로 넘기지 않고 여기서 처리한다.
const CLOSE_WINDOW_ID: &str = "window:close";

/// 탭 이동 항목의 id 접두사. 뒤에 1~9가 붙는다.
const TAB_ID_PREFIX: &str = "window:goto-tab:";

/// 탭 이동 이벤트. 다른 메뉴 이벤트와 달리 payload(1~9 숫자)가 붙는다.
const GOTO_TAB_EVENT: &str = "menu:goto-tab";

/// 탭 순환 항목. (메뉴 항목 id, emit할 이벤트 이름). payload는 없다.
const TAB_CYCLE_EVENTS: [(&str, &str); 2] = [
    ("window:prev-tab", "menu:prev-tab"),
    ("window:next-tab", "menu:next-tab"),
];

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
    // 단축키 없이 클릭으로만 창을 닫는다. ⌘W는 Close Tab이 쓰고, 대안이던 ⇧⌘W는
    // muda/AppKit 경로에서 실제 키 입력에 반응하지 않는다(fix_shift_accelerators 주석 참고).
    // 남은 조합을 억지로 붙이는 대신 accelerator를 두지 않는다.
    let close_window = MenuItem::with_id(app, CLOSE_WINDOW_ID, "Close Window", true, None::<&str>)?;
    let refresh = MenuItem::with_id(app, "file:refresh", "Refresh", true, Some("CmdOrCtrl+R"))?;

    // 내용은 프론트가 최근 목록을 알려줄 때 set_recent_repos가 채운다. 처음에는 안내 항목만 둔다.
    let open_recent = Submenu::with_id_and_items(
        app,
        RECENT_MENU_ID,
        "Open Recent",
        true,
        &recent_items(app, &[])?
            .iter()
            .map(|item| item.as_ref())
            .collect::<Vec<_>>(),
    )?;

    let after_open = PredefinedMenuItem::separator(app)?;
    let before_refresh = PredefinedMenuItem::separator(app)?;

    #[cfg(target_os = "macos")]
    let file = Submenu::with_id_and_items(
        app,
        FILE_MENU_ID,
        "File",
        true,
        &[
            &new_tab,
            &open_repo,
            &open_recent,
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
        Submenu::with_id_and_items(
            app,
            FILE_MENU_ID,
            "File",
            true,
            &[
                &new_tab,
                &open_repo,
                &open_recent,
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

    // 전부 Shift 없는 조합이다. `=`/`-`/`/`는 muda가 Code::Equal/Minus/Slash로 파싱해
    // macOS keyEquivalent를 각각 "=", "-", "/"로 등록한다(NSMenu 덤프로 확인).
    // ⌘0은 Window 메뉴의 탭 이동(⌘1~⌘9)과 겹치지 않는다.
    let toggle_sidebar = MenuItem::with_id(
        app,
        VIEW_EVENTS[0].0,
        "Toggle Sidebar",
        true,
        Some("CmdOrCtrl+B"),
    )?;
    let zoom_in = MenuItem::with_id(app, VIEW_EVENTS[1].0, "Zoom In", true, Some("CmdOrCtrl+="))?;
    let zoom_out = MenuItem::with_id(app, VIEW_EVENTS[2].0, "Zoom Out", true, Some("CmdOrCtrl+-"))?;
    let zoom_reset = MenuItem::with_id(
        app,
        VIEW_EVENTS[3].0,
        "Actual Size",
        true,
        Some("CmdOrCtrl+0"),
    )?;

    let view = Submenu::with_items(
        app,
        "View",
        true,
        &[
            &toggle_sidebar,
            &PredefinedMenuItem::separator(app)?,
            &zoom_in,
            &zoom_out,
            &zoom_reset,
        ],
    )?;

    let shortcuts = MenuItem::with_id(
        app,
        HELP_EVENTS[0].0,
        "Keyboard Shortcuts",
        true,
        Some("CmdOrCtrl+/"),
    )?;
    // macOS는 이 항목을 App 메뉴의 About 아래에 두는 것이 관례라 Help에는 넣지 않는다
    #[cfg(target_os = "macos")]
    let help = Submenu::with_items(app, "Help", true, &[&shortcuts])?;

    #[cfg(not(target_os = "macos"))]
    let help = {
        let check_updates = MenuItem::with_id(
            app,
            CHECK_UPDATES.0,
            "Check for Updates…",
            true,
            None::<&str>,
        )?;
        Submenu::with_items(
            app,
            "Help",
            true,
            &[
                &shortcuts,
                &PredefinedMenuItem::separator(app)?,
                &check_updates,
            ],
        )?
    };

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

    // 브라우저 관례는 ⇧⌘[ / ⇧⌘]인데 muda가 keyEquivalent를 "["/"]"로 등록하고 AppKit은
    // Shift가 적용된 "{"/"}"와 비교해서 매칭되지 않는다(NSMenu 직접 실험으로 확인).
    // fix_shift_accelerators는 알파벳만 고치므로 이 항목도 구제하지 못한다.
    // Safari의 대체 조합인 ⌥⌘←/→로 둔다. Shift를 쓰지 않아 매칭이 성립한다.
    let prev_tab = MenuItem::with_id(
        app,
        TAB_CYCLE_EVENTS[0].0,
        "Previous Tab",
        true,
        Some("Alt+CmdOrCtrl+Left"),
    )?;
    let next_tab = MenuItem::with_id(
        app,
        TAB_CYCLE_EVENTS[1].0,
        "Next Tab",
        true,
        Some("Alt+CmdOrCtrl+Right"),
    )?;

    let minimize = PredefinedMenuItem::minimize(app, None)?;
    let zoom = PredefinedMenuItem::maximize(app, None)?;
    let before_cycle = PredefinedMenuItem::separator(app)?;
    let before_tabs = PredefinedMenuItem::separator(app)?;

    let mut window_items: Vec<&dyn IsMenuItem<R>> = vec![
        &minimize,
        &zoom,
        &before_cycle,
        &prev_tab,
        &next_tab,
        &before_tabs,
    ];
    window_items.extend(tabs.iter().map(|item| item as &dyn IsMenuItem<R>));

    let window = Submenu::with_items(app, "Window", true, &window_items)?;

    #[cfg(target_os = "macos")]
    {
        // macOS는 첫 서브메뉴가 애플리케이션 메뉴다
        let check_updates = MenuItem::with_id(
            app,
            CHECK_UPDATES.0,
            "Check for Updates…",
            true,
            None::<&str>,
        )?;
        let app_menu = Submenu::with_items(
            app,
            "GitLanes",
            true,
            &[
                &PredefinedMenuItem::about(app, None, Some(AboutMetadata::default()))?,
                &PredefinedMenuItem::separator(app)?,
                &check_updates,
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
        Menu::with_items(app, &[&app_menu, &file, &edit, &view, &window, &help])
    }
    #[cfg(not(target_os = "macos"))]
    Menu::with_items(app, &[&file, &edit, &view, &window, &help])
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

    // "file:clear-recent"는 이 접두사로 시작하지 않아 아래 payloadless 쪽에서 처리된다
    if let Some(path) = id.strip_prefix(RECENT_ITEM_PREFIX) {
        if let Err(error) = app.emit(OPEN_RECENT_EVENT, path) {
            eprintln!("메뉴 이벤트 {OPEN_RECENT_EVENT}을 보내지 못했습니다: {error}");
        }
        return;
    }

    let payloadless = FILE_EVENTS
        .iter()
        .chain(TAB_CYCLE_EVENTS.iter())
        .chain(VIEW_EVENTS.iter())
        .chain(HELP_EVENTS.iter())
        .chain(std::iter::once(&CHECK_UPDATES))
        .find(|(item, _)| *item == id);

    if let Some((_, name)) = payloadless {
        if let Err(error) = app.emit(name, ()) {
            eprintln!("메뉴 이벤트 {name}을 보내지 못했습니다: {error}");
        }
    }
}

/// File > Open Recent 서브메뉴를 통째로 다시 만든다.
///
/// 메뉴 전체를 재설정(`set_as_app_menu`)하지 않고 이 서브메뉴만 비우고 다시 채운다.
/// 전체 재설정은 accelerator를 다시 등록하면서 `fix_shift_accelerators` 보정이 날아가고,
/// macOS에서 메뉴바가 한 번 깜빡인다. 항목 교체는 그런 부작용이 없다.
pub fn apply_recent<R: Runtime>(app: &AppHandle<R>, entries: &[RecentEntry]) -> Result<(), String> {
    let menu = app.menu().ok_or("앱 메뉴가 아직 설치되지 않았습니다")?;
    let file = submenu(menu.get(FILE_MENU_ID)).ok_or("File 메뉴를 찾지 못했습니다")?;
    let recent = submenu(file.get(RECENT_MENU_ID)).ok_or("Open Recent 메뉴를 찾지 못했습니다")?;

    // remove_at(0)을 항목 수만큼 반복한다. 빈 서브메뉴에 계속 호출하는 것을 피하려고
    // 먼저 개수를 읽는다.
    let count = recent
        .items()
        .map_err(|error| format!("Open Recent 항목을 읽지 못했습니다: {error}"))?
        .len();
    for _ in 0..count {
        recent
            .remove_at(0)
            .map_err(|error| format!("Open Recent 항목을 지우지 못했습니다: {error}"))?;
    }

    let items = recent_items(app, entries)
        .map_err(|error| format!("Open Recent 항목을 만들지 못했습니다: {error}"))?;
    let refs: Vec<&dyn IsMenuItem<R>> = items.iter().map(|item| item.as_ref()).collect();
    recent
        .append_items(&refs)
        .map_err(|error| format!("Open Recent 항목을 넣지 못했습니다: {error}"))
}

/// Open Recent에 들어갈 항목들. 비었으면 비활성 안내 한 줄, 있으면 경로 + 구분선 + Clear Menu.
fn recent_items<R: Runtime>(
    app: &AppHandle<R>,
    entries: &[RecentEntry],
) -> tauri::Result<Vec<Box<dyn IsMenuItem<R>>>> {
    if entries.is_empty() {
        let empty = MenuItem::with_id(
            app,
            RECENT_EMPTY_ID,
            "No Recent Repositories",
            false,
            None::<&str>,
        )?;
        return Ok(vec![Box::new(empty)]);
    }

    let mut items: Vec<Box<dyn IsMenuItem<R>>> = Vec::with_capacity(entries.len() + 2);
    for entry in entries {
        // 라벨이 같은 레포가 둘 있어도 id는 경로라서 서로 다른 항목이 된다
        items.push(Box::new(MenuItem::with_id(
            app,
            format!("{RECENT_ITEM_PREFIX}{}", entry.path),
            &entry.label,
            true,
            None::<&str>,
        )?));
    }
    items.push(Box::new(PredefinedMenuItem::separator(app)?));
    items.push(Box::new(MenuItem::with_id(
        app,
        CLEAR_RECENT_ID,
        "Clear Menu",
        true,
        None::<&str>,
    )?));

    Ok(items)
}

fn submenu<R: Runtime>(kind: Option<MenuItemKind<R>>) -> Option<Submenu<R>> {
    kind.and_then(|kind| kind.as_submenu().cloned())
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
/// 그래서 **사용자 향 단축키에는 Shift 조합을 쓰지 않는다.** Close Window에 ⇧⌘W를 주지
/// 못하고 accelerator 없이 둔 이유다. 이 함수는 표준 항목(Redo ⇧⌘Z) 복구와 앞으로의
/// 안전망으로만 남긴다.
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

/// 설치된 NSMenu를 stderr로 덤프한다. macOS 전용, `GITLANES_DUMP_MENU`가 설정될 때만 돈다.
///
/// accelerator 문자열이 실제로 어떤 keyEquivalent/modifierMask로 등록됐는지 확인하는 자리다.
/// muda가 Shift 조합에서 소문자를 넣는 문제(fix_shift_accelerators)를 이렇게 찾아냈고,
/// View/Help의 `=`, `-`, `/`, `0`이 제대로 붙는지도 같은 방법으로 확인했다.
#[cfg(target_os = "macos")]
pub fn dump_menu() {
    use objc2::MainThreadMarker;
    use objc2_app_kit::{NSApplication, NSEventModifierFlags, NSMenu};

    fn mods(mask: NSEventModifierFlags) -> String {
        let names = [
            (NSEventModifierFlags::Command, "Command"),
            (NSEventModifierFlags::Shift, "Shift"),
            (NSEventModifierFlags::Option, "Option"),
            (NSEventModifierFlags::Control, "Control"),
        ];
        let listed: Vec<&str> = names
            .iter()
            .filter(|(flag, _)| mask.contains(*flag))
            .map(|(_, name)| *name)
            .collect();
        if listed.is_empty() {
            "-".to_string()
        } else {
            listed.join("|")
        }
    }

    fn walk(menu: &NSMenu, path: &str) {
        for index in 0..menu.numberOfItems() {
            let Some(item) = menu.itemAtIndex(index) else {
                continue;
            };
            let title = item.title().to_string();
            let here = if path.is_empty() {
                title.clone()
            } else {
                format!("{path} > {title}")
            };
            let key = item.keyEquivalent().to_string();
            if !key.is_empty() {
                println!(
                    "{here}\tkey={key:?}\tmods={}",
                    mods(item.keyEquivalentModifierMask())
                );
            } else if item.submenu().is_none() {
                println!("{here}");
            }
            if let Some(submenu) = item.submenu() {
                walk(&submenu, &here);
            }
        }
    }

    let Some(mtm) = MainThreadMarker::new() else {
        eprintln!("메뉴 덤프는 메인 스레드에서만 가능합니다");
        return;
    };
    match NSApplication::sharedApplication(mtm).mainMenu() {
        Some(menu) => walk(&menu, ""),
        None => eprintln!("앱 메뉴가 아직 설치되지 않아 덤프하지 못했습니다"),
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
