// 서브모듈 포인터 변경 보기. DiffPanel 자리에 놓인다. 계약: CONTRACTS.md v0.19 "SubmoduleChangePanelProps".
// gitlink는 텍스트 diff가 "Subproject commit <sha>" 두 줄뿐이라, 대신 두 커밋 사이에 무엇이 들어오고 빠졌는지 보여준다.
import type { CommitSummary, SubmoduleChange, SubmoduleInfo } from "../types";
import { formatDate, formatRelativeDate } from "../graph/layout";
import { splitPath } from "./format";
import { SubmoduleIcon } from "./FileRow";
import { commitSections, panelButtons, pointerSummary, unavailableReason } from "./submoduleModel";
import type { PointerSummary } from "./submoduleModel";
import "./panels.css";
import "./history.css";
import "./submodule.css";

export interface SubmoduleChangePanelProps {
  path: string;
  /** null이면 로딩 */
  change: SubmoduleChange | null;
  error: string | null;
  /** get_submodules에서 찾은 항목. 없으면 null(삭제된 서브모듈 등) */
  info: SubmoduleInfo | null;
  dateMode: "absolute" | "relative";
  /** info가 있고 uninitialized가 아닐 때만 버튼 */
  onOpenSubmodule(): void;
  /** info.state가 uninitialized일 때만 버튼 */
  onInitialize(): void;
  onClose(): void;
}

function PointerLine({ summary }: { summary: PointerSummary }) {
  switch (summary.kind) {
    case "changed":
      return (
        <div className="sm-pointer" aria-label={`Pointer moved from ${summary.oldShort} to ${summary.newShort}`}>
          <span className="sm-sha old">{summary.oldShort}</span>
          <span className="sm-arrow" aria-hidden="true">
            →
          </span>
          <span className="sm-sha new">{summary.newShort}</span>
        </div>
      );
    case "added":
      return (
        <div className="sm-pointer">
          <span className="sm-pointer-label">Submodule added at</span>
          <span className="sm-sha new">{summary.newShort}</span>
        </div>
      );
    case "removed":
      return (
        <div className="sm-pointer">
          <span className="sm-pointer-label">Submodule removed, was at</span>
          <span className="sm-sha old">{summary.oldShort}</span>
        </div>
      );
    case "same":
      return (
        <div className="sm-pointer">
          <span className="sm-pointer-label">Pointer unchanged at</span>
          <span className="sm-sha">{summary.short}</span>
        </div>
      );
    case "none":
      return (
        <div className="sm-pointer">
          <span className="sm-pointer-label">No recorded commit on either side</span>
        </div>
      );
  }
}

interface CommitListProps {
  title: string;
  commits: CommitSummary[];
  more: boolean;
  dateMode: "absolute" | "relative";
  nowMs: number;
}

// ComparePanel 목록과 같은 모양. 서브모듈 커밋은 이 레포 그래프에 없어서 누를 곳이 없다(읽기 전용 행)
function CommitList({ title, commits, more, dateMode, nowMs }: CommitListProps) {
  return (
    <section className="cp-section">
      <h3 className="cp-section-title">{title}</h3>
      <ul className="hp-list">
        {commits.map((commit) => (
          <li key={commit.sha} className="hp-commit sm-commit" title={commit.sha}>
            <span className="hp-sha">{commit.shortSha}</span>
            <span className="hp-subject">{commit.subject}</span>
            <span className="hp-meta">
              <span className="hp-author">{commit.author}</span>
              {dateMode === "relative" ? (
                <span className="hp-date" title={formatDate(commit.timestamp)}>
                  {formatRelativeDate(commit.timestamp, nowMs)}
                </span>
              ) : (
                <span className="hp-date">{formatDate(commit.timestamp)}</span>
              )}
            </span>
          </li>
        ))}
        {more && <li className="cp-more">+more</li>}
      </ul>
    </section>
  );
}

export function SubmoduleChangePanel({
  path,
  change,
  error,
  info,
  dateMode,
  onOpenSubmodule,
  onInitialize,
  onClose,
}: SubmoduleChangePanelProps) {
  // 렌더당 한 번만 시계를 읽는다
  const nowMs = Date.now();
  const buttons = panelButtons(info);
  const { dir, base } = splitPath(path);

  let body;
  if (error !== null) {
    body = <div className="hp-message hp-error">{error}</div>;
  } else if (change === null) {
    body = <div className="hp-message">Loading submodule changes…</div>;
  } else {
    const reason = unavailableReason(change, info);
    const sections = commitSections(change);
    const commitsOf = (key: "ahead" | "behind") => (key === "ahead" ? change.ahead : change.behind);
    body = (
      <div className="panel-scroll cp-body">
        <section className="cp-section">
          <h3 className="cp-section-title">Recorded commit</h3>
          <PointerLine summary={pointerSummary(change)} />
          {info !== null && info.url !== null && (
            <div className="sm-origin" title={info.url}>
              {info.url}
              {info.branch !== null && <span className="sm-branch">branch {info.branch}</span>}
            </div>
          )}
        </section>
        {change.dirty && (
          <div className="cp-notice" role="note">
            The submodule has uncommitted changes. They are not part of this pointer change; commit or discard them inside the submodule.
          </div>
        )}
        {reason !== null && (
          <div className="sm-notice" role="note">
            {reason}
          </div>
        )}
        {sections.map((section) => (
          <CommitList
            key={section.key}
            title={section.title}
            commits={commitsOf(section.key)}
            more={section.more}
            dateMode={dateMode}
            nowMs={nowMs}
          />
        ))}
        {change.available && sections.length === 0 && (
          <div className="hp-message">No commits between these pointers.</div>
        )}
      </div>
    );
  }

  return (
    <div className="hp-root">
      <div className="hp-head">
        <span className="hp-kind sm-kind">
          <SubmoduleIcon size={10} />
          Submodule
        </span>
        <span className="hp-path" title={path}>
          <span className="path-base">{base}</span>
          {dir !== "" && <span className="path-dir suffix">{dir.replace(/\/$/, "")}</span>}
        </span>
        {buttons.initialize && (
          <button className="dp-toggle" onClick={onInitialize} title="Initialize this submodule">
            Initialize
          </button>
        )}
        {buttons.open && (
          <button className="dp-toggle" onClick={onOpenSubmodule} title="Open this submodule in a new tab">
            Open Submodule
          </button>
        )}
        <button className="dp-close" onClick={onClose} title="Close" aria-label="Close submodule changes">
          ×
        </button>
      </div>
      {body}
    </div>
  );
}
