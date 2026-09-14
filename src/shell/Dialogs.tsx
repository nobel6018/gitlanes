// 쓰기 작업 안전장치 다이얼로그. 계약: CONTRACTS.md v0.18 ui-actions.
// 배경 요소는 항상 .ov-backdrop 클래스를 쓴다 (셸의 Esc 단계 판정이 이 클래스를 본다).
import { useEffect, useRef, useState } from "react";
import type { KeyboardEvent, MouseEvent, ReactNode } from "react";
import "./panels.css";
import "./actions.css";

/**
 * 파괴적 작업 확인에 필요한 최소 정보.
 * undo를 필수 필드로 둔 이유: "되돌릴 수 있는가"를 다이얼로그를 쓰는 쪽이
 * 반드시 한 번 생각하게 만들려는 것이다. 비워 둘 수 있으면 아무도 안 적는다.
 */
export interface ConfirmSpec {
  title: string;
  /** 무슨 일이 일어나는지 한 문장 */
  body: string;
  /** 되돌리는 방법 한 줄. 되돌릴 수 없으면 그렇게 적는다 */
  undo: string;
  /** 영향 범위. "12 files" 같은 것. 없으면 null */
  scope?: string | null;
  confirmLabel: string;
  /** 되돌릴 수 없는 작업. 확인 버튼이 빨개지고 포커스가 취소로 간다 */
  danger?: boolean;
}

export interface ConfirmDialogProps {
  open: boolean;
  spec: ConfirmSpec;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmDialog({ open, spec, onConfirm, onCancel }: ConfirmDialogProps) {
  const confirmRef = useRef<HTMLButtonElement | null>(null);
  const cancelRef = useRef<HTMLButtonElement | null>(null);

  // danger면 실수 방지를 위해 취소 버튼에 포커스를 준다
  useEffect(() => {
    if (!open) {
      return;
    }
    if (spec.danger) {
      cancelRef.current?.focus();
    } else {
      confirmRef.current?.focus();
    }
  }, [open, spec.danger]);

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
    // danger는 Enter로 확정되지 않는다. 엔터 연타로 파일을 날리는 사고를 막는다
    if (event.key === "Enter" && !spec.danger) {
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
      <div className="dlg" role="dialog" aria-modal="true" aria-label={spec.title}>
        <h2 className="dlg-title">{spec.title}</h2>
        <div className="cd-body">
          {spec.body}
          {spec.scope !== null && <div className="cd-scope">{spec.scope}</div>}
          <div className={spec.danger ? "cd-undo danger" : "cd-undo"}>
            <span className="cd-undo-key">Undo</span>
            <span>{spec.undo}</span>
          </div>
        </div>
        <div className="dlg-actions">
          <button ref={cancelRef} className="dlg-btn" onClick={onCancel}>
            Cancel
          </button>
          <button
            ref={confirmRef}
            className={spec.danger ? "dlg-btn primary danger" : "dlg-btn primary"}
            onClick={onConfirm}
          >
            {spec.confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

export interface DialogFrameProps {
  open: boolean;
  title: string;
  onClose: () => void;
  /** Enter로 확정. 비활성이면 아무 일도 안 한다 */
  onSubmit?: () => void;
  submitLabel?: string;
  /** 확정을 막는 사유. null이면 확정 가능. 이 문구는 폼 아래에 그대로 뜬다 */
  disabledReason?: string | null;
  /** 사유를 보여주지 않고 확정만 막는다. 아직 아무것도 입력하지 않은 초기 상태용 */
  blocked?: boolean;
  danger?: boolean;
  /** 액션 줄 왼쪽에 끼워 넣을 버튼 (Unset upstream 등) */
  aside?: ReactNode;
  wide?: boolean;
  children: ReactNode;
}

/**
 * 폼 다이얼로그 공통 껍데기. Esc / 바깥 클릭 / × 로 닫히고 Enter로 확정한다.
 * form을 쓰므로 textarea 안의 Enter는 줄바꿈으로 남고 input의 Enter만 제출이 된다.
 */
export function DialogFrame({
  open,
  title,
  onClose,
  onSubmit,
  submitLabel,
  disabledReason,
  blocked,
  danger,
  aside,
  wide,
  children,
}: DialogFrameProps) {
  if (!open) {
    return null;
  }

  const shown = disabledReason !== undefined && disabledReason !== null;
  const stop = shown || blocked === true;

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape") {
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
      className="ov-backdrop dlg-backdrop"
      onMouseDown={handleBackdrop}
      onKeyDown={handleKeyDown}
      role="presentation"
    >
      <form
        className={wide === true ? "dlg wide" : "dlg"}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onSubmit={(event) => {
          event.preventDefault();
          if (!stop) {
            onSubmit?.();
          }
        }}
      >
        <div className="dlg-head">
          <h2 className="dlg-title">{title}</h2>
          <button type="button" className="dlg-x" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>
        {children}
        {shown && (
          <div className="dlg-error" role="alert">
            {disabledReason}
          </div>
        )}
        <div className="dlg-actions">
          {aside}
          <span style={{ flex: "1 1 auto" }} />
          <button type="button" className="dlg-btn" onClick={onClose}>
            Cancel
          </button>
          {onSubmit !== undefined && (
            <button
              type="submit"
              className={danger === true ? "dlg-btn primary danger" : "dlg-btn primary"}
              disabled={stop}
            >
              {submitLabel ?? "OK"}
            </button>
          )}
        </div>
      </form>
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
