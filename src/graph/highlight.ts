// 선택 커밋의 조상, 자손 경로 강조. 집합 밖은 dim 처리한다.
// 로드된 rows의 parents만 보므로 범위 밖 조상은 자연히 빠진다.
// @see CONTRACTS.md "v0.7 확장" - 경로 강조
import type { CommitRow } from "../types";

/** 부모 sha → 자식 행 인덱스들. rows가 바뀔 때만 다시 만든다 */
export function buildChildrenMap(rows: CommitRow[]): Map<string, number[]> {
  const children = new Map<string, number[]>();
  for (let i = 0; i < rows.length; i++) {
    for (const parent of rows[i].parents) {
      const list = children.get(parent);
      if (list) {
        list.push(i);
      } else {
        children.set(parent, [i]);
      }
    }
  }
  return children;
}

/**
 * 선택 커밋 자신 + 조상 전체 + 자손 전체를 행 인덱스 기준 플래그로 돌려준다.
 * 엣지 판정(Edge.childRow/parentRow)과 행 dim 판정이 모두 O(1) 배열 접근이 된다.
 * 선택이 없거나 로드 범위 밖(스태시 sha 등)이면 null을 돌려 강조를 끈다.
 *
 * includeDescendants=false면 조상만 밝힌다. WIP 행 선택이 이 경우로,
 * 기준 커밋(HEAD)의 자손은 존재하지 않으므로 위로 뻗은 다른 브랜치까지 밝히면 안 된다.
 */
export function buildHighlight(
  rows: CommitRow[],
  shaToRow: Map<string, number>,
  children: Map<string, number[]>,
  selectedSha: string | null,
  includeDescendants = true,
): Uint8Array | null {
  if (selectedSha === null) {
    return null;
  }
  const start = shaToRow.get(selectedSha);
  if (start === undefined) {
    return null;
  }

  const lit = new Uint8Array(rows.length);
  lit[start] = 1;

  // 조상: parents를 따라 내려간다. lit 자체가 방문 표시라 사이클에도 멈춘다
  const upward = [start];
  while (upward.length > 0) {
    const index = upward.pop() as number;
    for (const parent of rows[index].parents) {
      const next = shaToRow.get(parent);
      if (next !== undefined && lit[next] === 0) {
        lit[next] = 1;
        upward.push(next);
      }
    }
  }

  if (!includeDescendants) {
    return lit;
  }

  // 자손: 자식 맵을 따라 올라간다
  const downward = [start];
  while (downward.length > 0) {
    const index = downward.pop() as number;
    const kids = children.get(rows[index].sha);
    if (!kids) {
      continue;
    }
    for (const child of kids) {
      if (lit[child] === 0) {
        lit[child] = 1;
        downward.push(child);
      }
    }
  }

  return lit;
}
