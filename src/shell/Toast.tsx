// 쓰기 결과 알림. 계약: CONTRACTS.md v0.18 "공용 UI 규약".
// 성공은 3초 자동 소멸, 실패는 수동 닫기 + stderr 펼치기 + needsAuth면 터미널 핸드오프.
import { useEffect, useState } from "react";
import { copyText } from "./clipboard";
import "./actions.css";

/** 성공/정보 토스트의 기본 수명. 실패는 사용자가 닫을 때까지 남는다 */
const AUTO_DISMISS_MS = 3000;

export type ToastTone = "error" | "info" | "success";

export interface ToastProps {
  /** 한 줄 제목. 실패면 "Push failed" 처럼 무엇이 실패했는지 */
  message: string;
  /** error는 붉은 테두리, success는 초록, info는 중립 알림 */
  tone: ToastTone;
  onClose: () => void;
  /**
   * 자동 소멸까지의 시간. 생략하면 error는 자동으로 사라지지 않고
   * 나머지는 3초 뒤 사라진다. 0을 주면 어떤 톤이든 수동 닫기가 된다
   */
  durationMs?: number;
  /** 메시지 복사 버튼을 붙인다 (git 오류 원문용) */
  copyable?: boolean;
  /** git stderr 원문. 등폭 폰트로 접어서 보여준다 */
  stderr?: string;
  /** 실제로 실행한 git 인자. 터미널 핸드오프에 그대로 넘긴다 */
  command?: string[];
  /** stderr가 인증/권한 실패로 보이면 true */
  needsAuth?: boolean;
  /** 내장 PTY로 명령을 넘겨 사용자의 진짜 셸에서 실행시킨다 */
  onRunInTerminal?: (command: string[]) => void;
}

/**
 * 실패 토스트가 자동으로 사라지면 안 되는 이유: git stderr는 사용자가 읽고
 * 판단해야 하는 유일한 단서다. 3초 뒤에 지우면 무슨 일이 났는지 알 길이 없다.
 */
function resolveDuration(tone: ToastTone, durationMs: number | undefined): number {
  if (durationMs !== undefined) {
    return durationMs;
  }
  return tone === "error" ? 0 : AUTO_DISMISS_MS;
}

export function Toast({
  message,
  tone,
  onClose,
  durationMs,
  copyable,
  stderr,
  command,
  needsAuth,
  onRunInTerminal,
}: ToastProps) {
  const [copied, setCopied] = useState(false);
  const ms = resolveDuration(tone, durationMs);

  useEffect(() => {
    if (ms <= 0) {
      return;
    }
    const timer = window.setTimeout(onClose, ms);
    return () => window.clearTimeout(timer);
  }, [message, onClose, ms]);

  const hasStderr = stderr !== undefined && stderr.trim() !== "";
  const cmdLine = command === undefined || command.length === 0 ? null : `git ${command.join(" ")}`;
  const copyPayload = hasStderr ? `${message}\n\n${stderr}` : message;

  return (
    <div className={`toast ${tone}`} role="alert">
      <span className="toast-icon">{tone === "error" ? "!" : "✓"}</span>
      <div className="toast-main">
        <div className="toast-title selectable">{message}</div>
        {hasStderr && (
          <details className="toast-details">
            <summary>Show git output</summary>
            <pre className="toast-stderr selectable">{stderr}</pre>
          </details>
        )}
        {cmdLine !== null && <div className="toast-cmd selectable">{cmdLine}</div>}
        {(needsAuth === true || copyable === true) && (
          <div className="toast-actions">
            {needsAuth === true && command !== undefined && onRunInTerminal !== undefined && (
              <button
                className="toast-run"
                title="Git could not prompt for credentials. Re-run it in a real shell."
                onClick={() => onRunInTerminal(command)}
              >
                Run in terminal
              </button>
            )}
            {copyable === true && (
              <button
                className={copied ? "toast-copy copied" : "toast-copy"}
                title="Copy message"
                onClick={() => {
                  void copyText(copyPayload).then((ok) => setCopied(ok));
                }}
              >
                {copied ? "Copied" : "Copy"}
              </button>
            )}
          </div>
        )}
      </div>
      <button className="toast-close" onClick={onClose} title="Dismiss" aria-label="Dismiss">
        ×
      </button>
    </div>
  );
}

/** ToastStack이 관리하는 항목. id는 호출자가 증가시키는 정수면 된다 */
export interface ToastItem extends Omit<ToastProps, "onClose"> {
  id: number;
}

export interface ToastStackProps {
  items: ToastItem[];
  onClose: (id: number) => void;
}

/**
 * 우하단 스택. 여러 쓰기 작업이 잇달아 실패해도 앞선 메시지가 밀려나지 않게 쌓는다.
 * 최신 항목이 아래에 오도록 배열 순서 그대로 그린다.
 */
export function ToastStack({ items, onClose }: ToastStackProps) {
  if (items.length === 0) {
    return null;
  }
  return (
    <div className="toast-stack">
      {items.map((item) => {
        const { id, ...rest } = item;
        return <Toast key={id} {...rest} onClose={() => onClose(id)} />;
      })}
    </div>
  );
}
