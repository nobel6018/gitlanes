import { useEffect } from "react";

const AUTO_DISMISS_MS = 4000;

export interface ToastProps {
  message: string;
  onClose: () => void;
}

/** 상단에서 슬라이드로 등장하는 오류 토스트. 4초 뒤 자동 소멸. */
export function Toast({ message, onClose }: ToastProps) {
  useEffect(() => {
    const timer = window.setTimeout(onClose, AUTO_DISMISS_MS);
    return () => window.clearTimeout(timer);
  }, [message, onClose]);

  return (
    <div className="toast" role="alert">
      <span className="toast-icon">!</span>
      <span className="toast-message selectable">{message}</span>
      <button className="toast-close" onClick={onClose} title="Dismiss">
        ×
      </button>
    </div>
  );
}
