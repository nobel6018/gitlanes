// 쓰기 결과 알림. 계약: CONTRACTS.md v0.18 "공용 UI 규약".
// 성공은 3초 자동 소멸, 실패는 수동 닫기 + stderr 펼치기 + needsAuth면 터미널 핸드오프.
import { Fragment, useEffect, useRef, useState, type CSSProperties } from "react";
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
  /**
   * "Run in terminal"이 실제로 보낼 한 줄 (`git -C <레포> ...`, 인용 포함).
   * 화면 문구와 실행 명령이 어긋나지 않게 셸이 formatCommand로 만들어 넘긴다.
   * 없으면 인자를 공백으로 이어 보여준다
   */
  commandLine?: string;
  /** stderr가 인증/권한 실패로 보이면 true */
  needsAuth?: boolean;
  /**
   * 원격이 403으로 거절하며 밝힌 계정 (OpResult.deniedAccount). 있으면 "다른 계정으로
   * 인증됐다"는 힌트를 붙인다. 터미널로 넘겨도 같은 credential helper가 같은 계정을
   * 내놓으므로 needsAuth와 별개로 보여준다
   */
  deniedAccount?: string;
  /** 내장 PTY로 명령을 넘겨 사용자의 진짜 셸에서 실행시킨다 */
  onRunInTerminal?: (command: string[]) => void;
}

/**
 * 실패 토스트가 자동으로 사라지면 안 되는 이유: git stderr는 사용자가 읽고
 * 판단해야 하는 유일한 단서다. 3초 뒤에 지우면 무슨 일이 났는지 알 길이 없다.
 */
/** 403 계정 힌트 문구. 백틱으로 감싼 부분은 명령이라 등폭으로 그린다 */
export function deniedAccountHint(account: string): string {
  return `Signed in as ${account}, which can't access this repository. If you use the GitHub CLI, run \`gh auth switch\` and try again.`;
}

const HINT_STYLE: CSSProperties = { marginTop: 5, color: "var(--fg-1)", wordBreak: "break-word" };
const CODE_STYLE: CSSProperties = { fontFamily: "var(--font-mono)", fontSize: "0.92em" };

/** 백틱 구간을 <code>로 바꿔 그린다 */
function renderInlineCode(text: string) {
  return text.split("`").map((part, i) =>
    i % 2 === 1 ? (
      <code key={i} style={CODE_STYLE}>
        {part}
      </code>
    ) : (
      <Fragment key={i}>{part}</Fragment>
    ),
  );
}

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
  commandLine,
  needsAuth,
  deniedAccount,
  onRunInTerminal,
}: ToastProps) {
  const [copied, setCopied] = useState(false);
  const ms = resolveDuration(tone, durationMs);

  // ToastStack은 렌더마다 onClose를 새로 만든다. 의존성에 넣으면 워크스페이스가 다시
  // 그려질 때마다(검색창 타이핑 등) 타이머가 처음부터 돌아 토스트가 안 닫힌다 (audit-state L2).
  // 최신 콜백은 ref로 읽고 타이머는 메시지와 수명이 바뀔 때만 다시 건다
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (ms <= 0) {
      return;
    }
    const timer = window.setTimeout(() => onCloseRef.current(), ms);
    return () => window.clearTimeout(timer);
  }, [message, ms]);

  const hasStderr = stderr !== undefined && stderr.trim() !== "";
  const cmdLine =
    commandLine ??
    (command === undefined || command.length === 0 ? null : `git ${command.join(" ")}`);
  const hint =
    deniedAccount !== undefined && deniedAccount !== "" ? deniedAccountHint(deniedAccount) : null;
  const copyPayload = [message, hint, hasStderr ? stderr : null]
    .filter((part): part is string => part !== null && part !== undefined)
    .join("\n\n");

  return (
    <div className={`toast ${tone}`} role="alert">
      <span className="toast-icon">{tone === "error" ? "!" : "✓"}</span>
      <div className="toast-main">
        <div className="toast-title selectable">{message}</div>
        {hint !== null && (
          // actions.css는 이 패키지 소유가 아니라 기존 토큰으로 인라인 스타일만 준다
          <div className="toast-hint selectable" style={HINT_STYLE}>
            {renderInlineCode(hint)}
          </div>
        )}
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

/**
 * 스택이 max를 넘으면 버릴 항목을 고른다. 오래된 성공/정보 토스트부터 버리고, 오류는 그것이
 * 다 떨어졌을 때만 오래된 순으로 버린다. 오류 토스트는 수동으로만 닫히는데, 이렇게 하지 않으면
 * 뒤이은 성공 토스트 몇 개에 밀려 사용자가 읽기도 전에 사라진다
 */
export function trimToasts<T extends { tone: ToastTone }>(items: T[], max: number): T[] {
  let excess = items.length - max;
  if (excess <= 0) {
    return items;
  }
  const drop = new Set<number>();
  for (let i = 0; i < items.length && excess > 0; i += 1) {
    if (items[i].tone !== "error") {
      drop.add(i);
      excess -= 1;
    }
  }
  for (let i = 0; i < items.length && excess > 0; i += 1) {
    if (!drop.has(i)) {
      drop.add(i);
      excess -= 1;
    }
  }
  return items.filter((_, i) => !drop.has(i));
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
