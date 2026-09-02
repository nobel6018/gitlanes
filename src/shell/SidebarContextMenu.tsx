import type { RefEntry } from "../types";
import { ContextMenu } from "./ContextMenu";
import type { MenuItem } from "./ContextMenu";

export interface SidebarContextMenuProps {
  x: number;
  y: number;
  /** 우클릭한 브랜치/태그 항목 */
  entry: RefEntry;
  onCopyName: (name: string) => void;
  /** undefined면 "Open on Remote" 항목을 아예 넣지 않는다 */
  onOpenOnRemote?: (ref: RefEntry) => void;
  /** 항목 클릭(=커밋 점프)과 같은 동작 */
  onJumpToCommit: (sha: string) => void;
  onClose: () => void;
}

/** 사이드바 항목 우클릭 메뉴. 위치 보정·바깥 클릭·Esc 닫힘은 공용 ContextMenu가 처리한다 */
export function SidebarContextMenu({
  x,
  y,
  entry,
  onCopyName,
  onOpenOnRemote,
  onJumpToCommit,
  onClose,
}: SidebarContextMenuProps) {
  const items: MenuItem[] = [{ label: "Copy Name", onSelect: () => onCopyName(entry.name) }];

  if (onOpenOnRemote !== undefined) {
    items.push({ label: "Open on Remote", onSelect: () => onOpenOnRemote(entry) });
  }

  items.push({ label: "Jump to Commit", onSelect: () => onJumpToCommit(entry.sha) });

  return <ContextMenu x={x} y={y} items={items} onClose={onClose} />;
}
