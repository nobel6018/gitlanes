import type { FileChange, FileStatus } from "../types";
import { splitPath, statusLabel } from "./format";

/**
 * status 뱃지에 넣는 글자. GitKraken처럼 색 뱃지 안에 한 글자를 둔다.
 * 배경/글자색은 panels.css의 .st-* 가 준다 (뱃지는 DiffPanel 헤더도 같은 클래스를 쓴다)
 */
export const STATUS_LETTER: Record<FileStatus, string> = {
  M: "M",
  A: "A",
  D: "D",
  R: "R",
  C: "C",
  T: "T",
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
          {STATUS_LETTER[file.status]}
        </span>
        {/* GitKraken 배치: 파일명 먼저, 디렉토리는 뒤에 흐리게. 좁아지면 경로만 말줄임 */}
        <span className="file-path">
          <span className="path-base">{base}</span>
          {nameOnly !== true && dir !== "" && (
            <span className="path-dir suffix">{dir.replace(/\/$/, "")}</span>
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
