// 탭 컨테이너. 탭 목록/활성 탭/영속화만 담당하고, 레포 상태는 각 RepoWorkspace가 가진다.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { listen } from "@tauri-apps/api/event";
import type { UnlistenFn } from "@tauri-apps/api/event";
import { errorMessage, getStartupRepo } from "./shell/api";
import { basename } from "./shell/format";
import { RepoWorkspace } from "./shell/RepoWorkspace";
import { TabBar } from "./shell/TabBar";
import type { TabInfo } from "./shell/TabBar";
import { UpdateBanner } from "./shell/UpdateBanner";
import { UpdatePill } from "./shell/UpdatePill";
import { useUpdateChecker } from "./shell/useUpdateChecker";
import type { WorkspaceUpdateProps } from "./shell/RepoWorkspace";
import "./shell/shell.css";

const TABS_KEY = "gitlanes.tabs";

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

/** 탭별 메뉴 명령 카운터. 값이 오른 탭만 그 명령을 실행한다 */
interface TabCommands {
  open: number;
  refresh: number;
}

const NO_COMMANDS: TabCommands = { open: 0, refresh: 0 };

/** 탭 스피너 최소 표시 시간(ms). 로컬 레포는 30ms에 끝나 번쩍임만 남는다 */
const MIN_SPINNER_MS = 250;

/** Tauri 웹뷰인가. 하네스(브라우저)에서는 메뉴 이벤트가 없어 keydown 폴백을 쓴다 */
function hasTauriInternals(): boolean {
  return typeof (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ !== "undefined";
}

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
  // 업데이트 확인은 탭 수와 무관하게 앱 전역에서 하나만 돈다
  const updater = useUpdateChecker();

  // 탭 구성이 바뀔 때마다 저장한다
  useEffect(() => {
    writeStoredTabs(tabs, activeId);
  }, [tabs, activeId]);

  /** 콜백에서 최신 탭 목록을 읽기 위한 거울. 콜백 identity를 안정적으로 유지한다 */
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;
  const activeIdRef = useRef(activeId);
  activeIdRef.current = activeId;

  /** 이미 열린 탭이 있으면 활성화, 빈 웰컴 탭이 있으면 거기에, 아니면 새 탭 */
  const openInTab = useCallback((path: string) => {
    const prev = tabsRef.current;
    const existing = prev.find((tab) => tab.path === path);
    if (existing !== undefined) {
      setActiveId(existing.id);
      return;
    }
    const empty = prev.find((tab) => tab.path === null);
    if (empty !== undefined) {
      setTabs(
        prev.map((tab) => (tab.id === empty.id ? { ...tab, path, label: basename(path) } : tab)),
      );
      setActiveId(empty.id);
      return;
    }
    const created = makeTab(path);
    setTabs([...prev, created]);
    setActiveId(created.id);
  }, []);

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

  const handleCloseTab = useCallback((id: number) => {
    const timer = loadingTimers.current[id];
    if (timer !== undefined) {
      window.clearTimeout(timer);
      delete loadingTimers.current[id];
    }
    delete loadingStartedAt.current[id];
    setTabLoading((current) => {
      if (!(id in current)) {
        return current;
      }
      const next = { ...current };
      delete next[id];
      return next;
    });
    const prev = tabsRef.current;
    const index = prev.findIndex((tab) => tab.id === id);
    if (index < 0) {
      return;
    }
    const next = prev.filter((tab) => tab.id !== id);
    if (next.length === 0) {
      // 마지막 탭을 닫으면 빈 웰컴 탭으로 돌아간다
      const fresh = makeTab(null);
      setTabs([fresh]);
      setActiveId(fresh.id);
      return;
    }
    setTabs(next);
    setActiveId((current) =>
      current === id ? next[Math.min(index, next.length - 1)].id : current,
    );
  }, []);

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
  });
  menuHandlers.current = {
    newTab: handleNewTab,
    openRepo: handleMenuOpenRepo,
    closeTab: handleMenuCloseTab,
    refresh: handleMenuRefresh,
    gotoTab: handleGotoTab,
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

    return () => {
      disposed = true;
      for (const unlisten of unlisteners) {
        unlisten();
      }
      unlisteners.length = 0;
    };
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
          onLoadingChange={handleLoadingChange}
        />
      ))}
      <UpdatePill checking={updater.checking} result={updater.result} />
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
        onLoadingChange={handleLoadingChange}
      />
    </div>
  );
}
