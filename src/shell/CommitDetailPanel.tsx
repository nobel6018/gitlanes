import { useEffect, useRef, useState } from "react";
import type { CommitDetails, FileChange, Signature } from "../types";
import { errorMessage, getCommitDetails, getFileDiff } from "./api";
import { copyText } from "./clipboard";
import { DiffView } from "./DiffView";
import { formatTimestamp, shortSha, splitPath, statusLabel } from "./format";

export interface CommitDetailPanelProps {
  repoPath: string;
  sha: string;
  /** 선택된 커밋이 스태시면 제목 옆에 STASH 뱃지를 붙인다 */
  isStash: boolean;
  /** parent short sha 클릭 시 해당 커밋 선택 */
  onSelectSha: (sha: string) => void;
  onError: (message: string) => void;
}

interface DiffState {
  file: string;
  text: string;
}

export function CommitDetailPanel({
  repoPath,
  sha,
  isStash,
  onSelectSha,
  onError,
}: CommitDetailPanelProps) {
  const [details, setDetails] = useState<CommitDetails | null>(null);
  const [loading, setLoading] = useState(false);
  const [diff, setDiff] = useState<DiffState | null>(null);
  const [diffFile, setDiffFile] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setDetails(null);
    setDiff(null);
    setDiffFile(null);
    setLoading(true);
    getCommitDetails(repoPath, sha)
      .then((d) => {
        if (alive) {
          setDetails(d);
        }
      })
      .catch((err: unknown) => {
        if (alive) {
          onError(errorMessage(err));
        }
      })
      .finally(() => {
        if (alive) {
          setLoading(false);
        }
      });
    return () => {
      alive = false;
    };
  }, [repoPath, sha, onError]);

  async function openDiff(file: FileChange) {
    setDiffFile(file.path);
    setDiff(null);
    try {
      const text = await getFileDiff(repoPath, sha, file.path, file.oldPath);
      setDiff({ file: file.path, text });
    } catch (err) {
      setDiffFile(null);
      onError(errorMessage(err));
    }
  }

  if (loading && !details) {
    return (
      <aside className="detail-panel">
        <div className="panel-empty">Loading commit…</div>
      </aside>
    );
  }

  if (!details) {
    return (
      <aside className="detail-panel">
        <div className="panel-empty">커밋 정보를 불러오지 못했습니다.</div>
      </aside>
    );
  }

  if (diffFile !== null) {
    const { dir, base } = splitPath(diffFile);
    return (
      <aside className="detail-panel">
        <div className="panel-head">
          <button className="back-btn" onClick={() => { setDiffFile(null); setDiff(null); }}>
            ‹ Files
          </button>
          <span className="panel-head-path" title={diffFile}>
            <span className="path-dir">{dir}</span>
            <span className="path-base">{base}</span>
          </span>
        </div>
        {diff === null ? (
          <div className="panel-empty">Loading diff…</div>
        ) : (
          <DiffView text={diff.text} />
        )}
      </aside>
    );
  }

  return (
    <aside className="detail-panel">
      <div className="panel-scroll">
        <section className="panel-section">
          <h2 className="commit-subject selectable">
            {isStash && <span className="stash-badge">STASH</span>}
            {details.subject}
          </h2>
          {details.body.trim() !== "" && (
            <pre className="commit-body selectable">{details.body.trimEnd()}</pre>
          )}
        </section>

        <section className="panel-section">
          <div className="meta-row">
            <span className="meta-label">Commit</span>
            <span className="meta-value mono selectable">
              {details.sha}
              <CopyShaButton sha={details.sha} onError={onError} />
            </span>
          </div>
          <SignatureRow label="Author" sig={details.author} />
          {isDistinct(details.author, details.committer) && (
            <SignatureRow label="Committer" sig={details.committer} />
          )}
          <div className="meta-row">
            <span className="meta-label">Parents</span>
            <span className="meta-value">
              {details.parents.length === 0 ? (
                <span className="fg-2">none (root commit)</span>
              ) : (
                details.parents.map((p) => (
                  <button
                    key={p}
                    className="parent-link mono"
                    onClick={() => onSelectSha(p)}
                    title={p}
                  >
                    {shortSha(p)}
                  </button>
                ))
              )}
            </span>
          </div>
        </section>

        <section className="panel-section files">
          <h3 className="files-title">
            Files changed <span className="fg-2">{details.files.length}</span>
          </h3>
          {details.files.length === 0 ? (
            <div className="panel-empty small">변경된 파일이 없습니다.</div>
          ) : (
            <ul className="file-list">
              {details.files.map((file) => (
                <FileRow key={file.path} file={file} onOpen={() => openDiff(file)} />
              ))}
            </ul>
          )}
        </section>
      </div>
    </aside>
  );
}

