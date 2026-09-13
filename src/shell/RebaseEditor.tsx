// 인터랙티브 리베이스 todo 에디터. 계약: CONTRACTS.md v0.18 ui-actions.
// steps 배열의 순서가 그대로 git todo 파일의 순서가 된다 (위 = 먼저 적용 = 과거).
import { useEffect, useMemo, useState } from "react";
import type { DragEvent, KeyboardEvent, MouseEvent } from "react";
import type { RebaseAction, RebaseStep } from "../types";
import "./actions.css";

const ACTIONS: { value: RebaseAction; label: string; hint: string }[] = [
  { value: "pick", label: "pick", hint: "Keep the commit as it is." },
  { value: "reword", label: "reword", hint: "Keep the changes, replace the message." },
  { value: "edit", label: "edit", hint: "Stop at this commit so you can amend it." },
  { value: "squash", label: "squash", hint: "Fold into the commit above, keeping both messages." },
  { value: "fixup", label: "fixup", hint: "Fold into the commit above, dropping this message." },
  { value: "drop", label: "drop", hint: "Remove the commit entirely." },
];

function isFolding(action: RebaseAction): boolean {
  return action === "squash" || action === "fixup";
}

/**
 * 첫 행이 squash/fixup이면 합칠 대상이 없어 git이 todo를 거부한다.
 * drop된 행은 사라지므로, 첫 "살아있는" 행을 기준으로 본다.
 */
function validate(steps: RebaseStep[]): string | null {
  const alive = steps.filter((s) => s.action !== "drop");
  if (alive.length === 0) {
    return "Every commit is dropped. There would be nothing to rebase.";
  }
  if (isFolding(alive[0].action)) {
    return "The first remaining commit cannot be squash or fixup. There is nothing above it to fold into.";
  }
  const emptyReword = steps.find(
    (s) => s.action === "reword" && (s.message === null || s.message.trim() === ""),
  );
  if (emptyReword !== undefined) {
    return `Reword needs a message for ${emptyReword.sha.slice(0, 7)}.`;
  }
  return null;
}

/**
 * from 행을 to 슬롯으로 옮긴다. 제거 후 to에 그대로 끼우면 아래로 끌 때는
 * 대상 뒤에, 위로 끌 때는 대상 앞에 놓여 드래그 방향과 결과가 일치한다.
 */
function move<T>(list: T[], from: number, to: number): T[] {
  if (from === to || from < 0 || to < 0 || from >= list.length || to >= list.length) {
    return list;
  }
  const next = list.slice();
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item);
  return next;
}

export interface RebaseEditorProps {
  open: boolean;
  onClose: () => void;
  /** 리베이스 기준점 (base). git rebase -i <base> 의 그 base */
  base: string;
  /** 초기 todo. 위가 과거, 아래가 현재. 보통 action은 전부 "pick" */
  steps: RebaseStep[];
  onSubmit: (steps: RebaseStep[]) => void;
  busy?: boolean;
}

export function RebaseEditor({ open, onClose, base, steps, onSubmit, busy }: RebaseEditorProps) {
  const [rows, setRows] = useState<RebaseStep[]>(steps);
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [overIndex, setOverIndex] = useState<number | null>(null);

  // 열릴 때마다 넘어온 todo로 되돌린다. 닫고 다시 열면 편집 내용은 버린다
  useEffect(() => {
    if (open) {
      setRows(steps);
      setDragIndex(null);
      setOverIndex(null);
    }
  }, [open, steps]);

  const problem = useMemo(() => validate(rows), [rows]);

  if (!open) {
    return null;
  }

  function setAction(index: number, action: RebaseAction) {
    setRows((prev) =>
      prev.map((row, i) => {
        if (i !== index) {
          return row;
        }
        // reword로 바꾸면 기존 subject를 초안으로 깔아 준다. 빈 칸부터 시작하면
        // 원문을 다시 찾아 적어야 한다
        const message =
          action === "reword" ? (row.message ?? row.subject) : action === "pick" ? null : row.message;
        return { ...row, action, message };
      }),
    );
  }

  function setMessage(index: number, message: string) {
    setRows((prev) => prev.map((row, i) => (i === index ? { ...row, message } : row)));
  }

  function handleDrop(target: number) {
    if (dragIndex !== null) {
      setRows((prev) => move(prev, dragIndex, target));
    }
    setDragIndex(null);
    setOverIndex(null);
  }

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

  function onRowDragOver(event: DragEvent<HTMLDivElement>, index: number) {
    event.preventDefault();
    setOverIndex(index);
  }

  return (
    <div
      className="ov-backdrop rbe-backdrop"
      onMouseDown={handleBackdrop}
      onKeyDown={handleKeyDown}
      role="presentation"
    >
      <div className="rbe" role="dialog" aria-modal="true" aria-label="Interactive rebase">
        <div className="dlg-head">
          <h2 className="dlg-title">Interactive rebase onto {base}</h2>
          <button type="button" className="dlg-x" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>
        <div className="dlg-note">
          The top row is applied first, so the list runs oldest to newest. Drag a row to reorder it,
          and squash or fixup folds a commit into the one above it.
        </div>

        <div className="rbe-list">
          {rows.map((row, index) => {
            const folded = isFolding(row.action);
            const classes = [
              "rbe-row",
              index === dragIndex ? "dragging" : "",
              index === overIndex && index !== dragIndex ? "over" : "",
              row.action === "drop" ? "dropped" : "",
              folded ? "folded" : "",
            ]
              .filter((c) => c !== "")
              .join(" ");
            return (
              <div key={row.sha}>
                <div
                  className={classes}
                  draggable
                  onDragStart={() => setDragIndex(index)}
                  onDragEnd={() => {
                    setDragIndex(null);
                    setOverIndex(null);
                  }}
                  onDragOver={(e) => onRowDragOver(e, index)}
                  onDrop={(e) => {
                    e.preventDefault();
                    handleDrop(index);
                  }}
                >
                  <span className="rbe-grip" aria-hidden="true">
                    ⠿
                  </span>
                  <select
                    className="rbe-action"
                    value={row.action}
                    aria-label={`Action for ${row.sha.slice(0, 7)}`}
                    title={ACTIONS.find((a) => a.value === row.action)?.hint}
                    onChange={(e) => setAction(index, e.target.value as RebaseAction)}
                  >
                    {ACTIONS.map((a) => (
                      <option key={a.value} value={a.value} title={a.hint}>
                        {a.label}
                      </option>
                    ))}
                  </select>
                  <span className="rbe-sha">{row.sha.slice(0, 7)}</span>
                  <span className="rbe-subject" title={row.subject}>
                    {row.subject}
                  </span>
                </div>
                {row.action === "reword" && (
                  <div className="rbe-reword">
                    <textarea
                      value={row.message ?? ""}
                      aria-label={`New message for ${row.sha.slice(0, 7)}`}
                      placeholder="New commit message"
                      onChange={(e) => setMessage(index, e.target.value)}
                    />
                  </div>
                )}
              </div>
            );
          })}
        </div>

        <div className="rbe-foot">
          <span className="rbe-why">{problem}</span>
          <button type="button" className="dlg-btn" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="dlg-btn primary"
            disabled={problem !== null || busy === true}
            onClick={() => onSubmit(rows)}
          >
            Start rebase
          </button>
        </div>
      </div>
    </div>
  );
}
