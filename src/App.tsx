// 탭 컨테이너. 탭 목록/활성 탭/영속화만 담당하고, 레포 상태는 각 RepoWorkspace가 가진다.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { listen } from "@tauri-apps/api/event";
import type { UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { errorMessage, getStartupRepo, revealPath, setRecentRepos } from "./shell/api";
import { copyText } from "./shell/clipboard";
import { basename } from "./shell/format";
import { RepoWorkspace } from "./shell/RepoWorkspace";
import { Preferences } from "./shell/Preferences";
import type { PrefValues } from "./shell/Preferences";
import { clampZoom, readPrefs, writePrefs, ZOOM_STEP } from "./shell/prefs";
import { ShortcutsOverlay } from "./shell/ShortcutsOverlay";
import { IS_MAC } from "./shell/shortcuts";
import { TabBar } from "./shell/TabBar";
import type { TabInfo } from "./shell/TabBar";
import { UpdateBanner } from "./shell/UpdateBanner";
import { UpdatePill } from "./shell/UpdatePill";
import { useDropZone } from "./shell/useDropZone";
import { useRecentRepos } from "./shell/useRecentRepos";
import { useUpdateChecker } from "./shell/useUpdateChecker";
import type { WorkspaceUpdateProps } from "./shell/RepoWorkspace";
import "./shell/shell.css";

const TABS_KEY = "gitlanes.tabs";

/** 줌 기본값(Actual Size). 범위와 단계는 prefs.ts가 갖는다 */
const ZOOM_DEFAULT = 1;

/** ⌘⇧T로 되살릴 수 있는 닫은 탭 경로 스택의 최대 길이 (세션 메모리) */
const MAX_REOPEN = 10;

interface StoredTabs {
  paths: string[];
  activeIndex: number;
}

function readStoredTabs(): StoredTabs {
  try {
    const raw = localStorage.getItem(TABS_KEY);
    if (raw === null) {
      return { paths: [], activeIndex: 0 };
    }
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object") {
      return { paths: [], activeIndex: 0 };
    }
    const record = parsed as { paths?: unknown; activeIndex?: unknown };
    const paths = Array.isArray(record.paths)
      ? record.paths.filter((p): p is string => typeof p === "string")
      : [];
    const activeIndex = typeof record.activeIndex === "number" ? record.activeIndex : 0;
    return { paths, activeIndex };
  } catch {
    return { paths: [], activeIndex: 0 };
  }
}

function writeStoredTabs(tabs: TabInfo[], activeId: number): void {
  const opened = tabs.filter((tab) => tab.path !== null);
  const activeTab = tabs.find((tab) => tab.id === activeId);
  const activeIndex =
    activeTab === undefined || activeTab.path === null
      ? Math.max(0, opened.length - 1)
      : opened.findIndex((tab) => tab.id === activeTab.id);
  try {
    localStorage.setItem(
      TABS_KEY,
      JSON.stringify({ paths: opened.map((tab) => tab.path), activeIndex }),
    );
  } catch {
    // localStorage 실패는 무시 (다음 실행에서 복원만 안 될 뿐)
  }
}

/** 웹뷰 줌 적용. 하네스(브라우저)에는 webview API가 없으므로 조용히 넘어간다 */
function applyZoom(level: number): void {
  try {
    void getCurrentWebview()
      .setZoom(level)
      .catch(() => {
        // 권한/플랫폼 미지원은 무시
      });
  } catch {
    // Tauri 웹뷰가 아니다
  }
}

/** 탭별 메뉴 명령 카운터. 값이 오른 탭만 그 명령을 실행한다 */
interface TabCommands {
  open: number;
  refresh: number;
  toggleSidebar: number;
  toggleTerminal: number;
}

const NO_COMMANDS: TabCommands = { open: 0, refresh: 0, toggleSidebar: 0, toggleTerminal: 0 };

