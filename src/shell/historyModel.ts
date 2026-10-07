import type { BlameHunk, BlameResult, CompareResult } from "../types";

// 파일 히스토리, blame, 비교 부품(FileHistoryPanel, BlameView, ComparePanel)의 순수 계산.
// tests/history-model.test.mts가 Node로 직접 돌릴 수 있게 런타임 import 없이 둔다.

/** 나이 색 단계 수. history.css의 .bl-age-0 ~ .bl-age-4와 맞춘다 */
export const AGE_LEVELS = 5;

/**
 * 줄마다 몇 번째 hunk에 속하는지 (0부터). 어느 hunk에도 없는 줄은 -1.
 * 백엔드가 순서대로 주더라도 범위를 벗어나거나 겹치는 hunk를 방어한다(먼저 온 hunk가 이긴다)
 */
export function lineHunkIndex(blame: BlameResult): Int32Array {
  const owner = new Int32Array(blame.lines.length).fill(-1);
  blame.hunks.forEach((hunk, index) => {
    const start = Math.max(0, hunk.startLine - 1);
    const end = Math.min(owner.length, hunk.startLine - 1 + hunk.lineCount);
    for (let line = start; line < end; line++) {
      if (owner[line] === -1) {
        owner[line] = index;
      }
    }
  });
  return owner;
}

/** 이 줄이 자기 구간의 첫 줄인가. 거터 정보는 구간 첫 줄에만 찍는다 */
export function isHunkStart(owner: Int32Array, line: number): boolean {
  const hunk = owner[line];
  if (hunk === undefined || hunk < 0) {
    return false;
  }
  return line === 0 || owner[line - 1] !== hunk;
}

/**
 * hunk마다 나이 단계 (0 = 가장 최근, AGE_LEVELS-1 = 가장 오래됨).
 * 시각을 선형으로 나누면 초기 커밋 하나가 범위를 늘려 나머지가 전부 같은 단계로 뭉친다.
 * 그래서 서로 다른 시각의 순위로 나눈다. 커밋 안 된 구간은 항상 0
 */
export function hunkAgeLevels(hunks: BlameHunk[], levels: number = AGE_LEVELS): number[] {
  const distinct = [
    ...new Set(hunks.filter((hunk) => !hunk.uncommitted).map((hunk) => hunk.timestamp)),
  ].sort((a, b) => b - a);
  const rank = new Map<number, number>();
  distinct.forEach((timestamp, index) => rank.set(timestamp, index));
  return hunks.map((hunk) => {
    if (hunk.uncommitted || distinct.length <= 1) {
      return 0;
    }
    const r = rank.get(hunk.timestamp) ?? 0;
    return Math.min(levels - 1, Math.floor((r * levels) / distinct.length));
  });
}

/** 고정 높이 가상 스크롤에서 그릴 줄 범위 [first, last) */
export function visibleRange(
  scrollTop: number,
  viewportHeight: number,
  count: number,
  lineHeight: number,
  overscan: number,
): { first: number; last: number } {
  const first = Math.max(0, Math.floor(scrollTop / lineHeight) - overscan);
  const last = Math.min(count, Math.ceil((scrollTop + viewportHeight) / lineHeight) + overscan);
  return { first, last: Math.max(first, last) };
}

/** 목록 키보드 이동. 비어 있으면 -1, 양 끝에서 멈춘다. 선택이 없을 때(-1) ↓는 첫 항목 */
export function moveIndex(current: number, delta: number, length: number): number {
  if (length <= 0) {
    return -1;
  }
  if (current < 0) {
    return delta < 0 ? length - 1 : 0;
  }
  return Math.max(0, Math.min(length - 1, current + delta));
}

/**
 * truncated는 결과 전체에 하나뿐이라 어느 목록이 잘렸는지 모른다.
 * limit에 걸린 쪽은 긴 쪽이므로 길이가 최댓값인 비어 있지 않은 목록에만 "+more"를 단다
 */
export function truncatedLists(result: CompareResult): { head: boolean; base: boolean } {
  if (!result.truncated) {
    return { head: false, base: false };
  }
  const max = Math.max(result.onlyInHead.length, result.onlyInBase.length);
  return {
    head: max > 0 && result.onlyInHead.length === max,
    base: max > 0 && result.onlyInBase.length === max,
  };
}
