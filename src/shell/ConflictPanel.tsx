// 진행 중인 머지/리베이스/체리픽/리버트/am과 충돌 파일 해결 패널. 이어갈 작업 없이 충돌만
// 남은 상태("conflicts")도 같은 패널이 해결 UI만 그린다.
// 계약: CONTRACTS.md v0.18 ui-actions. 워크스페이스 상단에 가로로 놓인다.
import type { ConflictFile, PendingKind, PendingOp } from "../types";
import "./actions.css";

/** ui-hub RepoActions 중 충돌 패널이 쓰는 부분집합 */
export interface ConflictActions {
  resolveWith(file: string, side: "ours" | "theirs"): Promise<void>;
  markResolved(files: string[]): Promise<void>;
  pendingAction(action: "continue" | "abort" | "skip"): Promise<void>;
  busy: boolean;
}

const KIND_LABEL: Record<PendingKind, string> = {
  merge: "Merging",
  rebase: "Rebasing",
  cherryPick: "Cherry-picking",
  revert: "Reverting",
  am: "Applying patches",
  conflicts: "Resolving conflicts",
};

/**
 * null이면 이어갈 작업이 없어 Continue/Skip/Abort를 그리지 않는다. "conflicts"(squash 머지,
 * stash pop/apply 충돌)는 git에 진행 중인 작업이 없어 --continue도 --abort도 받을 대상이 없다.
 * 파일을 다 해결하면 Rust가 pending을 null로 돌려 패널이 스스로 사라진다
 */
const CONTINUE_LABEL: Record<PendingKind, string | null> = {
  merge: "Continue merge",
  rebase: "Continue rebase",
  cherryPick: "Continue cherry-pick",
  revert: "Continue revert",
  am: "Continue applying patches",
  conflicts: null,
};

/** Skip 버튼 문구. 한 단위를 건너뛸 수 있는 작업만 둔다 */
const SKIP_LABEL: Partial<Record<PendingKind, { label: string; title: string }>> = {
  rebase: { label: "Skip commit", title: "Drop the commit being replayed and move on" },
  am: { label: "Skip patch", title: "Drop the patch being applied and move on to the next one" },
};

const FILE_KIND_LABEL: Record<ConflictFile["kind"], string> = {
  bothModified: "both modified",
  bothAdded: "both added",
  deletedByUs: "deleted by us",
  deletedByThem: "deleted by them",
  bothDeleted: "both deleted",
};

/**
 * git의 고질적 함정: 리베이스 중에는 ours/theirs의 의미가 뒤집힌다.
 * 리베이스는 "올라타는 쪽"을 체크아웃한 다음 내 커밋을 그 위에 다시 얹기 때문에,
 * 이 시점의 HEAD(= ours)는 내 브랜치가 아니라 upstream이다.
 */
function sideTooltip(side: "ours" | "theirs", kind: PendingKind): string {
  const rebasing = kind === "rebase";
  if (side === "ours") {
    return rebasing
      ? "During a rebase, ours is the branch you are landing on (the upstream), not the branch being rebased."
      : "Ours is the branch you are currently on.";
  }
  if (rebasing) {
    return "During a rebase, theirs is the commit being replayed, which is your own work.";
  }
  // stash pop/apply 충돌이면 theirs는 스태시, squash 머지면 합친 브랜치다
  return kind === "conflicts"
    ? "Theirs is the incoming side: the stash being applied or the branch being squash merged."
    : "Theirs is the branch being merged in.";
}

export interface ConflictPanelProps {
  /** 진행 중 작업. null이면 패널 자체를 그리지 않는다 */
  pending: PendingOp | null;
  /** get_conflicts(path)의 결과 */
  files: ConflictFile[];
  actions: ConflictActions;
  /** 파일을 외부 편집기나 diff 패널에서 연다 */
  onOpenFile?: (path: string) => void;
}

