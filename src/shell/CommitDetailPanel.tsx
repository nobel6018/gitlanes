import { useEffect, useState } from "react";
import type { CommitDetails, FileChange, Signature } from "../types";
import { errorMessage, getCommitDetails, getFileDiff } from "./api";
import { DiffView } from "./DiffView";
import { formatTimestamp, shortSha, splitPath, statusLabel } from "./format";

export interface CommitDetailPanelProps {
  repoPath: string;
  sha: string;
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
          <h2 className="commit-subject selectable">{details.subject}</h2>
          {details.body.trim() !== "" && (
            <pre className="commit-body selectable">{details.body.trimEnd()}</pre>
          )}
        </section>

        <section className="panel-section">
          <div className="meta-row">
            <span className="meta-label">Commit</span>
            <span className="meta-value mono selectable">{details.sha}</span>
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
