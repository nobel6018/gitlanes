// ref 드래그 payload 규약. ui-sidebar의 src/shell/dnd.ts와 같은 MIME을 쓰지만
// 패키지 경계를 넘지 않으려고 수신 측에서 따로 들고 있는다.
// GraphView는 payload를 해석하지 않고 원본 문자열 그대로 onRowDrop에 넘긴다.
// @see CONTRACTS.md "ui-graph"

/** dataTransfer에 JSON 문자열로 담기는 ref 드래그 타입 */
export const REF_DRAG_MIME = "application/x-gitlanes-ref";

/** ui-sidebar가 싣는 payload 모양. GraphView는 참조만 하고 파싱하지 않는다 */
export interface RefDragPayload {
  kind: "localBranch" | "remoteBranch" | "tag" | "stash";
  name: string;
  sha: string;
}
