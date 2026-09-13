import type { MouseEvent } from "react";
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

/** hover 시 행 오른쪽에 뜨는 버튼 하나 */
export interface FileRowAction {
  key: string;
  /** 버튼에 찍는 글리프 (+, −, ↺) */
  glyph: string;
  /** 툴팁과 스크린리더 레이블 */
  label: string;
  onRun: () => void;
  disabled?: boolean;
  /** 되돌릴 수 없는 동작이면 빨갛게 */
  danger?: boolean;
}

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
  /** 추적되지 않는 새 파일. status가 'A'로 오므로 뱃지만 U로 바꿔 구분한다 */
  untracked?: boolean;
  /** 체크박스를 그리려면 준다. 없으면 체크박스 자체가 없다 */
  checked?: boolean;
  /** range=true면 Shift 범위 선택 */
  onToggleCheck?: (range: boolean) => void;
  /** hover 시 우측에 뜨는 액션들. 비어 있으면 안 그린다 */
  actions?: FileRowAction[];
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
  untracked,
  checked,
  onToggleCheck,
  actions,
  onOpen,
}: FileRowProps) {
  const { dir, base } = splitPath(file.path);
  const kind = untracked === true ? "새 파일(untracked)" : statusLabel(file.status);
  const title = file.oldPath === null ? `${kind}: ${file.path}` : `${kind}: ${file.oldPath} → ${file.path}`;
  const hasCheck = checked !== undefined && onToggleCheck !== undefined;
  const rowClass =
    "file-row" +
    (focused === true ? " kb-focus" : "") +
    (active === true ? " active" : "") +
    (hasCheck ? " has-check" : "");
  // 체크박스와 액션 버튼은 행 버튼 안에 넣을 수 없다 (버튼 중첩은 클릭이 깨진다).
  // li를 기준 컨테이너로 삼아 좌우에 겹쳐 놓는다
  const basePad = 4 + (depth === undefined ? 0 : depth * 14);

  function handleCheck(event: MouseEvent<HTMLInputElement>) {
    event.stopPropagation();
    onToggleCheck?.(event.shiftKey);
  }

  return (
    <li className="file-row-shell">
      {hasCheck && (
        <input
          type="checkbox"
          className="file-check"
          style={{ left: basePad + 2 }}
          checked={checked}
          onClick={handleCheck}
          onChange={() => undefined}
          tabIndex={-1}
          aria-label={`Select ${file.path}`}
        />
      )}
      <button
        className={rowClass}
        onClick={onOpen}
        title={title}
        data-nav-index={navIndex}
        tabIndex={navIndex === undefined ? undefined : -1}
        aria-current={active === true ? "true" : undefined}
        style={{ paddingLeft: hasCheck ? basePad + 20 : basePad }}
      >
        <span
          className={untracked === true ? "file-icon st-U" : `file-icon st-${file.status}`}
          aria-hidden="true"
        >
          {untracked === true ? "U" : STATUS_LETTER[file.status]}
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
      {actions !== undefined && actions.length > 0 && (
        <span className="file-acts">
          {actions.map((action) => (
            <button
              key={action.key}
              className={action.danger === true ? "file-act danger" : "file-act"}
              onClick={action.onRun}
              disabled={action.disabled}
              title={action.label}
              aria-label={action.label}
              tabIndex={-1}
            >
              {action.glyph}
            </button>
          ))}
        </span>
      )}
    </li>
  );
}
