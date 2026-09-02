import { useEffect, useState } from "react";
import { copyText } from "./clipboard";

const AUTO_DISMISS_MS = 4000;

export interface ToastProps {
  message: string;
  /** error는 붉은 테두리, info는 중립 알림 */
  tone: "error" | "info";
  onClose: () => void;
  /** 기본 4초. git stderr처럼 읽을 게 많은 오류는 길게 준다 */
  durationMs?: number;
  /** 메시지 복사 버튼을 붙인다 (git 오류 원문용) */
  copyable?: boolean;
}

/** 상단에서 슬라이드로 등장하는 토스트. 기본 4초 뒤 자동 소멸. */
export function Toast({ message, tone, onClose, durationMs, copyable }: ToastProps) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    const timer = window.setTimeout(onClose, durationMs ?? AUTO_DISMISS_MS);
    return () => window.clearTimeout(timer);
  }, [message, onClose, durationMs]);

  return (
    <div className={`toast ${tone}`} role="alert">
      <span className="toast-icon">{tone === "error" ? "!" : "\u2713"}</span>
      <span className="toast-message selectable">{message}</span>
      {copyable === true && (
        <button
          className={copied ? "toast-copy copied" : "toast-copy"}
          title="Copy message"
          onClick={() => {
            void copyText(message).then((ok) => setCopied(ok));
          }}
        >
          {copied ? "Copied" : "Copy"}
        </button>
      )}
      <button className="toast-close" onClick={onClose} title="Dismiss">
        \u00d7
      </button>
    </div>
  );
}
