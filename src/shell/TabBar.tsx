import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { WheelEvent as ReactWheelEvent } from "react";
import { basename } from "./format";

export interface TabInfo {
  id: number;
  /** 열린 레포 경로. 아직 안 열었으면 null (웰컴 탭) */
  path: string | null;
  /** 탭 라벨 */
  label: string;
}

export interface TabBarProps {
  tabs: TabInfo[];
  activeId: number;
  /** 그래프를 불러오는 중인 탭 id 집합 */
  loadingIds: ReadonlySet<number>;
  onActivate: (id: number) => void;
  onClose: (id: number) => void;
  onNewTab: () => void;
}

/** 스크롤 버튼 한 번에 이동할 비율 */
const PAGE_RATIO = 0.8;

/** "/a/b/repo" -> "b" (동명 레포 구분용 부모 디렉토리 1단계) */
function parentDir(path: string | null): string {
  if (path === null) {
    return "";
  }
  const segments = path.replace(/\/+$/, "").split("/");
  return segments.length >= 2 ? segments[segments.length - 2] : "";
}

export function TabBar({
  tabs,
  activeId,
  loadingIds,
  onActivate,
  onClose,
  onNewTab,
}: TabBarProps) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const tabRefs = useRef(new Map<number, HTMLDivElement>());
  const [overflow, setOverflow] = useState({ any: false, left: false, right: false });
  const [menuOpen, setMenuOpen] = useState(false);

  // 같은 이름의 레포가 여러 탭이면 부모 디렉토리 1단계를 앞에 덧붙인다
  const prefixes = useMemo(() => {
    const counts = new Map<string, number>();
    for (const tab of tabs) {
      counts.set(tab.label, (counts.get(tab.label) ?? 0) + 1);
    }
    const result = new Map<number, string>();
    for (const tab of tabs) {
      if ((counts.get(tab.label) ?? 0) > 1) {
        const parent = parentDir(tab.path);
        if (parent !== "") {
          result.set(tab.id, parent);
        }
      }
    }
    return result;
  }, [tabs]);

  const measure = useCallback(() => {
    const box = scrollRef.current;
    if (box === null) {
      return;
    }
    const max = box.scrollWidth - box.clientWidth;
    setOverflow({
      any: max > 1,
      left: box.scrollLeft > 1,
      right: box.scrollLeft < max - 1,
    });
  }, []);

  useLayoutEffect(() => {
    measure();
  }, [measure, tabs.length]);

  useEffect(() => {
    const box = scrollRef.current;
    if (box === null || typeof ResizeObserver === "undefined") {
      return;
    }
    const observer = new ResizeObserver(measure);
    observer.observe(box);
    return () => observer.disconnect();
  }, [measure]);

  // 활성 탭이 바뀌면(⌘1~9, 클릭, 새 탭, 닫기 후 이웃) 뷰포트 안으로 끌어온다
  useEffect(() => {
    const box = scrollRef.current;
    const el = tabRefs.current.get(activeId);
    if (box === null || el === undefined) {
      return;
    }
    const left = el.offsetLeft;
    const right = left + el.offsetWidth;
    if (left < box.scrollLeft) {
      box.scrollTo({ left, behavior: "smooth" });
    } else if (right > box.scrollLeft + box.clientWidth) {
      box.scrollTo({ left: right - box.clientWidth, behavior: "smooth" });
    }
  }, [activeId, tabs.length]);

  // 세로 휠을 가로 스크롤로 바꿔 트랙패드 없이도 넘길 수 있게 한다
  function handleWheel(event: ReactWheelEvent<HTMLDivElement>) {
    const box = scrollRef.current;
    if (box === null || Math.abs(event.deltaY) <= Math.abs(event.deltaX)) {
      return;
    }
    box.scrollLeft += event.deltaY;
  }

  function scrollPage(direction: -1 | 1) {
    const box = scrollRef.current;
    if (box === null) {
      return;
    }
    box.scrollBy({ left: direction * box.clientWidth * PAGE_RATIO, behavior: "smooth" });
  }

  return (
    <div className="tabbar">
      {overflow.any && (
        <button
          className="tab-scroll-btn"
          onClick={() => scrollPage(-1)}
          disabled={!overflow.left}
          title="이전 탭들"
          aria-label="Scroll tabs left"
        >
          ‹
        </button>
      )}

      <div className="tabbar-scroll" ref={scrollRef} onScroll={measure} onWheel={handleWheel}>
        {tabs.map((tab) => {
          const prefix = prefixes.get(tab.id);
          return (
            <div
              key={tab.id}
              ref={(el) => {
                if (el === null) {
                  tabRefs.current.delete(tab.id);
                } else {
                  tabRefs.current.set(tab.id, el);
                }
              }}
              className={[
                "tab",
                tab.id === activeId ? "active" : "",
                loadingIds.has(tab.id) ? "loading" : "",
              ]
                .filter((name) => name !== "")
                .join(" ")}
              onMouseDown={(e) => {
                // 가운데 클릭으로 닫기 (브라우저 탭과 같은 관습)
                if (e.button === 1) {
                  e.preventDefault();
                  onClose(tab.id);
                }
              }}
            >
              <button
                className="tab-label"
                onClick={() => onActivate(tab.id)}
                title={tab.path ?? "New tab"}
              >
                {prefix !== undefined && <span className="tab-parent">{prefix}/</span>}
                {tab.label}
              </button>
              {loadingIds.has(tab.id) && (
                <span className="tab-spinner" aria-label="Loading" title="Loading…">
                  <svg viewBox="0 0 16 16" width="10" height="10" className="spin" aria-hidden="true">
                    <path
                      d="M14 8a6 6 0 1 1-1.8-4.3"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                    />
                  </svg>
                </span>
              )}
              <button
                className="tab-close"
                onClick={() => onClose(tab.id)}
                title="Close tab"
                aria-label={`Close ${tab.label}`}
              >
                ×
              </button>
            </div>
          );
        })}
      </div>

      {overflow.any && (
        <button
          className="tab-scroll-btn"
          onClick={() => scrollPage(1)}
          disabled={!overflow.right}
          title="다음 탭들"
          aria-label="Scroll tabs right"
        >
          ›
        </button>
      )}

      <button className="tab-new" onClick={onNewTab} title="New tab" aria-label="New tab">
        +
      </button>

      <TabListMenu
        tabs={tabs}
        activeId={activeId}
        open={menuOpen}
        onToggle={() => setMenuOpen((prev) => !prev)}
        onClose={() => setMenuOpen(false)}
        onActivate={(id) => {
          setMenuOpen(false);
          onActivate(id);
        }}
      />
    </div>
  );
}

