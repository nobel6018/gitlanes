import type { FileChange, FileStatus } from "../types";
import { splitPath, statusLabel } from "./format";

/** status 아이콘 (글자 뱃지 대신). 색은 panels.css의 .st-* 가 준다 */
export const STATUS_ICON: Record<FileStatus, string> = {
  M: "✎",
  A: "+",
  D: "−",
  R: "⇢",
  C: "⇢",
  T: "✎",
};

export interface FileRowProps {
  file: FileChange;
  /** Tree 모드에서는 경로 대신 파일명만 보여주고 깊이만큼 들여쓴다 */
  depth?: number;
  nameOnly?: boolean;
  /** 키보드 탐색 인덱스. 컨테이너가 이 값으로 행을 찾아 스크롤한다 */
  navIndex?: number;
  /** 키보드 포커스 행 */
  focused?: boolean;
  /** 메인 영역 diff 뷰어에 열려 있는 파일 */
  active?: boolean;
  onOpen: () => void;
}

/** 변경 파일 한 줄. Path 목록과 Tree 뷰가 함께 쓴다 */
export function FileRow({
  file,
  depth,
  nameOnly,
  navIndex,
  focused,
  active,
  onOpen,
}: FileRowProps) {
  const { dir, base } = splitPath(file.path);
  const title =
    file.oldPath === null
      ? `${statusLabel(file.status)}: ${file.path}`
      : `${statusLabel(file.status)}: ${file.oldPath} → ${file.path}`;
  const className =
    "file-row" + (focused === true ? " kb-focus" : "") + (active === true ? " active" : "");

  return (
    <li>
      <button
        className={className}
        onClick={onOpen}
        title={title}
        data-nav-index={navIndex}
        tabIndex={navIndex === undefined ? undefined : -1}
        aria-current={active === true ? "true" : undefined}
        style={depth === undefined ? undefined : { paddingLeft: 4 + depth * 14 }}
      >
        <span className={`file-icon st-${file.status}`} aria-hidden="true">
          {STATUS_ICON[file.status]}
        </span>
        <span className="file-path">
          {nameOnly === true ? (
            <span className="path-base">{base}</span>
          ) : (
            <>
              <span className="path-dir">{dir}</span>
              <span className="path-base">{base}</span>
            </>
          )}
        </span>
        <span className="file-stat">
          {file.additions > 0 && <span className="stat-add">+{file.additions}</span>}
          {file.deletions > 0 && <span className="stat-del">-{file.deletions}</span>}
        </span>
      </button>
    </li>
  );
}
