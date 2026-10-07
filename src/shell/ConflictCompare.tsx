// 충돌 파일 하나의 3-way 비교 화면. base(공통 조상), ours, theirs 원문을 나란히 보여주고
// 그 자리에서 Use ours / Use theirs / Mark resolved를 누를 수 있다.
// 원문은 get_conflict_side(path, file, side)로 읽는다. 해당 stage가 없으면 ""(삭제된 쪽).
// 계약: CONTRACTS.md v0.16.1, src/types.ts의 get_conflict_side 주석
import { useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent, MouseEvent } from "react";
import type { ConflictFile, PendingKind } from "../types";
import { errorMessage, getConflictSide } from "./api";
import { FILE_KIND_LABEL, sideTooltip } from "./ConflictPanel";
import type { ConflictActions } from "./ConflictPanel";
import "./actions.css";
import "./conflict.css";

type Side = "base" | "ours" | "theirs";

const SIDES: Side[] = ["base", "ours", "theirs"];

/** 한 칸에 그리는 최대 줄 수. 수만 줄짜리 생성 파일이 DOM을 멈추지 않게 자른다 */
const MAX_LINES = 5000;

type SideState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; text: string };

const LOADING: Record<Side, SideState> = {
  base: { status: "loading" },
  ours: { status: "loading" },
  theirs: { status: "loading" },
};

/**
 * 칸 제목 아래 설명. 리베이스 중에는 ours/theirs가 뒤집히므로 그 사실을 칸 머리에 바로 적는다.
 * side 문자열 자체는 바꾸지 않는다. 바뀌는 것은 사람에게 보이는 설명뿐이다
 */
function sideCaption(side: Side, kind: PendingKind): string {
  if (side === "base") {
    return "Common ancestor";
  }
  if (kind === "rebase") {
    return side === "ours" ? "Upstream you are landing on" : "Your commit being replayed";
  }
  if (side === "ours") {
    return "Your current branch";
  }
  return kind === "conflicts" ? "Incoming stash or squashed branch" : "Incoming changes";
}

/** 빈 문자열은 그 쪽 stage가 없다는 뜻이다. bothAdded의 base는 지운 게 아니라 원래 없다 */
function missingLabel(side: Side, fileKind: ConflictFile["kind"]): string {
  if (side === "base" && fileKind === "bothAdded") {
    return "No common version. The file was added on both sides.";
  }
  return "Deleted on this side";
}

/** base에 없는 줄의 번호. 순서는 보지 않는 줄 단위 다중집합 비교라 대략적인 표시다 */
function linesNotIn(lines: string[], reference: string[]): Set<number> {
  const counts = new Map<string, number>();
  for (const line of reference) {
    counts.set(line, (counts.get(line) ?? 0) + 1);
  }
  const changed = new Set<number>();
  lines.forEach((line, index) => {
    const left = counts.get(line) ?? 0;
    if (left > 0) {
      counts.set(line, left - 1);
    } else {
      changed.add(index);
    }
  });
  return changed;
}

function splitLines(text: string): string[] {
  const lines = text.split("\n");
  // 끝 줄바꿈이 만든 빈 마지막 칸은 줄로 세지 않는다
  if (lines.length > 1 && lines[lines.length - 1] === "") {
    lines.pop();
  }
  return lines;
}

export interface ConflictCompareProps {
  /** 레포 경로. get_conflict_side에 그대로 넘긴다 */
  repoPath: string;
  file: ConflictFile;
  /** 진행 중인 작업 종류. 리베이스면 ours/theirs 안내가 뒤집힌다 */
  kind: PendingKind;
  actions: ConflictActions;
  onClose: () => void;
}

