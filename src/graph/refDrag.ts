// ref 드래그 payload 규약. ui-sidebar의 src/shell/dnd.ts와 같은 MIME을 쓰지만
// 패키지 경계를 넘지 않으려고 수신 측에서 따로 들고 있는다.
// GraphView는 payload를 해석하지 않고 원본 문자열 그대로 onRowDrop에 넘긴다.
// @see CONTRACTS.md "ui-graph"

import type { RefKind } from "../types";

/**
 * dataTransfer에 JSON 문자열로 담기는 ref 드래그 타입.
 * src/shell/dnd.ts의 REF_DRAG_MIME과 **반드시 같은 문자열이어야 한다.**
 * 갈라지면 타입 에러 없이 드롭만 조용히 안 먹는다. 한쪽을 고치면 다른 쪽도 고쳐라.
 */
export const REF_DRAG_MIME = "application/x-gitlanes-ref";

/** 스태시는 RefKind에 없어 여기서만 더한다. src/shell/dnd.ts의 RefDragKind와 같은 정의다 */
export type RefDragKind = RefKind | "stash";

/**
 * ui-sidebar가 싣는 payload 모양. GraphView는 참조만 하고 파싱하지 않는다.
 * dragover에서는 이 값을 읽을 수 없다. HTML5 DnD가 보안상 drop 이벤트 밖에서
 * getData()를 막기 때문에, 드롭 가능 판정은 dataTransfer.types로만 한다.
 */
export interface RefDragPayload {
  kind: RefDragKind;
  name: string;
  sha: string;
}
