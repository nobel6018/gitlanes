import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import type { CommitDetails, FileChange, Signature } from "../types";
import { errorMessage, getCommitDetails, getFileDiff } from "./api";
import { FileRow } from "./FileRow";
import { FileTree, buildFileNavRows } from "./FileTree";
import { copyText } from "./clipboard";
import { DiffView } from "./DiffView";
import { formatTimestamp, shortSha, splitPath } from "./format";
import { withKbd } from "./shortcuts";
import "./panels.css";

export interface CommitDetailPanelProps {
  repoPath: string;
  sha: string;
  /** 선택된 커밋이 스태시면 제목 옆에 STASH 뱃지를 붙인다 */
  isStash: boolean;
  /** parent short sha 클릭 시 해당 커밋 선택 */
  onSelectSha: (sha: string) => void;
  onError: (message: string) => void;
  /** diff 뷰가 열리거나 닫힐 때 호출. 셸이 Esc 단계 판정에 쓴다 */
  onDiffOpenChange?: (open: boolean) => void;
  /** 값이 바뀌면(0이 아니고 직전 값과 다르면) diff를 닫고 파일 목록으로 복귀한다 */
  closeDiffNonce?: number;
}

interface DiffState {
  file: string;
  text: string;
}

const FILE_VIEW_KEY = "gitlanes.fileView";
/** diff 화면에서 PageUp/PageDown이 움직이는 픽셀 (한 화면에서 조금 덜) */
const DIFF_PAGE_OVERLAP = 40;
/** diff 화면 ↑↓ 한 번의 스크롤 픽셀 */
const DIFF_LINE_STEP = 36;

type FileView = "path" | "tree";

function readFileView(): FileView {
  try {
    return localStorage.getItem(FILE_VIEW_KEY) === "tree" ? "tree" : "path";
  } catch {
    return "path";
  }
}