export function ConflictCompare({ repoPath, file, kind, actions, onClose }: ConflictCompareProps) {
  const [sides, setSides] = useState<Record<Side, SideState>>(LOADING);
  /** 좁은 창에서 탭으로 보여줄 칸. 넓으면 세 칸이 다 보여 의미가 없다 */
  const [tab, setTab] = useState<Side>("ours");
  const dialogRef = useRef<HTMLDivElement | null>(null);

  // 열리자마자 포커스를 가져와야 Esc가 이 화면에서 먼저 처리된다
  useEffect(() => {
    dialogRef.current?.focus();
  }, []);

  useEffect(() => {
    let alive = true;
    setSides(LOADING);
    for (const side of SIDES) {
      getConflictSide(repoPath, file.path, side)
        .then((text): SideState => ({ status: "ready", text }))
        .catch((err: unknown): SideState => ({ status: "error", message: errorMessage(err) }))
        .then((state) => {
          if (alive) {
            setSides((prev) => ({ ...prev, [side]: state }));
          }
        });
    }
    return () => {
      alive = false;
    };
  }, [repoPath, file.path]);

  const baseLines = useMemo(
    () => (sides.base.status === "ready" ? splitLines(sides.base.text) : null),
    [sides.base],
  );

  const busy = actions.busy;
  const rebasing = kind === "rebase";

  function run(task: Promise<void>) {
    void task.catch(() => undefined);
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

  function renderPane(side: Side) {
    const state = sides[side];
    let body;
    if (state.status === "loading") {
      body = <div className="cfc-msg">Loading{"…"}</div>;
    } else if (state.status === "error") {
      body = <div className="cfc-msg error">{state.message}</div>;
    } else if (state.text === "") {
      body = <div className="cfc-msg deleted">{missingLabel(side, file.kind)}</div>;
    } else {
      const lines = splitLines(state.text);
      const shown = lines.length > MAX_LINES ? lines.slice(0, MAX_LINES) : lines;
      const changed =
        side !== "base" && baseLines !== null && baseLines.length > 0
          ? linesNotIn(shown, baseLines)
          : null;
      body = (
        <pre className="cfc-code">
          {shown.map((line, index) => (
            <div className={changed?.has(index) ? "cfc-line chg" : "cfc-line"} key={index}>
              <span className="cfc-ln">{index + 1}</span>
              <span className="cfc-tx">{line === "" ? " " : line}</span>
            </div>
          ))}
          {lines.length > MAX_LINES && (
            <div className="cfc-more">
              {lines.length - MAX_LINES} more lines not shown. Open the file to see all of it.
            </div>
          )}
        </pre>
      );
    }
    return (
      <section
        className={side === tab ? "cfc-pane active" : "cfc-pane"}
        key={side}
        aria-label={`${side} version`}
      >
        <header
          className="cfc-pane-head"
          title={side === "base" ? undefined : sideTooltip(side, kind)}
        >
          <span className="cfc-pane-name">{side}</span>
          <span className="cfc-pane-cap">{sideCaption(side, kind)}</span>
        </header>
        {body}
      </section>
    );
  }

  return (
    <div
      className="ov-backdrop cfc-backdrop"
      onMouseDown={handleBackdrop}
      onKeyDown={handleKeyDown}
      role="presentation"
    >
      <div
        className="cfc"
        role="dialog"
        aria-modal="true"
        aria-label={`Compare conflict in ${file.path}`}
        tabIndex={-1}
        ref={dialogRef}
      >
        <div className="dlg-head">
          <h2 className="dlg-title cfc-title" title={file.path}>
            {file.path}
            <span className="cfc-kind">{FILE_KIND_LABEL[file.kind]}</span>
          </h2>
          <button type="button" className="dlg-x" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>
        {rebasing && (
          <div className="dlg-note cfc-warn">
            During a rebase, ours and theirs are swapped: ours is the upstream you are landing on,
            and theirs is your own commit being replayed.
          </div>
        )}
        <div className="cfc-tabs" role="tablist">
          {SIDES.map((side) => (
            <button
              type="button"
              role="tab"
              aria-selected={side === tab}
              className={side === tab ? "cfc-tab active" : "cfc-tab"}
              key={side}
              onClick={() => setTab(side)}
            >
              {side}
            </button>
          ))}
        </div>
        <div className="cfc-panes">{SIDES.map(renderPane)}</div>
        <div className="cfc-foot">
          <span className="cfc-legend">
            <span className="cfc-swatch" aria-hidden="true" /> Lines not found in base
          </span>
          <span className="cfc-actions">
            <button
              type="button"
              className="cfp-btn"
              disabled={busy}
              title={sideTooltip("ours", kind)}
              onClick={() => run(actions.resolveWith(file.path, "ours"))}
            >
              Use ours
            </button>
            <button
              type="button"
              className="cfp-btn"
              disabled={busy}
              title={sideTooltip("theirs", kind)}
              onClick={() => run(actions.resolveWith(file.path, "theirs"))}
            >
              Use theirs
            </button>
            <button
              type="button"
              className="cfp-btn primary"
              disabled={busy}
              title="Stage the file as it is on disk"
              onClick={() => run(actions.markResolved([file.path]))}
            >
              Mark resolved
            </button>
          </span>
        </div>
      </div>
    </div>
  );
}
