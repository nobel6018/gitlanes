// 의사 행(WIP, 스태시) 삽입 레이아웃.
// 커밋 배열 인덱스와 화면 행 인덱스(display index)를 잇는 유일한 지점이라,
// GraphView(DOM)와 canvas.ts(캔버스)가 같은 좌표를 보게 하려면 여기만 고치면 된다.
// @see CONTRACTS.md "v0.3 확장", "v0.2 확장"
import type { CommitRow, StashInfo, WipInfo } from "../types";

export type PseudoKind = "wip" | "stash";

interface PseudoBase {
  key: string;
  /** 이 의사 행이 바로 위에 붙는 커밋 행 인덱스 */
  anchorRow: number;
  /** 화면 행 인덱스 */
  displayIndex: number;
  /** 앵커 커밋의 레인과 색 (그래프 마크 위치) */
  lane: number;
  color: number;
  /** 바로 아래 행까지 점선 엣지를 그릴지. 앵커 커밋이 없으면 false */
  connected: boolean;
}

export interface WipPseudoRow extends PseudoBase {
  kind: "wip";
  wip: WipInfo;
  stash?: undefined;
}

export interface StashPseudoRow extends PseudoBase {
  kind: "stash";
  stash: StashInfo;
  wip?: undefined;
}

export type PseudoRow = WipPseudoRow | StashPseudoRow;

export interface PseudoLayout {
  /** displayIndex 오름차순 */
  pseudos: PseudoRow[];
  /** 커밋 행 + 의사 행 총 개수 */
  displayCount: number;
  /** 커밋 행 인덱스 → 화면 행 인덱스 */
  toDisplay: (rowIndex: number) => number;
  /** 화면 행 인덱스 → 커밋 행 인덱스. 의사 행 위치면 그 앵커 커밋을 가리킨다 */
  toRowIndex: (displayIndex: number) => number;
  /** 이 화면 행이 의사 행이면 반환, 커밋 행이면 null */
  pseudoAt: (displayIndex: number) => PseudoRow | null;
}

const KIND_ORDER: Record<PseudoKind, number> = { wip: 0, stash: 1 };

/** sorted에서 value 이하인 원소 개수 */
function countAtMost(sorted: number[], value: number): number {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid] <= value) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }
  return lo;
}

/** sorted에서 value 미만인 원소 개수 */
function countBelow(sorted: number[], value: number): number {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid] < value) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }
  return lo;
}

/**
 * WIP과 스태시를 앵커 커밋 바로 위에 꽂아 화면 행 매핑을 만든다.
 * 같은 커밋 위에 여러 개가 겹치면 WIP이 맨 위, 그다음 최신 스태시 순이다.
 * 스태시의 baseSha가 로드 범위 밖이면 그 스태시는 빠진다.
 */
export function buildPseudoLayout(
  rows: CommitRow[],
  wip: WipInfo | null,
  stashes: StashInfo[],
  shaToRow: Map<string, number>,
): PseudoLayout {
  type Draft = Omit<WipPseudoRow, "displayIndex"> | Omit<StashPseudoRow, "displayIndex">;
  const drafts: Draft[] = [];

  if (wip) {
    // isHead 행이 없으면(detached 등) 맨 위에 두고 엣지는 생략한다
    const headIndex = rows.findIndex((row) => row.isHead);
    const anchorRow = Math.max(headIndex, 0);
    const anchor = rows[anchorRow];
    drafts.push({
      key: "wip",
      kind: "wip",
      anchorRow,
      lane: anchor ? anchor.lane : 0,
      color: anchor ? anchor.color : 0,
      connected: headIndex >= 0,
      wip,
    });
  }

  for (const stash of stashes) {
    const anchorRow = shaToRow.get(stash.baseSha);
    if (anchorRow === undefined) {
      continue;
    }
    const anchor = rows[anchorRow];
    drafts.push({
      key: `stash:${stash.sha}`,
      kind: "stash",
      anchorRow,
      lane: anchor.lane,
      color: anchor.color,
      connected: true,
      stash,
    });
  }

  drafts.sort((a, b) => {
    if (a.anchorRow !== b.anchorRow) {
      return a.anchorRow - b.anchorRow;
    }
    if (a.kind !== b.kind) {
      return KIND_ORDER[a.kind] - KIND_ORDER[b.kind];
    }
    const at = a.stash ? a.stash.timestamp : 0;
    const bt = b.stash ? b.stash.timestamp : 0;
    if (at !== bt) {
      return bt - at;
    }
    return a.key.localeCompare(b.key);
  });

  // 앞선 의사 행 k개가 이 행을 k칸 아래로 민다
  const pseudos: PseudoRow[] = drafts.map((draft, k) => ({
    ...draft,
    displayIndex: draft.anchorRow + k,
  }));

  const anchors = pseudos.map((p) => p.anchorRow);
  const displays = pseudos.map((p) => p.displayIndex);

  return {
    pseudos,
    displayCount: rows.length + pseudos.length,
    toDisplay: (rowIndex) => rowIndex + countAtMost(anchors, rowIndex),
    toRowIndex: (displayIndex) => displayIndex - countBelow(displays, displayIndex),
    pseudoAt: (displayIndex) => {
      const at = countBelow(displays, displayIndex);
      return at < displays.length && displays[at] === displayIndex ? pseudos[at] : null;
    },
  };
}
