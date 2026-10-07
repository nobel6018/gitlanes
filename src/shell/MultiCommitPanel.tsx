import type { CommitRow } from "../types";
import { shortSha } from "./format";
import "./multi.css";

export interface MultiCommitPanelProps {
  rows: CommitRow[];               // 선택된 커밋들(그래프 순서)
  busy: boolean;
  onCherryPick(): void; onRevert(): void; onSquash(): void; onCreatePatch(): void; onCopyShas(): void;
  onClear(): void;
}

/** 그래프에서 커밋 여러 개를 골랐을 때 상세 패널 자리에 뜨는 선택 목록과 일괄 동작 */
export function MultiCommitPanel({
  rows,
  busy,
  onCherryPick,
  onRevert,
  onSquash,
  onCreatePatch,
  onCopyShas,
  onClear,
}: MultiCommitPanelProps) {
  const n = rows.length;

  return (
    <aside className="detail-panel multi-panel">
      <div className="multi-head">
        <h2 className="multi-title">{n} commits selected</h2>
        <button className="dlg-btn" onClick={onClear} disabled={busy}>
          Clear selection
        </button>
      </div>

      <div className="multi-actions">
        <button className="dlg-btn" onClick={onCherryPick} disabled={busy}>
          Cherry-pick {n}
        </button>
        <button className="dlg-btn" onClick={onRevert} disabled={busy}>
          Revert {n}
        </button>
        <button
          className="dlg-btn"
          onClick={onSquash}
          disabled={busy || n < 2}
          title="Squash consecutive commits on the current branch"
        >
          Squash {n}
        </button>
        <button className="dlg-btn" onClick={onCreatePatch} disabled={busy}>
          Create patch files
        </button>
        <button className="dlg-btn" onClick={onCopyShas} disabled={busy}>
          Copy SHAs
        </button>
      </div>

      <ul className="multi-list panel-scroll">
        {rows.map((row) => (
          <li key={row.sha} className="multi-item" title={row.sha}>
            <span className="multi-sha mono">{shortSha(row.sha)}</span>
            <span className="multi-subject">{row.subject}</span>
            <span className="multi-author">{row.author}</span>
          </li>
        ))}
      </ul>
    </aside>
  );
}
