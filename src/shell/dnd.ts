// ref 드래그 앤 드롭 공용 계약 (v0.18).
//
// 사이드바와 그래프 캔버스가 같은 dataTransfer 포맷을 읽어야 해서 직렬화/역직렬화를
// 여기 한 곳에 모았다. 그래프(ui-graph)의 onRowDrop은 payload를 문자열로 받으므로
// DataTransfer 없이도 쓸 수 있게 parseRefDrag를 따로 뽑아 뒀다.

import type { RefKind } from "../types";

/** 우리 드래그를 식별하는 MIME. 다른 앱에서 끌어온 텍스트와 섞이지 않게 커스텀 타입을 쓴다 */
export const REF_DRAG_MIME = "application/x-gitlanes-ref";

/** 스태시는 RefKind에 없지만 같은 채널로 흐른다 */
export type RefDragKind = RefKind | "stash";

export interface RefDragPayload {
  kind: RefDragKind;
  /** "main", "origin/main", "v1.0", "stash@{0}" */
  name: string;
  sha: string;
}

export function writeRefDrag(dt: DataTransfer, payload: RefDragPayload): void {
  dt.setData(REF_DRAG_MIME, JSON.stringify(payload));
  // 커스텀 MIME만 실으면 드래그 자체가 시작되지 않는 웹뷰가 있다. text/plain을 보험으로 같이 싣는다
  dt.setData("text/plain", payload.name);
  dt.effectAllowed = "move";
}

export function readRefDrag(dt: DataTransfer): RefDragPayload | null {
  return parseRefDrag(dt.getData(REF_DRAG_MIME));
}

/** 문자열 payload를 검증하며 푼다. 모양이 다르면 null (남의 드래그를 잘못 먹지 않게) */
export function parseRefDrag(raw: string): RefDragPayload | null {
  if (raw === "") {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }
    const record = parsed as Record<string, unknown>;
    const { kind, name, sha } = record;
    if (typeof name !== "string" || typeof sha !== "string" || typeof kind !== "string") {
      return null;
    }
    if (kind !== "localBranch" && kind !== "remoteBranch" && kind !== "tag" && kind !== "stash") {
      return null;
    }
    return { kind, name, sha };
  } catch {
    return null;
  }
}

/**
 * dragover 단계에서는 보안상 getData가 빈 문자열을 돌려준다.
 * 그래서 드롭 가능 여부는 types 목록만 보고 판단해야 한다.
 */
export function hasRefDrag(dt: DataTransfer): boolean {
  for (const type of dt.types) {
    if (type === REF_DRAG_MIME) {
      return true;
    }
  }
  return false;
}