/** sha 복사 버튼. 성공하면 1.5초간 체크 표시 */
function CopyShaButton({ sha, onError }: { sha: string; onError: (message: string) => void }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (timer.current !== null) {
        window.clearTimeout(timer.current);
      }
    };
  }, []);

  async function handleCopy() {
    const ok = await copyText(sha);
    if (!ok) {
      onError("클립보드에 복사하지 못했습니다.");
      return;
    }
    setCopied(true);
    if (timer.current !== null) {
      window.clearTimeout(timer.current);
    }
    timer.current = window.setTimeout(() => setCopied(false), 1500);
  }

  return (
    <button
      className={copied ? "copy-btn copied" : "copy-btn"}
      onClick={handleCopy}
      title="Copy full sha"
      aria-label="Copy full sha"
    >
      {copied ? (
        <svg viewBox="0 0 16 16" width="11" height="11" aria-hidden="true">
          <path
            d="M3 8.6 6.2 12 13 4.8"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      ) : (
        <svg viewBox="0 0 16 16" width="11" height="11" aria-hidden="true">
          <g fill="none" stroke="currentColor" strokeWidth="1.3">
            <rect x="5.4" y="5.4" width="8.2" height="8.2" rx="1.5" />
            <path d="M10.6 5.4V3.9a1.5 1.5 0 0 0-1.5-1.5H3.9a1.5 1.5 0 0 0-1.5 1.5v5.2a1.5 1.5 0 0 0 1.5 1.5h1.5" />
          </g>
        </svg>
      )}
    </button>
  );
}

function isDistinct(author: Signature, committer: Signature): boolean {
  return author.email !== committer.email || author.timestamp !== committer.timestamp;
}

function SignatureRow({ label, sig }: { label: string; sig: Signature }) {
  return (
    <div className="meta-row">
      <span className="meta-label">{label}</span>
      <span className="meta-value">
        <span className="sig-name selectable">{sig.name}</span>
        <span className="sig-email selectable">&lt;{sig.email}&gt;</span>
        <span className="sig-date">{formatTimestamp(sig.timestamp)}</span>
      </span>
    </div>
  );
}

function FileRow({ file, onOpen }: { file: FileChange; onOpen: () => void }) {
  const { dir, base } = splitPath(file.path);
  const title =
    file.oldPath === null
      ? `${statusLabel(file.status)}: ${file.path}`
      : `${statusLabel(file.status)}: ${file.oldPath} → ${file.path}`;

  return (
    <li>
      <button className="file-row" onClick={onOpen} title={title}>
        <span className={`status-badge status-${file.status}`}>{file.status}</span>
        <span className="file-path">
          <span className="path-dir">{dir}</span>
          <span className="path-base">{base}</span>
        </span>
        <span className="file-stat">
          {file.additions > 0 && <span className="stat-add">+{file.additions}</span>}
          {file.deletions > 0 && <span className="stat-del">-{file.deletions}</span>}
        </span>
      </button>
    </li>
  );
}
