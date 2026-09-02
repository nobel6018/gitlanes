import { Fragment, useEffect, useLayoutEffect, useRef, useState } from "react";

export interface MenuItem {
  label: string;
  /** 회색으로 표시하고 클릭을 무시한다. 이유는 title로 알린다 */
  disabled?: boolean;
  onSelect: () => void;
  /** 이 항목 바로 위에 구분선을 그린다 */
  separatorBefore?: boolean;
  /** 파괴적 동작(삭제 등). 라벨을 var(--deleted)로 그린다 */
  danger?: boolean;
  /** 항목 툴팁. 비활성 이유를 적는 데 쓴다 */
  title?: string;
}

export interface ContextMenuProps {
  x: number;
  y: number;
  items: MenuItem[];
  onClose: () => void;
}

/** 화면 밖으로 나가지 않게 보정하는 여백(px) */
const EDGE_MARGIN = 6;

export function ContextMenu({ x, y, items, onClose }: ContextMenuProps) {
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState({ left: x, top: y });

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
  }, [x, y, items.length]);

  useEffect(() => {
    const onPointerDown = (event: MouseEvent) => {
      const el = menuRef.current;
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
    // capture 단계로 받아야 메뉴 밖 클릭이 다른 핸들러보다 먼저 닫는다
    window.addEventListener("mousedown", onPointerDown, true);
    window.addEventListener("contextmenu", onPointerDown, true);
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("blur", onClose);
    return () => {
      window.removeEventListener("mousedown", onPointerDown, true);
      window.removeEventListener("contextmenu", onPointerDown, true);
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("blur", onClose);
    };
  }, [onClose]);

  return (
    <div
      ref={menuRef}
      className="context-menu"
      role="menu"
      style={{ left: pos.left, top: pos.top }}
    >
      {items.map((item) => (
        <Fragment key={item.label}>
          {item.separatorBefore === true && <div className="context-sep" role="separator" />}
          <button
            className={item.danger === true ? "context-item danger" : "context-item"}
            role="menuitem"
            title={item.title}
            disabled={item.disabled === true}
            onClick={() => {
              onClose();
              item.onSelect();
            }}
          >
            {item.label}
          </button>
        </Fragment>
      ))}
    </div>
  );
}
