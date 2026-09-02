// WIP(미커밋 변경) 상세 패널. GitKraken의 WIP 노드처럼 Staged/Unstaged/Untracked를
// 세 섹션으로 보여주고, 파일 클릭 시 셸이 메인 영역 DiffPanel을 연다.
// 이 패널에서는 보기만 한다 (스테이징/언스테이징 조작은 향후 작업).
// 계약: CONTRACTS.md v0.14 "WipDetailPanelProps".
import { useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent, ReactNode } from "react";
import type { FileChange, WipArea, WipDetails } from "../types";
import { FileRow } from "./FileRow";
import { FileTree, buildFileNavRows, readFileView, writeFileView } from "./FileTree";
import type { FileNavRow, FileView } from "./FileTree";
import "./panels.css";

export interface WipDetailPanelProps {
  /** 로딩 중 null */
  details: WipDetails | null;
  loading: boolean;
  onOpenFile: (file: FileChange, area: WipArea) => void;
  /** 메인 영역 뷰어에 열려 있는 파일 (강조용) */
  openFile: { path: string; area: WipArea } | null;
}

const AREAS: { area: WipArea; label: string }[] = [
  { area: "staged", label: "Staged" },
  { area: "unstaged", label: "Unstaged" },
  { area: "untracked", label: "Untracked" },
];

type CollapsedByArea = Record<WipArea, ReadonlySet<string>>;

function emptyCollapsed(): CollapsedByArea {
  return {
    staged: new Set<string>(),
    unstaged: new Set<string>(),
    untracked: new Set<string>(),
  };
}

interface Section {
  area: WipArea;
  label: string;
  files: FileChange[];
  /** Tree 모드의 평면 행. Path 모드에서는 빈 배열 */
  treeRows: FileNavRow[];
  /** 전체 키보드 인덱스에서 이 섹션의 시작 위치 */
  offset: number;
  /** 이 섹션이 차지하는 키보드 인덱스 개수 */
  count: number;
}