export function CommitDetailPanel({
  repoPath,
  sha,
  isStash,
  onSelectSha,
  onError,
  onDiffOpenChange,
  closeDiffNonce,
}: CommitDetailPanelProps) {
  const [details, setDetails] = useState<CommitDetails | null>(null);
  const [loading, setLoading] = useState(false);
  const [diff, setDiff] = useState<DiffState | null>(null);
  const [diffFile, setDiffFile] = useState<string | null>(null);
  const [fileView, setFileView] = useState<FileView>(readFileView);
  // 트리 접기 상태. 기본은 전부 펼침이라 접힌 경로만 담는다
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set<string>());
  /** 키보드 포커스 행. -1이면 아직 아무 행도 잡지 않았다 */
  const [focusIndex, setFocusIndex] = useState(-1);
  const listRef = useRef<HTMLDivElement | null>(null);
  const diffNavRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let alive = true;
    setDetails(null);
    setDiff(null);
    setDiffFile(null);
    setFocusIndex(-1);
    setCollapsed(new Set<string>());
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

  const files = details?.files ?? [];
  // Tree 모드의 화면에 보이는 행 목록. 키보드 탐색 인덱스가 이 배열의 인덱스다
  const treeRows = useMemo(
    () => (fileView === "tree" ? buildFileNavRows(files, collapsed) : []),
    [fileView, files, collapsed],
  );
  const navCount = fileView === "tree" ? treeRows.length : files.length;

  const openDiff = useCallback(
    async (file: FileChange) => {
      setDiffFile(file.path);
      setDiff(null);
      try {
        const text = await getFileDiff(repoPath, sha, file.path, file.oldPath);
        setDiff({ file: file.path, text });
      } catch (err) {
        setDiffFile(null);
        onError(errorMessage(err));
      }
    },
    [repoPath, sha, onError],
  );

  const closeDiff = useCallback(() => {
    setDiffFile(null);
    setDiff(null);
  }, []);

  // 콜백이 매 렌더 새로 와도 알림 효과가 다시 돌지 않게 ref로 우회한다
  const diffOpenChangeRef = useRef(onDiffOpenChange);
  diffOpenChangeRef.current = onDiffOpenChange;

  // diff 열림/닫힘 알림. 마운트 시에도 현재 상태(false)를 한 번 알린다
  useEffect(() => {
    diffOpenChangeRef.current?.(diffFile !== null);
  }, [diffFile]);

  // diff를 열어둔 채로 패널이 사라지면(선택 해제, 다른 커밋 선택) 닫힘으로 알린다
  useEffect(() => {
    return () => {
      diffOpenChangeRef.current?.(false);
    };
  }, []);

  // 셸의 Esc 등 외부 요청으로 diff 닫기. 첫 렌더 값은 소비만 하고 무시한다
  const closeNonceRef = useRef(closeDiffNonce);
  useEffect(() => {
    if (closeDiffNonce === closeNonceRef.current) {
      return;
    }
    closeNonceRef.current = closeDiffNonce;
    if (closeDiffNonce !== undefined && closeDiffNonce !== 0) {
      closeDiff();
    }
  }, [closeDiffNonce, closeDiff]);

  // 포커스 행이 목록 밖으로 나가면 스크롤로 따라간다
  useEffect(() => {
    if (focusIndex < 0) {
      return;
    }
    const el = listRef.current?.querySelector<HTMLElement>(`[data-nav-index="${focusIndex}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [focusIndex, treeRows, fileView]);

  // diff를 열면 diff 래퍼로, 닫으면 목록으로 포커스를 되돌린다 (직전 포커스 행 유지)
  useEffect(() => {
    if (diffFile !== null) {
      diffNavRef.current?.focus();
    } else if (focusIndex >= 0) {
      listRef.current?.focus();
    }
    // focusIndex는 의도적으로 의존성에서 제외: 화살표 이동마다 focus()를 다시 부르지 않는다
  }, [diffFile]);

  // 행 수가 줄어들면(뷰 전환, 디렉토리 접기) 포커스를 범위 안으로 당긴다
  useEffect(() => {
    setFocusIndex((prev) => (prev >= navCount ? navCount - 1 : prev));
  }, [navCount]);

  function changeFileView(next: FileView) {
    setFileView(next);
    setFocusIndex(-1);
    try {
      localStorage.setItem(FILE_VIEW_KEY, next);
    } catch {
      // localStorage 실패는 무시 (설정만 휘발)
    }
  }

  function toggleDir(path: string) {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
  }

  /** 포커스 행을 delta만큼 옮긴다. 아직 잡은 행이 없으면 양 끝에서 시작 */
  function moveFocus(delta: number) {
    if (navCount === 0) {
      return;
    }
    setFocusIndex((prev) => {
      const from = prev < 0 ? (delta > 0 ? -1 : navCount) : prev;
      return Math.max(0, Math.min(navCount - 1, from + delta));
    });
  }

  /** 포커스 행 활성화: 파일이면 diff, 디렉토리면 접기/펼치기 */
  function activate(index: number) {
    if (index < 0) {
      return;
    }
    if (fileView === "tree") {
      const row = treeRows[index];
      if (row === undefined) {
        return;
      }
      if (row.kind === "file") {
        void openDiff(row.file);
      } else {
        toggleDir(row.path);
      }
      return;
    }
    const file = files[index];
    if (file !== undefined) {
      void openDiff(file);
    }
  }

  /** 현재 포커스 행의 부모 디렉토리 행 (없으면 -1) */
  function parentIndex(index: number): number {
    const row = treeRows[index];
    if (row === undefined) {
      return -1;
    }
    for (let i = index - 1; i >= 0; i--) {
      if (treeRows[i].depth < row.depth) {
        return i;
      }
    }
    return -1;
  }

  function handleListKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.metaKey || event.ctrlKey || event.altKey) {
      return;
    }
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        moveFocus(1);
        return;
      case "ArrowUp":
        event.preventDefault();
        moveFocus(-1);
        return;
      case "Home":
        event.preventDefault();
        if (navCount > 0) {
          setFocusIndex(0);
        }
        return;
      case "End":
        event.preventDefault();
        if (navCount > 0) {
          setFocusIndex(navCount - 1);
        }
        return;
      case "Enter":
        event.preventDefault();
        activate(focusIndex < 0 && navCount > 0 ? 0 : focusIndex);
        if (focusIndex < 0 && navCount > 0) {
          setFocusIndex(0);
        }
        return;
      case "ArrowRight": {
        event.preventDefault();
        if (focusIndex < 0) {
          moveFocus(1);
          return;
        }
        if (fileView === "tree") {
          const row = treeRows[focusIndex];
          if (row === undefined) {
            return;
          }
          if (row.kind === "dir") {
            // 접혔으면 펼치고, 이미 펼쳐져 있으면 첫 자식으로 들어간다
            if (row.collapsed) {
              toggleDir(row.path);
            } else {
              moveFocus(1);
            }
            return;
          }
        }
        activate(focusIndex);
        return;
      }
      case "ArrowLeft": {
        if (fileView !== "tree" || focusIndex < 0) {
          return;
        }
        event.preventDefault();
        const row = treeRows[focusIndex];
        if (row === undefined) {
          return;
        }
        if (row.kind === "dir" && !row.collapsed) {
          toggleDir(row.path);
          return;
        }
        const parent = parentIndex(focusIndex);
        if (parent >= 0) {
          setFocusIndex(parent);
        }
        return;
      }
      default:
    }
  }

  function handleDiffKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.metaKey || event.ctrlKey || event.altKey) {
      return;
    }
    if (event.key === "ArrowLeft" || event.key === "Backspace") {
      event.preventDefault();
      closeDiff();
      return;
    }
    const scroller = diffNavRef.current?.querySelector<HTMLElement>(".diff");
    if (!scroller) {
      return;
    }
    const page = Math.max(80, scroller.clientHeight - DIFF_PAGE_OVERLAP);
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        scroller.scrollTop += DIFF_LINE_STEP;
        return;
      case "ArrowUp":
        event.preventDefault();
        scroller.scrollTop -= DIFF_LINE_STEP;
        return;
      case "PageDown":
        event.preventDefault();
        scroller.scrollTop += page;
        return;
      case "PageUp":
        event.preventDefault();
        scroller.scrollTop -= page;
        return;
      case "Home":
        event.preventDefault();
        scroller.scrollTop = 0;
        return;
      case "End":
        event.preventDefault();
        scroller.scrollTop = scroller.scrollHeight;
        return;
      default:
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
          <button
            className="back-btn"
            onClick={closeDiff}
            title={withKbd("Back to files", "Esc")}
          >
            ‹ Files
          </button>
          <span className="panel-head-path" title={diffFile}>
            <span className="path-dir">{dir}</span>
            <span className="path-base">{base}</span>
          </span>
        </div>
        <div
          className="panel-diff-nav"
          ref={diffNavRef}
          tabIndex={0}
          onKeyDown={handleDiffKeyDown}
          aria-label="Diff. Left arrow or Backspace returns to the file list"
        >
          {diff === null ? (
            <div className="panel-empty">Loading diff…</div>
          ) : (
            <DiffView text={diff.text} />
          )}
        </div>
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
            <span>
              Files changed <span className="fg-2">{details.files.length}</span>
            </span>
            <span className="view-toggle" role="group" aria-label="File list layout">
              <button
                className={fileView === "path" ? "view-btn on" : "view-btn"}
                onClick={() => changeFileView("path")}
                aria-pressed={fileView === "path"}
              >
                Path
              </button>
              <button
                className={fileView === "tree" ? "view-btn on" : "view-btn"}
                onClick={() => changeFileView("tree")}
                aria-pressed={fileView === "tree"}
              >
                Tree
              </button>
            </span>
          </h3>
          {details.files.length === 0 ? (
            <div className="panel-empty small">변경된 파일이 없습니다.</div>
          ) : (
            // 목록 전체가 하나의 탭 스톱. 안쪽 행 버튼은 tabIndex=-1이고 여기서 키를 받는다
            <div
              className="file-nav"
              ref={listRef}
              tabIndex={0}
              aria-label="Changed files"
              onKeyDown={handleListKeyDown}
            >
              {fileView === "tree" ? (
                <FileTree
                  rows={treeRows}
                  focusIndex={focusIndex}
                  onOpen={(file, index) => {
                    setFocusIndex(index);
                    void openDiff(file);
                  }}
                  onToggle={(path, index) => {
                    setFocusIndex(index);
                    toggleDir(path);
                  }}
                />
              ) : (
                <ul className="file-list">
                  {details.files.map((file, index) => (
                    <FileRow
                      key={file.path}
                      file={file}
                      navIndex={index}
                      focused={index === focusIndex}
                      onOpen={() => {
                        setFocusIndex(index);
                        void openDiff(file);
                      }}
                    />
                  ))}
                </ul>
              )}
            </div>
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
      title={withKbd("Copy sha", "Mod+C")}
      aria-label="Copy sha"
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