interface TabListMenuProps {
  tabs: TabInfo[];
  activeId: number;
  open: boolean;
  onToggle: () => void;
  onClose: () => void;
  onActivate: (id: number) => void;
}

/** 열린 탭 전체 목록. 탭이 많을 때 목적 탭으로 바로 간다 */
function TabListMenu({ tabs, activeId, open, onToggle, onClose, onActivate }: TabListMenuProps) {
  const wrapRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) {
      return;
    }
    const onPointerDown = (event: MouseEvent) => {
      const el = wrapRef.current;
      if (el !== null && event.target instanceof Node && el.contains(event.target)) {
        return;
      }
      onClose();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      }
    };
    window.addEventListener("mousedown", onPointerDown, true);
    window.addEventListener("keydown", onKeyDown, true);
    return () => {
      window.removeEventListener("mousedown", onPointerDown, true);
      window.removeEventListener("keydown", onKeyDown, true);
    };
  }, [open, onClose]);

  return (
    <div className="tab-menu-wrap" ref={wrapRef}>
      <button
        className={open ? "tab-menu-btn on" : "tab-menu-btn"}
        onClick={onToggle}
        title="열린 탭 목록"
        aria-label="List open tabs"
        aria-expanded={open}
      >
        ⌄
      </button>
      {open && (
        <div className="tab-menu" role="menu">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              className={tab.id === activeId ? "tab-menu-item active" : "tab-menu-item"}
              role="menuitem"
              onClick={() => onActivate(tab.id)}
              title={tab.path ?? "New tab"}
            >
              <span className="tab-menu-check" aria-hidden="true">
                {tab.id === activeId ? "✓" : ""}
              </span>
              <span className="tab-menu-text">
                <span className="tab-menu-name">
                  {tab.path === null ? "New tab" : basename(tab.path)}
                </span>
                {tab.path !== null && <span className="tab-menu-path">{tab.path}</span>}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