export function WipDetailPanel({ details, loading, onOpenFile, openFile }: WipDetailPanelProps) {
  const [fileView, setFileView] = useState<FileView>(readFileView);
  const [collapsed, setCollapsed] = useState<CollapsedByArea>(emptyCollapsed);
  /** 키보드 포커스 행 (세 섹션을 이어 붙인 전체 인덱스). -1이면 없음 */
  const [focusIndex, setFocusIndex] = useState(-1);
  const listRef = useRef<HTMLDivElement | null>(null);

  const sections = useMemo<Section[]>(() => {
    let offset = 0;
    return AREAS.map(({ area, label }) => {
      const files = details === null ? [] : details[area];
      const treeRows = fileView === "tree" ? buildFileNavRows(files, collapsed[area]) : [];
      const count = fileView === "tree" ? treeRows.length : files.length;
      const section: Section = { area, label, files, treeRows, offset, count };
      offset += count;
      return section;
    });
  }, [details, fileView, collapsed]);

  const navCount = sections.reduce((sum, section) => sum + section.count, 0);
  const totalFiles = sections.reduce((sum, section) => sum + section.files.length, 0);

  // 목록이 줄어들면(뷰 전환, 접기, 새로고침) 포커스를 범위 안으로 당긴다
  useEffect(() => {
    setFocusIndex((prev) => (prev >= navCount ? navCount - 1 : prev));
  }, [navCount]);

  // 포커스 행 스크롤 추종. 섹션마다 data-nav-index가 0부터라 area로 먼저 좁힌다
  useEffect(() => {
    if (focusIndex < 0) {
      return;
    }
    const hit = sections.find(
      (section) => focusIndex >= section.offset && focusIndex < section.offset + section.count,
    );
    if (hit === undefined) {
      return;
    }
    const local = focusIndex - hit.offset;
    listRef.current
      ?.querySelector<HTMLElement>(`[data-area="${hit.area}"] [data-nav-index="${local}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [focusIndex, sections]);

  function changeFileView(next: FileView) {
    setFileView(next);
    setFocusIndex(-1);
    writeFileView(next);
  }

  function toggleDir(area: WipArea, path: string) {
    setCollapsed((prev) => {
      const next = new Set(prev[area]);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return { ...prev, [area]: next };
    });
  }

  /** 전체 인덱스 → 섹션과 그 안의 행 */
  function rowAt(index: number):
    | { section: Section; local: number; row: FileNavRow | null; file: FileChange | null }
    | null {
    const section = sections.find(
      (candidate) => index >= candidate.offset && index < candidate.offset + candidate.count,
    );
    if (section === undefined) {
      return null;
    }
    const local = index - section.offset;
    if (fileView === "tree") {
      const row = section.treeRows[local] ?? null;
      return { section, local, row, file: row?.kind === "file" ? row.file : null };
    }
    return { section, local, row: null, file: section.files[local] ?? null };
  }

  function moveFocus(delta: number) {
    if (navCount === 0) {
      return;
    }
    setFocusIndex((prev) => {
      const from = prev < 0 ? (delta > 0 ? -1 : navCount) : prev;
      return Math.max(0, Math.min(navCount - 1, from + delta));
    });
  }

  function activate(index: number) {
    const hit = rowAt(index);
    if (hit === null) {
      return;
    }
    if (hit.file !== null) {
      onOpenFile(hit.file, hit.section.area);
      return;
    }
    if (hit.row !== null && hit.row.kind === "dir") {
      toggleDir(hit.section.area, hit.row.path);
    }
  }

  /** Tree 모드에서 같은 섹션 안의 부모 디렉토리 행 (없으면 -1) */
  function parentIndex(index: number): number {
    const hit = rowAt(index);
    if (hit === null || hit.row === null) {
      return -1;
    }
    for (let i = hit.local - 1; i >= 0; i--) {
      if (hit.section.treeRows[i].depth < hit.row.depth) {
        return hit.section.offset + i;
      }
    }
    return -1;
  }

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
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
        if (focusIndex < 0) {
          if (navCount > 0) {
            setFocusIndex(0);
            activate(0);
          }
          return;
        }
        activate(focusIndex);
        return;
      case "ArrowRight": {
        event.preventDefault();
        if (focusIndex < 0) {
          moveFocus(1);
          return;
        }
        const hit = rowAt(focusIndex);
        if (hit === null) {
          return;
        }
        if (hit.row !== null && hit.row.kind === "dir") {
          if (hit.row.collapsed) {
            toggleDir(hit.section.area, hit.row.path);
          } else {
            moveFocus(1);
          }
          return;
        }
        activate(focusIndex);
        return;
      }
      case "ArrowLeft": {
        if (fileView !== "tree" || focusIndex < 0) {
          return;
        }
        event.preventDefault();
        const hit = rowAt(focusIndex);
        if (hit === null || hit.row === null) {
          return;
        }
        if (hit.row.kind === "dir" && !hit.row.collapsed) {
          toggleDir(hit.section.area, hit.row.path);
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

  if (details === null) {
    return (
      <aside className="detail-panel">
        <div className="panel-scroll">
          <section className="panel-section">
            <div className="wip-title">// WIP</div>
            {loading ? (
              <div className="wip-skeleton" aria-label="Loading working tree changes">
                <span className="wip-skel-line w60" />
                <span className="wip-skel-line w85" />
                <span className="wip-skel-line w45" />
              </div>
            ) : (
              <div className="panel-empty small">워킹 트리 정보를 불러오지 못했습니다.</div>
            )}
          </section>
        </div>
      </aside>
    );
  }

  const counts = {
    staged: details.staged.length,
    unstaged: details.unstaged.length,
    untracked: details.untracked.length,
  };

  return (
    <aside className="detail-panel">
      <div className="panel-scroll">
        <section className="panel-section">
          <div className="wip-head">
            <span className="wip-title">// WIP</span>
            {loading && <span className="wip-refreshing">refreshing…</span>}
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
          </div>
          <div className="file-summary">
            <span className="sum-add">{counts.staged} staged</span>
            <span className="sum-sep"> · </span>
            <span className="sum-mod">{counts.unstaged} unstaged</span>
            <span className="sum-sep"> · </span>
            <span className="sum-untracked">{counts.untracked} untracked</span>
          </div>
        </section>

        {totalFiles === 0 ? (
          <div className="panel-empty">Working tree clean</div>
        ) : (
          // 세 섹션을 하나의 연속 목록처럼 다루는 단일 탭 스톱
          <div className="file-nav" ref={listRef} tabIndex={0} aria-label="Working tree changes" onKeyDown={handleKeyDown}>
            {sections.map((section) => {
              if (section.files.length === 0) {
                return null;
              }
              const activePath =
                openFile !== null && openFile.area === section.area ? openFile.path : null;
              let body: ReactNode;
              if (fileView === "tree") {
                body = (
                  <FileTree
                    rows={section.treeRows}
                    focusIndex={focusIndex - section.offset}
                    activePath={activePath}
                    onOpen={(file, index) => {
                      setFocusIndex(section.offset + index);
                      onOpenFile(file, section.area);
                    }}
                    onToggle={(path, index) => {
                      setFocusIndex(section.offset + index);
                      toggleDir(section.area, path);
                    }}
                  />
                );
              } else {
                body = (
                  <ul className="file-list">
                    {section.files.map((file, index) => (
                      <FileRow
                        key={file.path}
                        file={file}
                        navIndex={index}
                        focused={focusIndex === section.offset + index}
                        active={file.path === activePath}
                        onOpen={() => {
                          setFocusIndex(section.offset + index);
                          onOpenFile(file, section.area);
                        }}
                      />
                    ))}
                  </ul>
                );
              }
              return (
                <section className="panel-section files" key={section.area} data-area={section.area}>
                  <h3 className="files-title wip-section-title">
                    <span>{section.label}</span>
                    <span className={`wip-count wip-count-${section.area}`}>
                      {section.files.length}
                    </span>
                  </h3>
                  {body}
                </section>
              );
            })}
          </div>
        )}
      </div>
    </aside>
  );
}
