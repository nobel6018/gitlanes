// 사이드바 SUBMODULES 구간의 안쪽 내용. 계약: CONTRACTS.md v0.19 "SubmoduleListProps".
// 구간 머리, 접기, "Update All"은 BranchSidebar 몫이고 여기는 <ul class="sb-list"> 안에 들어갈 <li>만 낸다.
import type { MouseEvent } from "react";
import type { SubmoduleInfo } from "../types";
import { splitPath } from "./format";
import { SubmoduleIcon } from "./FileRow";
import { submoduleBadges, submoduleTitle } from "./submoduleModel";
import "./submodule.css";

export interface SubmoduleListProps {
  submodules: SubmoduleInfo[];
  selectedPath: string | null;
  /** 쓰기 중이면 버튼 비활성 */
  busy: boolean;
  /** 새 탭. uninitialized면 부르지 않는다 */
  onOpen(sub: SubmoduleInfo): void;
  onSelect(sub: SubmoduleInfo): void;
  onContextMenu(sub: SubmoduleInfo, x: number, y: number): void;
}

export function SubmoduleList({
  submodules,
  selectedPath,
  busy,
  onOpen,
  onSelect,
  onContextMenu,
}: SubmoduleListProps) {
  return (
    <>
      {submodules.map((sub) => (
        <li key={sub.path}>
          <SubmoduleRow
            sub={sub}
            selected={sub.path === selectedPath}
            busy={busy}
            onOpen={onOpen}
            onSelect={onSelect}
            onContextMenu={onContextMenu}
          />
        </li>
      ))}
    </>
  );
}

interface SubmoduleRowProps {
  sub: SubmoduleInfo;
  selected: boolean;
  busy: boolean;
  onOpen(sub: SubmoduleInfo): void;
  onSelect(sub: SubmoduleInfo): void;
  onContextMenu(sub: SubmoduleInfo, x: number, y: number): void;
}

function SubmoduleRow({ sub, selected, busy, onOpen, onSelect, onContextMenu }: SubmoduleRowProps) {
  const uninitialized = sub.state === "uninitialized";
  // update가 도는 중에 열면 반쯤 옮겨진 체크아웃을 보게 되므로 쓰기 중에는 열기도 막는다
  const canOpen = !uninitialized && !busy;
  const { dir, base } = splitPath(sub.path);
  const classes = ["sb-item", "sb-submodule"];
  if (selected) {
    classes.push("selected");
  }
  if (uninitialized) {
    classes.push("uninitialized");
  }

  const handleContextMenu = (event: MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    onContextMenu(sub, event.clientX, event.clientY);
  };

  return (
    <button
      className={classes.join(" ")}
      // 사이드바 다른 행(indentOf(0, false))과 같은 들여쓰기
      style={{ paddingLeft: 13 }}
      onClick={() => onSelect(sub)}
      onDoubleClick={() => {
        if (canOpen) {
          onOpen(sub);
        }
      }}
      onContextMenu={handleContextMenu}
      title={submoduleTitle(sub)}
      aria-current={selected ? "true" : undefined}
    >
      <span className="sb-check sm-row-icon" aria-hidden="true">
        <SubmoduleIcon size={10} />
      </span>
      <span className="sb-label">
        {base}
        {dir !== "" && <span className="sm-dir">{dir.replace(/\/$/, "")}</span>}
      </span>
      {submoduleBadges(sub).map((badge) => (
        <span key={badge.kind} className={`sm-badge sm-${badge.kind}`} title={badge.title}>
          {badge.label}
        </span>
      ))}
    </button>
  );
}
