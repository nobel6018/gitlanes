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
  /** 아래 쓰기 작업 콜백은 undefined면 항목을 숨긴다 */
  onCheckout?: (ref: RefEntry) => void;
  onCreateBranchFrom?: (ref: RefEntry) => void;
  onMergeIntoCurrent?: (ref: RefEntry) => void;
  onPushBranch?: (ref: RefEntry) => void;
  onDeleteBranch?: (ref: RefEntry) => void;
  onClose: () => void;
}

/**
 * 사이드바 항목 우클릭 메뉴. 위치 보정·바깥 클릭·Esc 닫힘은 공용 ContextMenu가 처리한다.
 *
 * 표시 규칙
 * - isHead(현재 브랜치): Checkout / Merge 숨김, Delete는 비활성(이유를 title로)
 * - 원격 브랜치: Delete / Push 숨김 (Checkout은 추적 브랜치 생성)
 * - 태그: Checkout(detached) / Create branch here… 만, 머지·푸시·삭제는 숨김
 * - "…"이 붙은 항목은 셸이 다이얼로그를 띄운다는 표시
 */
export function SidebarContextMenu(props: SidebarContextMenuProps) {
  return (
    <ContextMenu x={props.x} y={props.y} items={buildItems(props)} onClose={props.onClose} />
  );
}

function buildItems(props: SidebarContextMenuProps): MenuItem[] {
  const {
    entry,
    onCopyName,
    onOpenOnRemote,
    onJumpToCommit,
    onCheckout,
    onCreateBranchFrom,
    onMergeIntoCurrent,
    onPushBranch,
    onDeleteBranch,
  } = props;

  const isTag = entry.kind === "tag";
  const isLocal = entry.kind === "localBranch";

  const branchOps: MenuItem[] = [];
  if (onCheckout !== undefined && !entry.isHead) {
    branchOps.push({
      label: isTag ? "Checkout (detached)" : "Checkout",
      onSelect: () => onCheckout(entry),
    });
  }
  if (onCreateBranchFrom !== undefined) {
    branchOps.push({
      label: "Create branch here…",
      onSelect: () => onCreateBranchFrom(entry),
    });
  }
  if (onMergeIntoCurrent !== undefined && !isTag && !entry.isHead) {
    branchOps.push({
      label: "Merge into current…",
      onSelect: () => onMergeIntoCurrent(entry),
    });
  }

  const pushOps: MenuItem[] = [];
  if (onPushBranch !== undefined && isLocal) {
    pushOps.push({ label: "Push branch", onSelect: () => onPushBranch(entry) });
  }

  const commonOps: MenuItem[] = [{ label: "Copy Name", onSelect: () => onCopyName(entry.name) }];
  if (onOpenOnRemote !== undefined) {
    commonOps.push({ label: "Open on Remote", onSelect: () => onOpenOnRemote(entry) });
  }
  commonOps.push({ label: "Jump to Commit", onSelect: () => onJumpToCommit(entry.sha) });

  const dangerOps: MenuItem[] = [];
  if (onDeleteBranch !== undefined && isLocal) {
    dangerOps.push({
      label: "Delete branch…",
      danger: true,
      disabled: entry.isHead,
      title: entry.isHead ? "현재 체크아웃된 브랜치는 삭제할 수 없습니다" : undefined,
      onSelect: () => onDeleteBranch(entry),
    });
  }

  // 빈 그룹을 버린 뒤 각 그룹의 첫 항목에만 구분선을 달아
  // 구분선이 겹치거나 맨 위에 남지 않게 한다
  return [branchOps, pushOps, commonOps, dangerOps]
    .filter((group) => group.length > 0)
    .flatMap((group, groupIndex) =>
      group.map((item, itemIndex) =>
        groupIndex > 0 && itemIndex === 0 ? { ...item, separatorBefore: true } : item,
      ),
    );
}