export function ConflictPanel({ pending, files, actions, onOpenFile }: ConflictPanelProps) {
  if (pending === null) {
    return null;
  }

  const kind = pending.kind;
  // hasMarkers가 false면 사용자가 손으로 마커를 지웠다는 뜻이다. 해결로 간주하지 않고
  // 표시만 바꾼다. git 기준으로 unmerged인 한 여전히 add가 필요하다
  const unresolved = files.filter((f) => f.hasMarkers);
  const allResolved = files.length === 0;
  const busy = actions.busy;
  const continueLabel = CONTINUE_LABEL[kind];
  const skip = SKIP_LABEL[kind];

  // abort/skip은 파괴적이지만 확인 다이얼로그를 여기서 띄우지 않는다.
  // 파괴적 확인은 ui-hub의 RepoActions 한 곳에 모아 두는 게 이번 구조의 규칙이고
  // (계약 6번이 git_pending_action(abort)를 확인 필수로 올려 뒀다),
  // 양쪽이 다 띄우면 다이얼로그가 두 번 뜬다. 버튼의 위험 표시만 여기 남긴다.
  function run(task: Promise<void>) {
    void task.catch(() => undefined);
  }

  return (
    <div className="cfp">
      <div className={allResolved ? "cfp-head clean" : "cfp-head"}>
        <span className="cfp-kind">
          {KIND_LABEL[kind]}
          {pending.detail != null && pending.detail !== "" ? ` onto ${pending.detail}` : ""}
        </span>
        {pending.progress != null && pending.progress !== "" && (
          <span className="cfp-progress">{pending.progress}</span>
        )}
        <span className="cfp-summary">
          {allResolved
            ? continueLabel === null
              ? "No conflicts left."
              : "No conflicts left. Continue to finish the operation."
            : `${files.length} conflicted ${files.length === 1 ? "file" : "files"}` +
              (unresolved.length < files.length
                ? `, ${files.length - unresolved.length} edited by hand`
                : "")}
        </span>
        {continueLabel !== null && (
          <span className="cfp-head-actions">
            <button
              className="cfp-btn primary"
              disabled={!allResolved || busy}
              title={
                allResolved
                  ? "Stage is clean. Finish the operation."
                  : "Resolve every conflicted file first."
              }
              onClick={() => run(actions.pendingAction("continue"))}
            >
              {continueLabel}
            </button>
            {skip !== undefined && (
              <button
                className="cfp-btn"
                disabled={busy}
                title={skip.title}
                onClick={() => run(actions.pendingAction("skip"))}
              >
                {skip.label}
              </button>
            )}
            <button
              className="cfp-btn danger"
              disabled={busy}
              title="Go back to the state before this operation started"
              onClick={() => run(actions.pendingAction("abort"))}
            >
              Abort
            </button>
          </span>
        )}
      </div>

      {files.length === 0 ? (
        <div className="cfp-empty">Nothing left to resolve.</div>
      ) : (
        <div className="cfp-list">
          {files.map((file) => (
            <div className={file.hasMarkers ? "cfp-row" : "cfp-row done"} key={file.path}>
              <span className="cfp-mark" aria-hidden="true">
                {file.hasMarkers ? "!" : "✓"}
              </span>
              <span className="cfp-path" title={file.path}>
                {file.path}
              </span>
              <span className="cfp-tag">
                {file.hasMarkers
                  ? FILE_KIND_LABEL[file.kind]
                  : `${FILE_KIND_LABEL[file.kind]} - no markers left, resolved by hand`}
              </span>
              <span className="cfp-row-actions">
                <button
                  className="cfp-mini"
                  disabled={busy}
                  title={sideTooltip("ours", kind)}
                  onClick={() => run(actions.resolveWith(file.path, "ours"))}
                >
                  Use ours
                </button>
                <button
                  className="cfp-mini"
                  disabled={busy}
                  title={sideTooltip("theirs", kind)}
                  onClick={() => run(actions.resolveWith(file.path, "theirs"))}
                >
                  Use theirs
                </button>
                <button
                  className="cfp-mini"
                  disabled={busy}
                  title="Stage the file as it is on disk"
                  onClick={() => run(actions.markResolved([file.path]))}
                >
                  Mark resolved
                </button>
                {onOpenFile !== undefined && (
                  <button
                    className="cfp-mini"
                    title="Open the file"
                    onClick={() => onOpenFile(file.path)}
                  >
                    Open
                  </button>
                )}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
