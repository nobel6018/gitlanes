import type { CommitRow, RebaseStep } from "../types";

// 그래프 다중 선택의 순수 계산. 배선은 RepoWorkspace(ui17-a)가 한다.
// 그래프 행 배열은 최신이 위(인덱스 0)다. 선택 sha 중 로드된 행에 없는 것은 순서를 정할 수 없어 버린다.

/** sha → 그래프 행 인덱스. 선택 중복과 로드 범위 밖 sha를 걸러 낸 결과만 담는다 */
function indexSelection(shas: string[], rows: CommitRow[]): { sha: string; index: number }[] {
  const wanted = new Set(shas);
  const found: { sha: string; index: number }[] = [];
  rows.forEach((row, index) => {
    if (wanted.has(row.sha)) found.push({ sha: row.sha, index });
  });
  return found;
}

/** 그래프 행 순서 기준. 오래된 것이 먼저 */
export function orderOldestFirst(shas: string[], rows: CommitRow[]): string[] {
  return indexSelection(shas, rows)
    .sort((a, b) => b.index - a.index)
    .map((item) => item.sha);
}

/** 최신이 먼저 */
export function orderNewestFirst(shas: string[], rows: CommitRow[]): string[] {
  return indexSelection(shas, rows)
    .sort((a, b) => a.index - b.index)
    .map((item) => item.sha);
}

/** 가장 오래된 선택 커밋의 첫 부모. 로드 범위 밖이거나 루트면 null */
export function squashBase(shas: string[], rows: CommitRow[]): string | null {
  // 선택 중 하나라도 로드된 행에 없으면 진짜 가장 오래된 커밋을 알 수 없다
  if (new Set(shas).size !== indexSelection(shas, rows).length) return null;
  const oldest = orderOldestFirst(shas, rows)[0];
  if (oldest === undefined) return null;
  const row = rows.find((r) => r.sha === oldest);
  // 부모 행이 로드돼 있을 필요는 없다. get_rebase_steps가 git에게 직접 묻는다
  return row?.parents[0] ?? null;
}

/** get_rebase_steps 결과에 squash 표시. 선택이 목록 안에서 연속이 아니면 { error } */
export function markSquash(
  steps: RebaseStep[],
  shas: string[],
): { steps: RebaseStep[] } | { error: string } {
  const selected = new Set(shas);
  if (selected.size < 2) {
    return { error: "Select at least two commits to squash." };
  }
  const positions: number[] = [];
  steps.forEach((step, i) => {
    if (selected.has(step.sha)) positions.push(i);
  });
  // 목록 밖 sha가 있거나(다른 브랜치, base 이전) 중간에 빠진 커밋이 있으면 거절한다
  const first = positions[0];
  const last = positions[positions.length - 1];
  if (
    positions.length !== selected.size ||
    first === undefined ||
    last === undefined ||
    last - first + 1 !== positions.length
  ) {
    return { error: "Squash needs consecutive commits on the current branch." };
  }
  return {
    steps: steps.map((step, i) => {
      if (i < first || i > last) return { ...step };
      // 덩어리의 첫 항목(가장 오래된 것)이 나머지를 받아 들인다
      return { ...step, action: i === first ? "pick" : "squash", message: null };
    }),
  };
}
