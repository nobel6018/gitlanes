import type { FileChange } from "../types";
import { splitPath, statusLabel } from "./format";

export interface FileRowProps {
  file: FileChange;
  /** Tree 모드에서는 경로 대신 파일명만 보여주고 깊이만큼 들여쓴다 */
  depth?: number;
  nameOnly?: boolean;
  onOpen: () => void;
}

/** 변경 파일 한 줄. Path 목록과 Tree 뷰가 함께 쓴다 */
export function FileRow({ file, depth, nameOnly, onOpen }: FileRowProps) {
  const { dir, base } = splitPath(file.path);
  const title =
    file.oldPath === null
      ? `${statusLabel(file.status)}: ${file.path}`
      : `${statusLabel(file.status)}: ${file.oldPath} → ${file.path}`;

  return (
    <li>
      <button
        className="file-row"
        onClick={onOpen}
        title={title}
        style={depth === undefined ? undefined : { paddingLeft: 4 + depth * 12 }}
      >
        <span className={`status-badge status-${file.status}`}>{file.status}</span>
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
