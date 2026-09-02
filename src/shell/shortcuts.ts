// 단축키 표기 공용 헬퍼 (감독 소유). 버튼 title/placeholder에 단축키를 일관되게 붙인다.
// 사용: title={withKbd("Refresh", "Mod+R")}  →  "Refresh (⌘R)" / "Refresh (Ctrl+R)"

function detectMac(): boolean {
  if (typeof navigator === "undefined") {
    return false;
  }
  // navigator.platform은 deprecated라 빈 문자열일 수 있어 userAgentData → userAgent 순으로 폴백
  const uaData = (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData;
  const source = uaData?.platform || navigator.platform || navigator.userAgent;
  return /Mac|iPhone|iPad/i.test(source);
}

export const IS_MAC = detectMac();

const MAC_SYMBOLS: Record<string, string> = {
  Mod: "⌘",
  Cmd: "⌘",
  Shift: "⇧",
  Alt: "⌥",
  Option: "⌥",
  Ctrl: "⌃",
  Enter: "↩",
  Esc: "⎋",
  Up: "↑",
  Down: "↓",
  Left: "←",
  Right: "→",
};

/** "Mod+Shift+H" → mac "⌘⇧H", 그 외 "Ctrl+Shift+H" */
export function kbd(combo: string): string {
  const parts = combo.split("+");
  if (IS_MAC) {
    return parts.map((p) => MAC_SYMBOLS[p] ?? p).join("");
  }
  return parts.map((p) => (p === "Mod" || p === "Cmd" ? "Ctrl" : p)).join("+");
}

/** 라벨 뒤에 괄호로 단축키를 붙인다 */
export function withKbd(label: string, combo: string): string {
  return `${label} (${kbd(combo)})`;
}