/** 탭 스피너 최소 표시 시간(ms). 로컬 레포는 30ms에 끝나 번쩍임만 남는다 */
const MIN_SPINNER_MS = 250;

/** Tauri 웹뷰인가. 하네스(브라우저)에서는 메뉴 이벤트가 없어 keydown 폴백을 쓴다 */
function hasTauriInternals(): boolean {
  return typeof (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ !== "undefined";
}

/** 치트시트 표기는 툴팁과 같은 판정을 쓴다 (shortcuts.ts가 단일 출처) */
const PLATFORM: "mac" | "other" = IS_MAC ? "mac" : "other";

let nextTabId = 1;

function makeTab(path: string | null): TabInfo {
  return {
    id: nextTabId++,
    path,
    label: path === null ? "New tab" : basename(path),
  };
}

/** 저장된 탭을 복원한다. 없으면 웰컴 탭 하나 */
function initialTabs(): TabInfo[] {
  const stored = readStoredTabs();
  if (stored.paths.length === 0) {
    return [makeTab(null)];
  }
  return stored.paths.map((path) => makeTab(path));
}

function initialActiveId(tabs: TabInfo[]): number {
  const stored = readStoredTabs();
  const index = Math.min(Math.max(0, stored.activeIndex), tabs.length - 1);
  return tabs[index].id;
}

export default function App() {
  const [tabs, setTabs] = useState<TabInfo[]>(initialTabs);
  const [activeId, setActiveId] = useState<number>(() => initialActiveId(tabs));
  const startupDone = useRef(false);
  const [commands, setCommands] = useState<Record<number, TabCommands>>({});
  const [tabLoading, setTabLoading] = useState<Record<number, boolean>>({});
  const loadingStartedAt = useRef<Record<number, number>>({});
  const loadingTimers = useRef<Record<number, number>>({});
  const [menuFallback, setMenuFallback] = useState(() => !hasTauriInternals());
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [prefsOpen, setPrefsOpen] = useState(false);
  /** 전역 설정(탭 공통). Preferences 창과 ⌘=/⌘-/⌘0이 같은 값을 공유한다 */
  const [prefs, setPrefs] = useState<PrefValues>(readPrefs);
  /** 닫은 탭 경로 스택. 세션 메모리라 앱을 껐다 켜면 비어 있다 */
  const reopenStack = useRef<string[]>([]);
  // 업데이트 확인은 탭 수와 무관하게 앱 전역에서 하나만 돈다
  const updater = useUpdateChecker(prefs.autoUpdateCheck);
  const { recents, clearRecents } = useRecentRepos();

  // 탭 구성이 바뀔 때마다 저장한다
  useEffect(() => {
    writeStoredTabs(tabs, activeId);
  }, [tabs, activeId]);

  /** 콜백에서 최신 설정을 읽기 위한 거울 */
  const prefsRef = useRef(prefs);
  prefsRef.current = prefs;

  /** Preferences의 onChange와 줌 단축키가 함께 쓴다. 즉시 반영 + 즉시 저장 */
  const updatePrefs = useCallback((patch: Partial<PrefValues>) => {
    // 슬라이더가 준 값은 범위 밖이거나 부동소수 잔재가 붙어 있을 수 있다
    const normalized: Partial<PrefValues> =
      patch.zoom === undefined ? patch : { ...patch, zoom: clampZoom(patch.zoom) };
    writePrefs(normalized);
    if (normalized.zoom !== undefined) {
      applyZoom(normalized.zoom);
    }
    setPrefs((prev) => ({ ...prev, ...normalized }));
  }, []);

  // 저장된 줌을 시작 시 1회 적용한다
  useEffect(() => {
    if (prefsRef.current.zoom !== ZOOM_DEFAULT) {
      applyZoom(prefsRef.current.zoom);
    }
  }, []);

  // 네이티브 Open Recent 서브메뉴 초기 동기화. 이후 변경은 useRecentRepos가 직접 밀어준다
  const recentsSynced = useRef(false);
  useEffect(() => {
    if (recentsSynced.current) {
      return;
    }
    recentsSynced.current = true;
    setRecentRepos(recents).catch(() => {
      // 하네스에는 메뉴가 없다
    });
  }, [recents]);

  /** 콜백에서 최신 탭 목록을 읽기 위한 거울. 콜백 identity를 안정적으로 유지한다 */
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;
  const activeIdRef = useRef(activeId);
  activeIdRef.current = activeId;

  /**
   * 여러 경로를 한 번에 연다(폴더 드롭). 이미 열린 레포는 활성화, 빈 웰컴 탭이 있으면 거기에,
   * 아니면 새 탭. 같은 tick에 여러 번 불려도 잃지 않도록 tabsRef를 함께 갱신한다.
   */
  const openMany = useCallback((paths: string[]) => {
    let next = [...tabsRef.current];
    let activate: number | null = null;
    for (const path of paths) {
      const existing = next.find((tab) => tab.path === path);
      if (existing !== undefined) {
        activate = existing.id;
        continue;
      }
      const empty = next.find((tab) => tab.path === null);
      if (empty !== undefined) {
        next = next.map((tab) =>
          tab.id === empty.id ? { ...tab, path, label: basename(path) } : tab,
        );
        activate = empty.id;
        continue;
      }
      const created = makeTab(path);
      next = [...next, created];
      activate = created.id;
    }
    if (activate === null) {
      return;
    }
    tabsRef.current = next;
    setTabs(next);
    setActiveId(activate);
  }, []);

  const openInTab = useCallback((path: string) => openMany([path]), [openMany]);

  const { isOver } = useDropZone(openMany);

  /** 워크스페이스의 로딩 상태를 받아 최소 250ms는 스피너가 보이도록 늦춰 끈다 */
  const handleLoadingChange = useCallback((tabId: number, loading: boolean) => {
    const timer = loadingTimers.current[tabId];
    if (timer !== undefined) {
      window.clearTimeout(timer);
      delete loadingTimers.current[tabId];
    }
    if (loading) {
      loadingStartedAt.current[tabId] = Date.now();
      setTabLoading((prev) => (prev[tabId] === true ? prev : { ...prev, [tabId]: true }));
      return;
    }
    const elapsed = Date.now() - (loadingStartedAt.current[tabId] ?? 0);
    const remaining = Math.max(0, MIN_SPINNER_MS - elapsed);
    if (remaining === 0) {
      setTabLoading((prev) => (prev[tabId] === true ? { ...prev, [tabId]: false } : prev));
      return;
    }
    loadingTimers.current[tabId] = window.setTimeout(() => {
      delete loadingTimers.current[tabId];
      setTabLoading((prev) => ({ ...prev, [tabId]: false }));
    }, remaining);
  }, []);

  useEffect(() => {
    const timers = loadingTimers.current;
    return () => {
      for (const id of Object.keys(timers)) {
        window.clearTimeout(timers[Number(id)]);
      }
    };
  }, []);

  const loadingIds = useMemo(() => {
    const ids = new Set<number>();
    for (const [id, loading] of Object.entries(tabLoading)) {
      if (loading) {
        ids.add(Number(id));
      }
    }
    return ids;
  }, [tabLoading]);

  const bumpCommand = useCallback((tabId: number, key: keyof TabCommands) => {
    setCommands((prev) => {
      const current = prev[tabId] ?? NO_COMMANDS;
      return { ...prev, [tabId]: { ...current, [key]: current[key] + 1 } };
    });
  }, []);

  // 시작 레포(CLI 인자/환경변수)는 앱 전체에서 1회만 확인한다
  useEffect(() => {
    if (startupDone.current) {
      return;
    }
    startupDone.current = true;
    getStartupRepo()
      .then((path) => {
        if (path !== null && path !== "") {
          openInTab(path);
        }
      })
      .catch((err: unknown) => {
        // 시작 레포 확인 실패는 콘솔로만 남기고 웰컴 화면을 유지한다
        console.error("get_startup_repo:", errorMessage(err));
      });
  }, [openInTab]);

  // GitKraken처럼 빈 탭도 여러 개 열 수 있다 (레포 중복 탭만 기존 탭으로 보낸다)
  const handleNewTab = useCallback(() => {
    const created = makeTab(null);
    setTabs([...tabsRef.current, created]);
    setActiveId(created.id);
  }, []);

  /** 닫은 탭의 경로를 복원 스택에 쌓는다. 빈 탭은 되살릴 게 없어 무시 */
  const rememberClosed = useCallback((path: string | null) => {
    if (path === null) {
      return;
    }
    const stack = reopenStack.current.filter((p) => p !== path);
    stack.push(path);
    reopenStack.current = stack.slice(-MAX_REOPEN);
  }, []);

  /** 탭 여러 개를 한 번에 닫는다. 닫기/다른 탭 닫기/오른쪽 닫기가 함께 쓴다 */
  const closeIds = useCallback(
    (ids: number[]) => {
      const targets = new Set(ids);
      const prev = tabsRef.current;
      const closing = prev.filter((tab) => targets.has(tab.id));
      if (closing.length === 0) {
        return;
      }
      for (const tab of closing) {
        const timer = loadingTimers.current[tab.id];
        if (timer !== undefined) {
          window.clearTimeout(timer);
          delete loadingTimers.current[tab.id];
        }
        delete loadingStartedAt.current[tab.id];
        rememberClosed(tab.path);
      }
      setTabLoading((current) => {
        const next = { ...current };
        let changed = false;
        for (const tab of closing) {
          if (tab.id in next) {
            delete next[tab.id];
            changed = true;
          }
        }
        return changed ? next : current;
      });

      const firstIndex = prev.findIndex((tab) => targets.has(tab.id));
      const next = prev.filter((tab) => !targets.has(tab.id));
      if (next.length === 0) {
        // 마지막 탭을 닫으면 빈 웰컴 탭으로 돌아간다
        const fresh = makeTab(null);
        tabsRef.current = [fresh];
        setTabs([fresh]);
        setActiveId(fresh.id);
        return;
      }
      tabsRef.current = next;
      setTabs(next);
      setActiveId((current) =>
        targets.has(current) ? next[Math.min(firstIndex, next.length - 1)].id : current,
      );
    },
    [rememberClosed],
  );

  const handleCloseTab = useCallback((id: number) => closeIds([id]), [closeIds]);

  const handleCloseOthers = useCallback(
    (id: number) => {
      closeIds(tabsRef.current.filter((tab) => tab.id !== id).map((tab) => tab.id));
    },
    [closeIds],
  );

  const handleCloseToRight = useCallback(
    (id: number) => {
      const tabs = tabsRef.current;
      const index = tabs.findIndex((tab) => tab.id === id);
      if (index < 0) {
        return;
      }
      closeIds(tabs.slice(index + 1).map((tab) => tab.id));
    },
    [closeIds],
  );

  /** 드래그 재정렬. 순서만 바꾸고 활성 탭은 그대로 둔다 */
  const handleReorder = useCallback((fromIndex: number, toIndex: number) => {
    const prev = tabsRef.current;
    if (
      fromIndex === toIndex ||
      fromIndex < 0 ||
      fromIndex >= prev.length ||
      toIndex < 0 ||
      toIndex >= prev.length
    ) {
      return;
    }
    const next = [...prev];
    const [moved] = next.splice(fromIndex, 1);
    next.splice(toIndex, 0, moved);
    tabsRef.current = next;
    setTabs(next);
  }, []);

  const handleCopyTabPath = useCallback((id: number) => {
    const tab = tabsRef.current.find((t) => t.id === id);
    if (tab === undefined || tab.path === null) {
      return;
    }
    void copyText(tab.path);
  }, []);

  const handleRevealTab = useCallback((id: number) => {
    const tab = tabsRef.current.find((t) => t.id === id);
    if (tab === undefined || tab.path === null) {
      return;
    }
    revealPath(tab.path).catch((err: unknown) => {
      console.error("reveal_path:", errorMessage(err));
    });
  }, []);

  /** ⌘⇧T: 가장 최근에 닫은 레포 탭을 되살린다 */
  const handleReopenClosed = useCallback(() => {
    const path = reopenStack.current.pop();
    if (path === undefined) {
      return;
    }
    openInTab(path);
  }, [openInTab]);

  /** 워크스페이스가 레포를 열었을 때 탭 라벨/경로를 갱신 */
  const handleRepoOpened = useCallback((tabId: number, path: string, name: string) => {
    setTabs((prev) =>
      prev.map((tab) => (tab.id === tabId ? { ...tab, path, label: name } : tab)),
    );
  }, []);

  /** 다른 탭이 이미 연 레포면 그 탭을 활성화하고 true (워크스페이스는 열기를 포기한다) */
  const handleRequestOpen = useCallback((tabId: number, path: string): boolean => {
    const existing = tabsRef.current.find((tab) => tab.path === path && tab.id !== tabId);
    if (existing === undefined) {
      return false;
    }
    setActiveId(existing.id);
    return true;
  }, []);

  /** 메뉴 Open Repository…: 활성 탭이 빈 탭이면 거기서, 아니면 새 탭을 만들어 연다 */
  const handleMenuOpenRepo = useCallback(() => {
    const tabs = tabsRef.current;
    const active = tabs.find((tab) => tab.id === activeIdRef.current);
    if (active !== undefined && active.path === null) {
      bumpCommand(active.id, "open");
      return;
    }
    const created = makeTab(null);
    setTabs([...tabs, created]);
    setActiveId(created.id);
    bumpCommand(created.id, "open");
  }, [bumpCommand]);

  const handleMenuRefresh = useCallback(() => {
    bumpCommand(activeIdRef.current, "refresh");
  }, [bumpCommand]);

  const handleMenuCloseTab = useCallback(() => {
    handleCloseTab(activeIdRef.current);
  }, [handleCloseTab]);

  /** ⌘B: 사이드바 상태는 탭마다 따로라 활성 탭에만 토글 명령을 보낸다 */
  const handleMenuToggleSidebar = useCallback(() => {
    bumpCommand(activeIdRef.current, "toggleSidebar");
  }, [bumpCommand]);

  /** ⌃`: 하단 터미널도 탭마다 따로다 (PTY 세션이 탭별) */
  const handleMenuToggleTerminal = useCallback(() => {
    bumpCommand(activeIdRef.current, "toggleTerminal");
  }, [bumpCommand]);

  const openPreferences = useCallback(() => setPrefsOpen(true), []);
  const closePreferences = useCallback(() => setPrefsOpen(false), []);

  const handleZoom = useCallback(
    (kind: "in" | "out" | "reset") => {
      const current = prefsRef.current.zoom;
      const next =
        kind === "reset"
          ? ZOOM_DEFAULT
          : clampZoom(current + (kind === "in" ? ZOOM_STEP : -ZOOM_STEP));
      if (next === current) {
        return;
      }
      updatePrefs({ zoom: next });
    },
    [updatePrefs],
  );

  const handleShowShortcuts = useCallback(() => setShortcutsOpen((prev) => !prev), []);
  const handleCloseShortcuts = useCallback(() => setShortcutsOpen(false), []);

  /** 활성 탭 기준 좌우 이동. 양끝에서는 순환한다 */
  const handleCycleTab = useCallback((direction: -1 | 1) => {
    const tabs = tabsRef.current;
    if (tabs.length < 2) {
      return;
    }
    const index = tabs.findIndex((tab) => tab.id === activeIdRef.current);
    if (index < 0) {
      return;
    }
    const next = (index + direction + tabs.length) % tabs.length;
    setActiveId(tabs[next].id);
  }, []);

  /** ⌘1~⌘8은 그 순번 탭, ⌘9는 마지막 탭 */
  const handleGotoTab = useCallback((slot: number) => {
    const tabs = tabsRef.current;
    if (tabs.length === 0) {
      return;
    }
    if (slot === 9) {
      setActiveId(tabs[tabs.length - 1].id);
      return;
    }
    if (slot < 1 || slot > 8) {
      return;
    }
    const target = tabs[slot - 1];
    if (target !== undefined) {
      setActiveId(target.id);
    }
  }, []);

  // 네이티브 메뉴 이벤트 구독. 핸들러는 ref로 읽어 재구독을 피한다
  const menuHandlers = useRef({
    newTab: handleNewTab,
    openRepo: handleMenuOpenRepo,
    closeTab: handleMenuCloseTab,
    refresh: handleMenuRefresh,
    gotoTab: handleGotoTab,
    cycleTab: handleCycleTab,
    toggleSidebar: handleMenuToggleSidebar,
    toggleTerminal: handleMenuToggleTerminal,
    preferences: openPreferences,
    zoom: handleZoom,
    shortcuts: handleShowShortcuts,
    openPath: openInTab,
    clearRecents,
    checkUpdates: updater.checkNow,
    reopenClosed: handleReopenClosed,
  });
  menuHandlers.current = {
    newTab: handleNewTab,
    openRepo: handleMenuOpenRepo,
    closeTab: handleMenuCloseTab,
    refresh: handleMenuRefresh,
    gotoTab: handleGotoTab,
    cycleTab: handleCycleTab,
    toggleSidebar: handleMenuToggleSidebar,
    toggleTerminal: handleMenuToggleTerminal,
    preferences: openPreferences,
    zoom: handleZoom,
    shortcuts: handleShowShortcuts,
    openPath: openInTab,
    clearRecents,
    checkUpdates: updater.checkNow,
    reopenClosed: handleReopenClosed,
  };

  useEffect(() => {
    let disposed = false;
    const unlisteners: UnlistenFn[] = [];

    const track = (pending: Promise<UnlistenFn>) => {
      pending
        .then((unlisten) => {
          if (disposed) {
            unlisten();
            return;
          }
          unlisteners.push(unlisten);
        })
        .catch(() => {
          // Tauri 웹뷰가 아니면 구독이 실패한다. keydown 폴백으로 넘어간다
          setMenuFallback(true);
        });
    };

    track(listen("menu:new-tab", () => menuHandlers.current.newTab()));
    track(listen("menu:open-repo", () => menuHandlers.current.openRepo()));
    track(listen("menu:close-tab", () => menuHandlers.current.closeTab()));
    track(listen("menu:refresh", () => menuHandlers.current.refresh()));
    track(
      listen<number>("menu:goto-tab", (event) => menuHandlers.current.gotoTab(event.payload)),
    );
    track(listen("menu:prev-tab", () => menuHandlers.current.cycleTab(-1)));
    track(listen("menu:next-tab", () => menuHandlers.current.cycleTab(1)));
    track(listen("menu:toggle-sidebar", () => menuHandlers.current.toggleSidebar()));
    track(listen("menu:toggle-terminal", () => menuHandlers.current.toggleTerminal()));
    track(listen("menu:preferences", () => menuHandlers.current.preferences()));
    track(listen("menu:zoom-in", () => menuHandlers.current.zoom("in")));
    track(listen("menu:zoom-out", () => menuHandlers.current.zoom("out")));
    track(listen("menu:zoom-reset", () => menuHandlers.current.zoom("reset")));
    track(listen("menu:shortcuts", () => menuHandlers.current.shortcuts()));
    track(
      listen<string>("menu:open-recent", (event) => {
        if (typeof event.payload === "string" && event.payload !== "") {
          menuHandlers.current.openPath(event.payload);
        }
      }),
    );
    track(listen("menu:clear-recent", () => menuHandlers.current.clearRecents()));
    // 툴바 버전 라벨 클릭과 같은 경로. 확인 중이면 useUpdateChecker가 알아서 무시한다
    track(listen("menu:check-updates", () => menuHandlers.current.checkUpdates()));

    return () => {
      disposed = true;
      for (const unlisten of unlisteners) {
        unlisten();
      }
      unlisteners.length = 0;
    };
  }, []);

  // ⌘⇧[ / ⌘⇧]는 macOS 네이티브 메뉴 accelerator로 잡을 수 없어(AppKit이 Shift 적용된 "{"로 비교)
  // 키 이벤트가 웹뷰까지 내려온다. 그래서 Tauri 여부와 무관하게 항상 여기서 처리한다.
  // 네이티브 메뉴는 ⌥⌘← / ⌥⌘→로 등록돼 있어 조합이 겹치지 않는다.
  // Shift+알파벳(⌘⇧T)도 muda 버그로 네이티브에 못 넣어 같이 여기서 받는다
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      // Ctrl+Tab / Ctrl+⇧Tab 탭 순환 (macOS에서도 Ctrl 조합 그대로)
      if (event.ctrlKey && !event.metaKey && !event.altKey && event.code === "Tab") {
        event.preventDefault();
        menuHandlers.current.cycleTab(event.shiftKey ? -1 : 1);
        return;
      }
      // ⌘, Preferences. 네이티브 메뉴가 없는 하네스에서도 열려야 한다
      if (
        event.code === "Comma" &&
        (event.metaKey || event.ctrlKey) &&
        !event.shiftKey &&
        !event.altKey
      ) {
        event.preventDefault();
        menuHandlers.current.preferences();
        return;
      }
      if (!event.shiftKey || (!event.metaKey && !event.ctrlKey)) {
        return;
      }
      // key 값은 레이아웃에 따라 "{"/"}"로 오므로 물리 키로 판정한다
      if (event.code === "BracketLeft") {
        event.preventDefault();
        menuHandlers.current.cycleTab(-1);
        return;
      }
      if (event.code === "BracketRight") {
        event.preventDefault();
        menuHandlers.current.cycleTab(1);
        return;
      }
      if (event.code === "KeyT") {
        event.preventDefault();
        menuHandlers.current.reopenClosed();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  // 하네스 전용 폴백. ⌘W는 브라우저가 선점하므로 다루지 않는다
  useEffect(() => {
    if (!menuFallback) {
      return;
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (!event.metaKey && !event.ctrlKey) {
        return;
      }
      if (event.shiftKey) {
        return;
      }
      const key = event.key.toLowerCase();
      if (key === "t") {
        event.preventDefault();
        menuHandlers.current.newTab();
        return;
      }
      if (key === "r") {
        // 브라우저 새로고침을 막는다
        event.preventDefault();
        menuHandlers.current.refresh();
        return;
      }
      if (key === "b") {
        event.preventDefault();
        menuHandlers.current.toggleSidebar();
        return;
      }
      if (key === "/") {
        event.preventDefault();
        menuHandlers.current.shortcuts();
        return;
      }
      if (key === "=" || key === "+") {
        event.preventDefault();
        menuHandlers.current.zoom("in");
        return;
      }
      if (key === "-") {
        event.preventDefault();
        menuHandlers.current.zoom("out");
        return;
      }
      if (key === "0") {
        event.preventDefault();
        menuHandlers.current.zoom("reset");
        return;
      }
      if (key >= "1" && key <= "9") {
        event.preventDefault();
        menuHandlers.current.gotoTab(Number.parseInt(key, 10));
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [menuFallback]);

  const updateProps: WorkspaceUpdateProps = useMemo(
    () => ({
      tag: updater.update === null ? null : updater.update.tag,
      checking: updater.checking,
      onCheck: updater.checkNow,
      onOpenRelease: updater.openRelease,
    }),
    [updater.update, updater.checking, updater.checkNow, updater.openRelease],
  );

  const banner: ReactNode =
    updater.bannerVisible && updater.update !== null ? (
      <UpdateBanner
        update={updater.update}
        onOpenRelease={updater.openRelease}
        onDismiss={updater.dismissBanner}
      />
    ) : null;

  return (
    <div className="app">
      <TabBar
        tabs={tabs}
        activeId={activeId}
        loadingIds={loadingIds}
        onActivate={setActiveId}
        onClose={handleCloseTab}
        onNewTab={handleNewTab}
        onReorder={handleReorder}
        onCloseOthers={handleCloseOthers}
        onCloseToRight={handleCloseToRight}
        onCopyPath={handleCopyTabPath}
        onRevealInFinder={handleRevealTab}
      />
      {tabs.map((tab) => (
        <TabPanel
          key={tab.id}
          tab={tab}
          active={tab.id === activeId}
          onRepoOpened={handleRepoOpened}
          onRequestOpen={handleRequestOpen}
          update={updateProps}
          banner={tab.id === activeId ? banner : null}
          commands={commands[tab.id] ?? NO_COMMANDS}
          prefs={prefs}
          onLoadingChange={handleLoadingChange}
        />
      ))}
      <UpdatePill checking={updater.checking} result={updater.result} />
      <ShortcutsOverlay open={shortcutsOpen} onClose={handleCloseShortcuts} platform={PLATFORM} />
      <Preferences
        open={prefsOpen}
        onClose={closePreferences}
        values={prefs}
        onChange={updatePrefs}
      />
      {isOver && (
        <div className="drop-overlay">
          <div className="drop-overlay-card">Drop to open repository</div>
        </div>
      )}
    </div>
  );
}

interface TabPanelProps {
  tab: TabInfo;
  active: boolean;
  onRepoOpened: (tabId: number, path: string, name: string) => void;
  onRequestOpen: (tabId: number, path: string) => boolean;
  update: WorkspaceUpdateProps;
  /** 활성 탭에만 실제 배너가 내려온다 */
  banner: ReactNode;
  commands: TabCommands;
  /** 전역 설정 (App 소유, Preferences로 조절) */
  prefs: PrefValues;
  onLoadingChange: (tabId: number, loading: boolean) => void;
}

/**
 * 비활성 탭도 마운트를 유지해 스크롤 위치와 이미 불러온 커밋을 보존한다.
 * hidden이면 display:none이라 GraphView는 ResizeObserver로 0높이를 보고 쉬다가,
 * 다시 보일 때 크기를 새로 잰다.
 */
function TabPanel({
  tab,
  active,
  onRepoOpened,
  onRequestOpen,
  update,
  banner,
  commands,
  prefs,
  onLoadingChange,
}: TabPanelProps) {
  const handleRepoOpened = useCallback(
    (path: string, name: string) => onRepoOpened(tab.id, path, name),
    [onRepoOpened, tab.id],
  );
  const handleRequestOpen = useCallback(
    (path: string) => onRequestOpen(tab.id, path),
    [onRequestOpen, tab.id],
  );
  const handleLoadingChange = useCallback(
    (loading: boolean) => onLoadingChange(tab.id, loading),
    [onLoadingChange, tab.id],
  );

  return (
    <div className="tab-panel" hidden={!active}>
      <RepoWorkspace
        initialPath={tab.path}
        active={active}
        onRepoOpened={handleRepoOpened}
        requestOpen={handleRequestOpen}
        update={update}
        banner={banner}
        openDialogNonce={commands.open}
        refreshNonce={commands.refresh}
        toggleSidebarNonce={commands.toggleSidebar}
        toggleTerminalNonce={commands.toggleTerminal}
        prefs={prefs}
        onLoadingChange={handleLoadingChange}
      />
    </div>
  );
}
