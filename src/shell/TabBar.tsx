import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type {
  MouseEvent as ReactMouseEvent,
  PointerEvent as ReactPointerEvent,
  WheelEvent as ReactWheelEvent,
} from "react";
import { basename } from "./format";
import { withKbd } from "./shortcuts";
import { TabContextMenu } from "./TabContextMenu";
import "./tabs.css";

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
  /** 드래그 재정렬 결과. 드롭 시 1회만 호출 */
  onReorder: (fromIndex: number, toIndex: number) => void;
  onCloseOthers: (id: number) => void;
  onCloseToRight: (id: number) => void;
  onCopyPath: (id: number) => void;
  onRevealInFinder: (id: number) => void;
}

/** 스크롤 버튼 한 번에 이동할 비율 */
const PAGE_RATIO = 0.8;
/** 클릭(활성화)과 드래그를 가르는 가로 이동 거리(px) */
const DRAG_THRESHOLD = 4;
/** 드래그 중 자동 스크롤이 걸리는 가장자리 폭(px) */
const EDGE_ZONE = 40;
/** 자동 스크롤 프레임당 최대 이동(px) */
const MAX_AUTO_SCROLL = 14;

interface DragInfo {
  id: number;
  fromIndex: number;
  startX: number;
  pointerId: number;
  el: HTMLDivElement;
  /** 4px 문턱을 넘어 실제 드래그로 승격됐는가 */
  started: boolean;
}

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
  onReorder,
  onCloseOthers,
  onCloseToRight,
  onCopyPath,
  onRevealInFinder,
}: TabBarProps) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const tabRefs = useRef(new Map<number, HTMLDivElement>());
  const [overflow, setOverflow] = useState({ any: false, left: false, right: false });
  const [menuOpen, setMenuOpen] = useState(false);
  const [contextTarget, setContextTarget] = useState<{ id: number; x: number; y: number } | null>(
    null,
  );

  // 드래그 상태: 좌표 계산에 쓰는 값은 ref, 화면에 그리는 값만 state
  const dragRef = useRef<DragInfo | null>(null);
  const pointerXRef = useRef(0);
  const autoScrollRef = useRef<number | null>(null);
  const suppressClickRef = useRef(false);
  const [armed, setArmed] = useState(false);
  const [dropIndex, setDropIndex] = useState<number | null>(null);

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

  // 커서 x가 어느 탭 사이에 있는지 (0 = 맨 앞, tabs.length = 맨 뒤)
  const insertIndexAt = useCallback(
    (clientX: number) => {
      let index = 0;
      for (const tab of tabs) {
        const el = tabRefs.current.get(tab.id);
        if (el === undefined) {
          continue;
        }
        const rect = el.getBoundingClientRect();
        if (clientX > rect.left + rect.width / 2) {
          index += 1;
        }
      }
      return index;
    },
    [tabs],
  );

  const stopAutoScroll = useCallback(() => {
    if (autoScrollRef.current !== null) {
      cancelAnimationFrame(autoScrollRef.current);
      autoScrollRef.current = null;
    }
  }, []);

  // 드래그 중 컨테이너 가장자리에 붙으면 가장자리와의 거리에 비례해 스크롤한다
  const runAutoScroll = useCallback(() => {
    const box = scrollRef.current;
    const info = dragRef.current;
    if (box === null || info === null || !info.started) {
      autoScrollRef.current = null;
      return;
    }
    const rect = box.getBoundingClientRect();
    const x = pointerXRef.current;
    let delta = 0;
    if (x < rect.left + EDGE_ZONE) {
      delta = -Math.min(MAX_AUTO_SCROLL, rect.left + EDGE_ZONE - x);
    } else if (x > rect.right - EDGE_ZONE) {
      delta = Math.min(MAX_AUTO_SCROLL, x - (rect.right - EDGE_ZONE));
    }
    if (delta !== 0) {
      const before = box.scrollLeft;
      box.scrollLeft = before + delta;
      if (box.scrollLeft !== before) {
        setDropIndex(insertIndexAt(x));
      }
    }
    autoScrollRef.current = requestAnimationFrame(runAutoScroll);
  }, [insertIndexAt]);

  useEffect(() => stopAutoScroll, [stopAutoScroll]);

  // pointerdown으로 무장(armed)된 동안만 window 리스너를 단다.
  // pointerdown은 discrete 이벤트라 다음 pointermove 전에 이 이펙트가 붙는다.
  useEffect(() => {
    if (!armed) {
      return;
    }

    const finish = (commit: boolean) => {
      const info = dragRef.current;
      stopAutoScroll();
      if (info !== null) {
        if (info.started) {
          try {
            info.el.releasePointerCapture(info.pointerId);
          } catch {
            // 이미 캡처가 풀린 경우는 무시한다
          }
        }
        if (commit && info.started) {
          const insertAt = insertIndexAt(pointerXRef.current);
          const toIndex = insertAt > info.fromIndex ? insertAt - 1 : insertAt;
          if (toIndex !== info.fromIndex) {
            onReorder(info.fromIndex, toIndex);
          }
        }
        // 드래그로 끝난 pointerup 뒤에 따라오는 click 1회만 삼킨다
        if (info.started) {
          window.setTimeout(() => {
            suppressClickRef.current = false;
          }, 0);
        }
      }
      dragRef.current = null;
      setDropIndex(null);
      setArmed(false);
    };

    const onMove = (event: PointerEvent) => {
      const info = dragRef.current;
      if (info === null || event.pointerId !== info.pointerId) {
        return;
      }
      pointerXRef.current = event.clientX;
      if (!info.started) {
        if (Math.abs(event.clientX - info.startX) < DRAG_THRESHOLD) {
          return;
        }
        info.started = true;
        suppressClickRef.current = true;
        try {
          info.el.setPointerCapture(info.pointerId);
        } catch {
          // 캡처가 안 되도 window 리스너로 계속 따라간다
        }
        if (autoScrollRef.current === null) {
          autoScrollRef.current = requestAnimationFrame(runAutoScroll);
        }
      }
      setDropIndex(insertIndexAt(event.clientX));
    };

    const onUp = (event: PointerEvent) => {
      const info = dragRef.current;
      if (info === null || event.pointerId !== info.pointerId) {
        return;
      }
      pointerXRef.current = event.clientX;
      finish(true);
    };

    const onCancel = () => finish(false);

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onCancel);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
    };
  }, [armed, insertIndexAt, onReorder, runAutoScroll, stopAutoScroll]);

  function handleTabPointerDown(event: ReactPointerEvent<HTMLDivElement>, tab: TabInfo, index: number) {
    if (event.button !== 0) {
      return;
    }
    // 닫기 버튼 위에서 시작한 누름은 드래그로 보지 않는다
    if (event.target instanceof Element && event.target.closest(".tab-close") !== null) {
      return;
    }
    const el = tabRefs.current.get(tab.id);
    if (el === undefined) {
      return;
    }
    pointerXRef.current = event.clientX;
    dragRef.current = {
      id: tab.id,
      fromIndex: index,
      startX: event.clientX,
      pointerId: event.pointerId,
      el,
      started: false,
    };
    setArmed(true);
  }

  function handleLabelClick(id: number) {
    // 드래그로 끝난 경우의 click은 활성화로 치지 않는다
    if (suppressClickRef.current) {
      suppressClickRef.current = false;
      return;
    }
    onActivate(id);
  }

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

  // 탭이 아닌 빈 배경 더블클릭만 새 탭으로 친다
  function handleBackgroundDoubleClick(event: ReactMouseEvent<HTMLDivElement>) {
    if (!(event.target instanceof Element)) {
      return;
    }
    if (event.target.closest(".tab") !== null || event.target.closest("button") !== null) {
      return;
    }
    onNewTab();
  }

  // 삽입 표시선의 x. offsetLeft는 스크롤과 무관해 자동 스크롤 중에도 어긋나지 않는다
  function indicatorLeft(index: number): number | null {
    if (tabs.length === 0) {
      return null;
    }
    if (index >= tabs.length) {
      const last = tabRefs.current.get(tabs[tabs.length - 1].id);
      return last === undefined ? null : last.offsetLeft + last.offsetWidth;
    }
    const el = tabRefs.current.get(tabs[index].id);
    return el === undefined ? null : el.offsetLeft;
  }

  const draggingId = dropIndex === null ? null : (dragRef.current?.id ?? null);
  const indicatorX = dropIndex === null ? null : indicatorLeft(dropIndex);
  const contextIndex =
    contextTarget === null ? -1 : tabs.findIndex((tab) => tab.id === contextTarget.id);
  const contextTab = contextIndex === -1 ? null : tabs[contextIndex];

  return (
    <div
      className={draggingId === null ? "tabbar" : "tabbar tabs-dragging"}
      onDoubleClick={handleBackgroundDoubleClick}
    >
      {overflow.any && (
        <button
          className="tab-scroll-btn"
          onClick={() => scrollPage(-1)}
          disabled={!overflow.left}
          title="Scroll tabs"
          aria-label="Scroll tabs left"
        >
          ‹
        </button>
      )}

      <div className="tabbar-scroll" ref={scrollRef} onScroll={measure} onWheel={handleWheel}>
        {tabs.map((tab, index) => {
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
                tab.id === draggingId ? "tabs-drag-source" : "",
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
              onPointerDown={(e) => handleTabPointerDown(e, tab, index)}
              onContextMenu={(e) => {
                e.preventDefault();
                setMenuOpen(false);
                setContextTarget({ id: tab.id, x: e.clientX, y: e.clientY });
              }}
            >
              <button
                className="tab-label"
                onClick={() => handleLabelClick(tab.id)}
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
                title={withKbd("Close tab", "Mod+W")}
                aria-label={`Close ${tab.label}`}
              >
                ×
              </button>
            </div>
          );
        })}

        {indicatorX !== null && (
          <div className="tabs-drop-indicator" style={{ left: indicatorX }} aria-hidden="true" />
        )}
      </div>

      {overflow.any && (
        <button
          className="tab-scroll-btn"
          onClick={() => scrollPage(1)}
          disabled={!overflow.right}
          title="Scroll tabs"
          aria-label="Scroll tabs right"
        >
          ›
        </button>
      )}

      <button
        className="tab-new"
        onClick={onNewTab}
        title={withKbd("New tab", "Mod+T")}
        aria-label="New tab"
      >
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

      {contextTarget !== null && contextTab !== null && (
        <TabContextMenu
          x={contextTarget.x}
          y={contextTarget.y}
          tab={contextTab}
          canCloseToRight={contextIndex < tabs.length - 1}
          canCloseOthers={tabs.length > 1}
          onDismiss={() => setContextTarget(null)}
          onCloseTab={() => onClose(contextTab.id)}
          onCloseOthers={() => onCloseOthers(contextTab.id)}
          onCloseToRight={() => onCloseToRight(contextTab.id)}
          onCopyPath={() => onCopyPath(contextTab.id)}
          onRevealInFinder={() => onRevealInFinder(contextTab.id)}
        />
      )}
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
        title="Open tabs"
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
