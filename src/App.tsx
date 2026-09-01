// 탭 컨테이너. 탭 목록/활성 탭/영속화만 담당하고, 레포 상태는 각 RepoWorkspace가 가진다.
import { useCallback, useEffect, useRef, useState } from "react";
import { errorMessage, getStartupRepo } from "./shell/api";
import { basename } from "./shell/format";
import { RepoWorkspace } from "./shell/RepoWorkspace";
import { TabBar } from "./shell/TabBar";
import type { TabInfo } from "./shell/TabBar";
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

  // 탭 구성이 바뀔 때마다 저장한다
  useEffect(() => {
    writeStoredTabs(tabs, activeId);
  }, [tabs, activeId]);

  /** 콜백에서 최신 탭 목록을 읽기 위한 거울. 콜백 identity를 안정적으로 유지한다 */
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;

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

  const handleNewTab = useCallback(() => {
    const created = makeTab(null);
    setTabs([...tabsRef.current, created]);
    setActiveId(created.id);
  }, []);

  const handleCloseTab = useCallback((id: number) => {
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

  return (
    <div className="app">
      <TabBar
        tabs={tabs}
        activeId={activeId}
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
        />
      ))}
    </div>
  );
}

interface TabPanelProps {
  tab: TabInfo;
  active: boolean;
  onRepoOpened: (tabId: number, path: string, name: string) => void;
  onRequestOpen: (tabId: number, path: string) => boolean;
}

/**
 * 비활성 탭도 마운트를 유지해 스크롤 위치와 이미 불러온 커밋을 보존한다.
 * hidden이면 display:none이라 GraphView는 ResizeObserver로 0높이를 보고 쉬다가,
 * 다시 보일 때 크기를 새로 잰다.
 */
function TabPanel({ tab, active, onRepoOpened, onRequestOpen }: TabPanelProps) {
  const handleRepoOpened = useCallback(
    (path: string, name: string) => onRepoOpened(tab.id, path, name),
    [onRepoOpened, tab.id],
  );
  const handleRequestOpen = useCallback(
    (path: string) => onRequestOpen(tab.id, path),
    [onRequestOpen, tab.id],
  );

  return (
    <div className="tab-panel" hidden={!active}>
      <RepoWorkspace
        initialPath={tab.path}
        active={active}
        onRepoOpened={handleRepoOpened}
        requestOpen={handleRequestOpen}
      />
    </div>
  );
}
