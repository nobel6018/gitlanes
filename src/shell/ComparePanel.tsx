// 브랜치/커밋 비교 화면. 계약: CONTRACTS.md v0.18 "ComparePanelProps".
// 양쪽에만 있는 커밋 목록 두 개와 세 점(base...head) diff의 바뀐 파일 목록을 보여준다.
import type { CommitSummary, CompareResult, FileChange } from "../types";
import { formatDate, formatRelativeDate } from "../graph/layout";
import { FileRow } from "./FileRow";
import { truncatedLists } from "./historyModel";
import "./panels.css";
import "./history.css";

export interface ComparePanelProps {
  baseLabel: string; // "main", "a1b2c3d" 같은 표시용
  headLabel: string;
  result: CompareResult | null; // null이면 로딩
  error: string | null;
  openFilePath: string | null;
  onOpenFile(file: FileChange): void;
  onSelectCommit(sha: string): void;
  onSwap(): void; // base와 head 맞바꾸기
  onClose(): void;
}

interface CommitListProps {
  title: string;
  commits: CommitSummary[];
  more: boolean;
  nowMs: number;
  onSelectCommit(sha: string): void;
}

function CommitList({ title, commits, more, nowMs, onSelectCommit }: CommitListProps) {
  return (
    <section className="cp-section">
      <h3 className="cp-section-title">
        {title} <span className="cp-n">({commits.length}{more ? "+" : ""})</span>
      </h3>
      {commits.length === 0 ? (
        <div className="cp-none">None</div>
      ) : (
        <ul className="hp-list">
          {commits.map((commit) => (
            <li
              key={commit.sha}
              className="hp-commit"
              title={commit.sha}
              onClick={() => onSelectCommit(commit.sha)}
            >
              <span className="hp-sha">{commit.shortSha}</span>
              <span className="hp-subject">{commit.subject}</span>
              <span className="hp-meta">
                <span className="hp-author">{commit.author}</span>
                <span className="hp-date" title={formatDate(commit.timestamp)}>
                  {formatRelativeDate(commit.timestamp, nowMs)}
                </span>
              </span>
            </li>
          ))}
          {more && <li className="cp-more">+more (list truncated)</li>}
        </ul>
      )}
    </section>
  );
}

export function ComparePanel({
  baseLabel,
  headLabel,
  result,
  error,
  openFilePath,
  onOpenFile,
  onSelectCommit,
  onSwap,
  onClose,
}: ComparePanelProps) {
  // 렌더당 한 번만 시계를 읽는다
  const nowMs = Date.now();

  let body;
  if (error !== null) {
    body = <div className="hp-message hp-error">{error}</div>;
  } else if (result === null) {
    body = <div className="hp-message">Comparing…</div>;
  } else {
    const more = truncatedLists(result);
    body = (
      <div className="panel-scroll cp-body">
        {result.mergeBase === null && (
          <div className="cp-notice" role="note">
            These histories are unrelated: {baseLabel} and {headLabel} have no common ancestor. Changed files compare the two trees directly.
          </div>
        )}
        <CommitList
          title={`Only in ${headLabel}`}
          commits={result.onlyInHead}
          more={more.head}
          nowMs={nowMs}
          onSelectCommit={onSelectCommit}
        />
        <CommitList
          title={`Only in ${baseLabel}`}
          commits={result.onlyInBase}
          more={more.base}
          nowMs={nowMs}
          onSelectCommit={onSelectCommit}
        />
        <section className="cp-section">
          <h3 className="cp-section-title">
            Changed files <span className="cp-n">({result.files.length})</span>
          </h3>
          {result.files.length === 0 ? (
            <div className="cp-none">No file changes</div>
          ) : (
            <ul className="file-list cp-files">
              {result.files.map((file) => (
                <FileRow
                  key={`${file.oldPath ?? ""}>${file.path}`}
                  file={file}
                  active={file.path === openFilePath}
                  onOpen={() => onOpenFile(file)}
                />
              ))}
            </ul>
          )}
        </section>
      </div>
    );
  }

  return (
    <div className="hp-root">
      <div className="hp-head">
        <span className="hp-kind">Compare</span>
        <span className="hp-path cp-refs" title={`${baseLabel} ← ${headLabel}`}>
          <span className="cp-ref">{baseLabel}</span>
          <span className="cp-arrow" aria-label="compared with">
            ←
          </span>
          <span className="cp-ref">{headLabel}</span>
        </span>
        <button
          className="dp-toggle"
          onClick={onSwap}
          title="Swap base and head"
          aria-label="Swap base and head"
        >
          ⇄ Swap
        </button>
        <button className="dp-close" onClick={onClose} title="Close" aria-label="Close compare">
          ×
        </button>
      </div>
      {body}
    </div>
  );
}
