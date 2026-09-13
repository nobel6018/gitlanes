import { Fragment, useEffect, useLayoutEffect, useRef, useState } from "react";

export interface MenuItem {
  label: string;
  /** 회색으로 표시하고 클릭을 무시한다. 이유는 title로 알린다 */
  disabled?: boolean;
  /** 서브메뉴(children)를 가진 항목은 생략한다. 잎 항목에서는 필수다 */
  onSelect?: () => void;
  /** 이 항목 바로 위에 구분선을 그린다 */
  separatorBefore?: boolean;
  /** 파괴적 동작(삭제 등). 라벨을 var(--deleted)로 그린다 */
  danger?: boolean;
  /** 항목 툴팁. 비활성 이유를 적는 데 쓴다 */
  title?: string;
  /**
   * 서브메뉴. 있으면 onSelect는 무시되고 hover/클릭으로 오른쪽에 펼친다.
   * 중첩은 한 단계까지만 쓴다 (Reset ▸ Soft / Mixed / Hard).
   */
  children?: MenuItem[];
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
  /** 펼쳐 둔 서브메뉴의 라벨. 한 번에 하나만 열린다 */
  const [openSub, setOpenSub] = useState<string | null>(null);

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
          {item.children === undefined ? (
            <button
              className={item.danger === true ? "context-item danger" : "context-item"}
              role="menuitem"
              title={item.title}
              disabled={item.disabled === true}
              onClick={() => {
                onClose();
                item.onSelect?.();
              }}
            >
              {item.label}
            </button>
          ) : (
            <div
              className="context-sub"
              onMouseEnter={() => setOpenSub(item.label)}
              onMouseLeave={() => setOpenSub((prev) => (prev === item.label ? null : prev))}
            >
              <button
                className={item.danger === true ? "context-item danger" : "context-item"}
                role="menuitem"
                title={item.title}
                disabled={item.disabled === true}
                aria-haspopup="menu"
                aria-expanded={openSub === item.label}
                onClick={() => setOpenSub((prev) => (prev === item.label ? null : item.label))}
              >
                {item.label}
                <span className="context-caret" aria-hidden="true">
                  {"\u25b8"}
                </span>
              </button>
              {openSub === item.label && (
                <div className="context-menu context-submenu" role="menu">
                  {item.children.map((child) => (
                    <button
                      key={child.label}
                      className={child.danger === true ? "context-item danger" : "context-item"}
                      role="menuitem"
                      title={child.title}
                      disabled={child.disabled === true}
                      onClick={() => {
                        onClose();
                        child.onSelect?.();
                      }}
                    >
                      {child.label}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
        </Fragment>
      ))}
    </div>
  );
}
