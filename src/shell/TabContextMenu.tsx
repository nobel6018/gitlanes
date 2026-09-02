import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { TabInfo } from "./TabBar";
import "./tabs.css";

export interface TabContextMenuProps {
  /** 우클릭 지점 (clientX/clientY) */
  x: number;
  y: number;
  /** 메뉴가 열린 대상 탭 */
  tab: TabInfo;
  /** 오른쪽에 닫을 탭이 남아 있는가 (마지막 탭이면 false) */
  canCloseToRight: boolean;
  /** 자기 말고 닫을 탭이 있는가 (탭이 하나뿐이면 false) */
  canCloseOthers: boolean;
  /** 메뉴만 닫는다 (바깥 클릭/Esc/창 blur/항목 선택 후) */
  onDismiss: () => void;
  onCloseTab: () => void;
  onCloseOthers: () => void;
  onCloseToRight: () => void;
  onCopyPath: () => void;
  onRevealInFinder: () => void;
}

/** 화면 밖으로 나가지 않게 두는 여백(px) */
const EDGE_MARGIN = 6;

type Entry = { kind: "sep" } | { kind: "item"; label: string; disabled: boolean; run: () => void };

export function TabContextMenu({
  x,
  y,
  tab,
  canCloseToRight,
  canCloseOthers,
  onDismiss,
  onCloseTab,
  onCloseOthers,
  onCloseToRight,
  onCopyPath,
  onRevealInFinder,
}: TabContextMenuProps) {
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState({ left: x, top: y });

  // 아직 레포를 열지 않은 탭은 경로가 없으니 경로 관련 항목을 막는다
  const hasPath = tab.path !== null;

  const entries: Entry[] = [
    { kind: "item", label: "Close", disabled: false, run: onCloseTab },
    { kind: "item", label: "Close Others", disabled: !canCloseOthers, run: onCloseOthers },
    {
      kind: "item",
      label: "Close Tabs to the Right",
      disabled: !canCloseToRight,
      run: onCloseToRight,
    },
    { kind: "sep" },
    { kind: "item", label: "Copy Path", disabled: !hasPath, run: onCopyPath },
    { kind: "item", label: "Reveal in Finder", disabled: !hasPath, run: onRevealInFinder },
  ];

  // 실제 크기를 잰 뒤 뷰포트 안으로 밀어넣는다
  useLayoutEffect(() => {
    const el = menuRef.current;
    if (el === null) {
      return;
    }
    const { width, height } = el.getBoundingClientRect();
    const maxLeft = window.innerWidth - width - EDGE_MARGIN;
    const maxTop = window.innerHeight - height - EDGE_MARGIN;
    setPos({
      left: Math.max(EDGE_MARGIN, Math.min(x, maxLeft)),
      top: Math.max(EDGE_MARGIN, Math.min(y, maxTop)),
    });
  }, [x, y]);

  useEffect(() => {
    const onOutside = (event: MouseEvent) => {
      const el = menuRef.current;
      if (el !== null && event.target instanceof Node && el.contains(event.target)) {
        return;
      }
      onDismiss();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onDismiss();
      }
    };
    // capture 단계로 받아야 메뉴 밖 클릭이 다른 핸들러보다 먼저 닫는다
    window.addEventListener("mousedown", onOutside, true);
    window.addEventListener("contextmenu", onOutside, true);
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("blur", onDismiss);
    return () => {
      window.removeEventListener("mousedown", onOutside, true);
      window.removeEventListener("contextmenu", onOutside, true);
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("blur", onDismiss);
    };
  }, [onDismiss]);

  return (
    <div ref={menuRef} className="tabs-menu" role="menu" style={{ left: pos.left, top: pos.top }}>
      {entries.map((entry, index) =>
        entry.kind === "sep" ? (
          <div key={`sep-${index}`} className="tabs-menu-sep" role="separator" />
        ) : (
          <button
            key={entry.label}
            className="tabs-menu-item"
            role="menuitem"
            disabled={entry.disabled}
            onClick={() => {
              onDismiss();
              entry.run();
            }}
          >
            {entry.label}
          </button>
        ),
      )}
    </div>
  );
}
