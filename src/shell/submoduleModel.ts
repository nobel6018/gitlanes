import type { SubmoduleChange, SubmoduleInfo } from "../types";

// 서브모듈 부품(SubmoduleList, SubmoduleChangePanel)의 순수 계산.
// tests/submodule-model.test.mts가 Node로 직접 돌릴 수 있게 런타임 import 없이 둔다.

/** 화면에 찍는 짧은 sha 길이. 백엔드 shortSha(7자)와 맞춘다 */
export const SHORT_SHA = 7;

export function shortSha(sha: string): string {
  return sha.slice(0, SHORT_SHA);
}

export type SubmoduleBadgeKind = "uninitialized" | "moved" | "conflict" | "dirty";

export interface SubmoduleBadge {
  kind: SubmoduleBadgeKind;
  label: string;
  title: string;
}

/**
 * 사이드바 행 오른쪽 상태 표시. ok는 아무것도 찍지 않는다(조용한 목록이 기본).
 * dirty는 상태와 별개라 moved와 함께 붙을 수 있다
 */
export function submoduleBadges(info: SubmoduleInfo): SubmoduleBadge[] {
  const badges: SubmoduleBadge[] = [];
  if (info.state === "uninitialized") {
    badges.push({ kind: "uninitialized", label: "uninit", title: "Not initialized" });
  } else if (info.state === "moved") {
    const head = info.headSha === null ? "" : ` (HEAD ${shortSha(info.headSha)})`;
    badges.push({
      kind: "moved",
      label: "moved",
      title: `Checked out commit differs from the recorded commit${head}`,
    });
  } else if (info.state === "conflict") {
    badges.push({ kind: "conflict", label: "conflict", title: "Submodule pointer is in conflict" });
  }
  if (info.dirty) {
    badges.push({ kind: "dirty", label: "dirty", title: "Has uncommitted changes inside the submodule" });
  }
  return badges;
}

/** 사이드바 행 툴팁. 경로, 상태, 기록된 커밋을 한 줄로 */
export function submoduleTitle(info: SubmoduleInfo): string {
  const parts = [info.path];
  const states: string[] = [info.state];
  if (info.dirty) {
    states.push("dirty");
  }
  parts.push(`(${states.join(", ")})`);
  if (info.recordedSha !== null) {
    parts.push(`at ${shortSha(info.recordedSha)}`);
  }
  if (info.url !== null) {
    parts.push(`from ${info.url}`);
  }
  return parts.join(" ");
}

export type PointerSummary =
  | { kind: "changed"; oldShort: string; newShort: string }
  | { kind: "added"; newShort: string }
  | { kind: "removed"; oldShort: string }
  | { kind: "same"; short: string }
  | { kind: "none" };

/** "old → new" 줄. 한쪽이 null이면 추가 또는 삭제 */
export function pointerSummary(change: SubmoduleChange): PointerSummary {
  const { oldSha, newSha } = change;
  if (oldSha !== null && newSha !== null) {
    return oldSha === newSha
      ? { kind: "same", short: shortSha(newSha) }
      : { kind: "changed", oldShort: shortSha(oldSha), newShort: shortSha(newSha) };
  }
  if (newSha !== null) {
    return { kind: "added", newShort: shortSha(newSha) };
  }
  if (oldSha !== null) {
    return { kind: "removed", oldShort: shortSha(oldSha) };
  }
  return { kind: "none" };
}

export interface PanelButtons {
  open: boolean;
  initialize: boolean;
}

/** 계약: Open은 info가 있고 uninitialized가 아닐 때, Initialize는 uninitialized일 때만 */
export function panelButtons(info: SubmoduleInfo | null): PanelButtons {
  if (info === null) {
    return { open: false, initialize: false };
  }
  const uninitialized = info.state === "uninitialized";
  return { open: !uninitialized, initialize: uninitialized };
}

/** available=false일 때 왜 커밋 목록이 없는지. available=true면 null */
export function unavailableReason(change: SubmoduleChange, info: SubmoduleInfo | null): string | null {
  if (change.available) {
    return null;
  }
  if (info === null) {
    return "This submodule is not in .gitmodules anymore, so its commits can't be listed.";
  }
  if (info.state === "uninitialized") {
    return "This submodule is not initialized, so its commits can't be listed. Initialize it to see what changed.";
  }
  return "These commits are not in the submodule's local repository. Fetch inside the submodule to list them.";
}

export interface CommitSectionSpec {
  key: "ahead" | "behind";
  title: string;
  more: boolean;
}

/**
 * 보여줄 커밋 목록 구간. 빈 구간은 빼서 흔한 fast-forward에 "Removed commits (0)"이 남지 않게 한다.
 * 둘 다 비면 빈 배열이고, 패널이 "No commits between these pointers"를 찍는다
 */
export function commitSections(change: SubmoduleChange): CommitSectionSpec[] {
  if (!change.available) {
    return [];
  }
  const sections: CommitSectionSpec[] = [];
  if (change.ahead.length > 0) {
    sections.push({ key: "ahead", title: `New commits (${change.ahead.length})`, more: change.aheadTruncated });
  }
  if (change.behind.length > 0) {
    sections.push({
      key: "behind",
      title: `Removed commits (${change.behind.length})`,
      more: change.behindTruncated,
    });
  }
  return sections;
}
