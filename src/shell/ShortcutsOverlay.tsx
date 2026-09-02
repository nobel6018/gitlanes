// 단축키 치트시트 오버레이. 표시 목록은 CONTRACTS.md v0.11 "최종 표"를 옮긴 내부 상수다.
// 계약: ShortcutsOverlay(props: { open, onClose, platform }) — open=false면 null.
import { useEffect, useRef } from "react";
import type { KeyboardEvent, MouseEvent } from "react";
import { kbd, withKbd } from "./shortcuts";
import "./panels.css";

export interface ShortcutsOverlayProps {
  open: boolean;
  onClose: () => void;
  platform: "mac" | "other";
}

interface Shortcut {
  /** 같은 동작의 대체 조합. 토큰을 "+"로 이어 쓴다 ("Mod+Shift+T") */
  combos: string[];
  label: string;
}

interface ShortcutGroup {
  title: string;
  items: Shortcut[];
}

/** Mod = macOS ⌘ / 그 외 Ctrl (네이티브 CmdOrCtrl과 같은 의미) */
const GROUPS: ShortcutGroup[] = [
  {
    title: "Tabs",
    items: [
      { combos: ["Mod+T"], label: "New tab" },
      { combos: ["Mod+W"], label: "Close tab" },
      { combos: ["Mod+Shift+T"], label: "Reopen closed tab" },
      { combos: ["Mod+1", "Mod+8"], label: "Go to tab 1–8" },
      { combos: ["Mod+9"], label: "Go to last tab" },
      { combos: ["Mod+Shift+[", "Mod+Shift+]"], label: "Previous / next tab" },
      { combos: ["Alt+Mod+Left", "Alt+Mod+Right"], label: "Previous / next tab" },
      { combos: ["Ctrl+Tab", "Ctrl+Shift+Tab"], label: "Cycle tabs" },
      { combos: ["Double-click tab bar"], label: "New tab" },
    ],
  },
  {
    title: "Navigation",
    items: [
      { combos: ["Mod+O"], label: "Open repository" },
      { combos: ["Mod+R"], label: "Refresh" },
      { combos: ["Mod+B"], label: "Toggle sidebar" },
      { combos: ["Mod+P"], label: "Quick switcher (branches, tags)" },
      { combos: ["Mod+Shift+H"], label: "Go to HEAD" },
      { combos: ["Up", "Down"], label: "Move selection" },
      { combos: ["Home", "Mod+Up"], label: "First commit" },
      { combos: ["End", "Mod+Down"], label: "Last commit" },
      { combos: ["PageUp", "PageDown"], label: "Move one screen" },
      { combos: ["Enter", "Right"], label: "Open diff (file list)" },
      { combos: ["Left", "Backspace"], label: "Back to file list (diff)" },
      { combos: ["Drop a folder"], label: "Open repository in a new tab" },
      { combos: ["Click DATE header"], label: "Toggle absolute / relative dates" },
    ],
  },
  {
    title: "Search",
    items: [
      { combos: ["Mod+F"], label: "Focus search" },
      { combos: ["Mod+Shift+F"], label: "Toggle filter mode" },
      { combos: ["Alt+Mod+F"], label: "Focus branch filter" },
      { combos: ["Enter"], label: "Next match" },
      { combos: ["Escape"], label: "Close overlay, clear search, clear selection" },
    ],
  },
  {
    title: "Edit",
    items: [
      { combos: ["Mod+C"], label: "Copy selected commit sha" },
      { combos: ["Mod+Shift+C"], label: "Copy commit message" },
      { combos: ["Double-click row"], label: "Copy sha" },
      { combos: ["Mod+=", "Mod+-"], label: "Zoom in / out" },
      { combos: ["Mod+0"], label: "Actual size" },
      { combos: ["Mod+/"], label: "This cheat sheet" },
    ],
  },
];

/**
 * 조합 표기는 공용 헬퍼 kbd()가 기준이다 (⌘⇧H / Ctrl+Shift+H).
 * 헬퍼가 모르는 키(PageUp, Backspace 등)만 platform prop으로 먼저 정규화해 넘긴다.
 */
const ALIASES: Record<string, string> = {
  Escape: "Esc",
};

const MAC_EXTRA: Record<string, string> = {
  Backspace: "⌫",
  PageUp: "PgUp",
  PageDown: "PgDn",
};

const OTHER_EXTRA: Record<string, string> = {
  PageUp: "PgUp",
  PageDown: "PgDn",
  // 화살표는 플랫폼과 무관하게 기호가 읽기 쉽다 (헬퍼는 비mac에서 텍스트로 흘린다)
  Up: "↑",
  Down: "↓",
  Left: "←",
  Right: "→",
};

function formatCombo(combo: string, platform: "mac" | "other"): string {
  const extra = platform === "mac" ? MAC_EXTRA : OTHER_EXTRA;
  const normalized = combo
    .split("+")
    .map((token) => {
      const aliased = ALIASES[token] ?? token;
      return extra[aliased] ?? aliased;
    })
    .join("+");
  return kbd(normalized);
}

export function ShortcutsOverlay({ open, onClose, platform }: ShortcutsOverlayProps) {
  const closeRef = useRef<HTMLButtonElement | null>(null);

  // 열릴 때 첫 요소(닫기 버튼)로 포커스를 옮긴다. 키 입력이 오버레이 안에서 잡힌다
  useEffect(() => {
    if (open) {
      closeRef.current?.focus();
    }
  }, [open]);

  if (!open) {
    return null;
  }

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape") {
      // shell의 전역 Esc 처리(검색 클리어 등)까지 번지지 않게 여기서 끊는다
      event.stopPropagation();
      event.preventDefault();
      onClose();
    }
  }

  function handleBackdrop(event: MouseEvent<HTMLDivElement>) {
    if (event.target === event.currentTarget) {
      onClose();
    }
  }

  return (
    <div
      className="ov-backdrop sc-backdrop"
      onMouseDown={handleBackdrop}
      onKeyDown={handleKeyDown}
      role="presentation"
    >
      <div className="sc-modal" role="dialog" aria-modal="true" aria-label="Keyboard shortcuts">
        <div className="sc-head">
          <h2 className="sc-title">Keyboard Shortcuts</h2>
          <button
            ref={closeRef}
            className="sc-close"
            onClick={onClose}
            title={withKbd("Close", "Esc")}
            aria-label="Close"
          >
            ×
          </button>
        </div>
        <div className="sc-body">
          {GROUPS.map((group) => (
            <section className="sc-group" key={group.title}>
              <h3 className="sc-group-title">{group.title}</h3>
              {group.items.map((item) => (
                <div className="sc-row" key={`${group.title}:${item.label}:${item.combos[0]}`}>
                  <span className="sc-keys">
                    {item.combos.map((combo, i) => {
                      const text = formatCombo(combo, platform);
                      return (
                        <span key={combo} className="sc-combo">
                          {i > 0 && <span className="sc-or"> / </span>}
                          <kbd className={text.length > 3 ? "sc-key wide" : "sc-key"}>{text}</kbd>
                        </span>
                      );
                    })}
                  </span>
                  <span className="sc-label">{item.label}</span>
                </div>
              ))}
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}
