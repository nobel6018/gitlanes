// 쓰기 작업 안전장치 다이얼로그. 계약: CONTRACTS.md v0.15 ui-panels.
// 배경 요소는 항상 .ov-backdrop 클래스를 쓴다 (셸의 Esc 단계 판정이 이 클래스를 본다).
import { useEffect, useRef, useState } from "react";
import type { KeyboardEvent, MouseEvent, ReactNode } from "react";
import "./panels.css";

export interface ConfirmDialogProps {
  open: boolean;
  title: string;
  body: ReactNode;
  confirmLabel: string;
  /** 되돌릴 수 없는 작업. 확인 버튼이 빨개지고 포커스는 취소에 놓인다 */
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmDialog({
  open,
  title,
  body,
  confirmLabel,
  danger,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const confirmRef = useRef<HTMLButtonElement | null>(null);
  const cancelRef = useRef<HTMLButtonElement | null>(null);

  // danger면 실수 방지를 위해 취소 버튼에 포커스를 준다
  useEffect(() => {
    if (!open) {
      return;
    }
    if (danger === true) {
      cancelRef.current?.focus();
    } else {
      confirmRef.current?.focus();
    }
  }, [open, danger]);

  if (!open) {
    return null;
  }

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape") {
      event.stopPropagation();
      event.preventDefault();
      onCancel();
      return;
    }
    if (event.key === "Enter") {
      event.stopPropagation();
      event.preventDefault();
      onConfirm();
    }
  }

  function handleBackdrop(event: MouseEvent<HTMLDivElement>) {
    if (event.target === event.currentTarget) {
      onCancel();
    }
  }

  return (
    <div
      className="ov-backdrop dlg-backdrop"
      onMouseDown={handleBackdrop}
      onKeyDown={handleKeyDown}
      role="presentation"
    >
      <div className="dlg" role="dialog" aria-modal="true" aria-label={title}>
        <h2 className="dlg-title">{title}</h2>
        <div className="dlg-body">{body}</div>
        <div className="dlg-actions">
          <button ref={cancelRef} className="dlg-btn" onClick={onCancel}>
            Cancel
          </button>
          <button
            ref={confirmRef}
            className={danger === true ? "dlg-btn primary danger" : "dlg-btn primary"}
            onClick={onConfirm}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

export interface PromptDialogProps {
  open: boolean;
  title: string;
  label: string;
  placeholder?: string;
  defaultValue?: string;
  /** 오류 메시지를 돌려주면 그걸 보여주고 확인을 막는다. 통과면 null */
  validate?: (value: string) => string | null;
  confirmLabel: string;
  onSubmit: (value: string) => void;
  onCancel: () => void;
  /** 체크박스 같은 추가 컨트롤 슬롯 (스태시의 "include untracked" 등) */
  extra?: ReactNode;
}

export function PromptDialog({
  open,
  title,
  label,
  placeholder,
  defaultValue,
  validate,
  confirmLabel,
  onSubmit,
  onCancel,
  extra,
}: PromptDialogProps) {
  const [value, setValue] = useState(defaultValue ?? "");
  const inputRef = useRef<HTMLInputElement | null>(null);

  // 열릴 때마다 기본값으로 되돌리고 전체 선택 상태로 포커스
  useEffect(() => {
    if (!open) {
      return;
    }
    setValue(defaultValue ?? "");
    const input = inputRef.current;
    if (input !== null) {
      input.focus();
      input.select();
    }
  }, [open, defaultValue]);

  if (!open) {
    return null;
  }

  const error = validate === undefined ? null : validate(value);

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape") {
      event.stopPropagation();
      event.preventDefault();
      onCancel();
    }
  }

  function handleBackdrop(event: MouseEvent<HTMLDivElement>) {
    if (event.target === event.currentTarget) {
      onCancel();
    }
  }

  function submit() {
    if (error !== null) {
      return;
    }
    onSubmit(value);
  }

  return (
    <div
      className="ov-backdrop dlg-backdrop"
      onMouseDown={handleBackdrop}
      onKeyDown={handleKeyDown}
      role="presentation"
    >
      <form
        className="dlg"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <h2 className="dlg-title">{title}</h2>
        <label className="dlg-label" htmlFor="dlg-prompt-input">
          {label}
        </label>
        <input
          id="dlg-prompt-input"
          ref={inputRef}
          className={error === null ? "dlg-input" : "dlg-input bad"}
          value={value}
          placeholder={placeholder}
          onChange={(event) => setValue(event.target.value)}
          spellCheck={false}
          autoComplete="off"
          aria-invalid={error !== null}
          aria-describedby={error === null ? undefined : "dlg-prompt-error"}
        />
        {error !== null && (
          <div className="dlg-error" id="dlg-prompt-error" role="alert">
            {error}
          </div>
        )}
        {extra !== undefined && <div className="dlg-extra">{extra}</div>}
        <div className="dlg-actions">
          <button type="button" className="dlg-btn" onClick={onCancel}>
            Cancel
          </button>
          <button type="submit" className="dlg-btn primary" disabled={error !== null}>
            {confirmLabel}
          </button>
        </div>
      </form>
    </div>
  );
}
