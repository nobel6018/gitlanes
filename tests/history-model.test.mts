// 파일 히스토리, blame, 비교 부품의 순수 함수(src/shell/historyModel.ts) 단위 테스트.
//
// 실행: node tests/history-model.test.mts   (Node 24+, 또는 22.18+. TS 직접 실행)
// 종료 코드: 실패가 하나라도 있으면 1.

import process from "node:process";
import type { BlameHunk, BlameResult, CommitSummary, CompareResult } from "../src/types.ts";
import {
  AGE_LEVELS,
  hunkAgeLevels,
  isHunkStart,
  lineHunkIndex,
  moveIndex,
  truncatedLists,
  visibleRange,
} from "../src/shell/historyModel.ts";

let assertions = 0;
const failures: string[] = [];

function eq(actual: unknown, expected: unknown, what: string): void {
  assertions += 1;
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) failures.push(`${what}\n    expected ${e}\n    actual   ${a}`);
}

function hunk(sha: string, startLine: number, lineCount: number, timestamp: number, uncommitted = false): BlameHunk {
  return {
    sha,
    shortSha: sha.slice(0, 7),
    author: "Tester",
    authorEmail: "t@example.com",
    timestamp,
    summary: `summary ${sha}`,
    startLine,
    lineCount,
    uncommitted,
  };
}

function lines(n: number): string[] {
  return Array.from({ length: n }, (_, i) => `line ${i + 1}`);
}

// ── lineHunkIndex, isHunkStart ─────────────────────────
const blame: BlameResult = {
  lines: lines(6),
  hunks: [hunk("a", 1, 2, 100), hunk("b", 3, 1, 200), hunk("a", 4, 3, 100)],
};
const owner = lineHunkIndex(blame);
eq([...owner], [0, 0, 1, 2, 2, 2], "lineHunkIndex: 줄마다 hunk 인덱스");
eq(
  [0, 1, 2, 3, 4, 5].map((i) => isHunkStart(owner, i)),
  [true, false, true, true, false, false],
  "isHunkStart: 같은 sha라도 hunk가 다르면 새 구간",
);

const gappy = lineHunkIndex({ lines: lines(4), hunks: [hunk("a", 2, 1, 1)] });
eq([...gappy], [-1, 0, -1, -1], "lineHunkIndex: 덮이지 않는 줄은 -1");
eq(isHunkStart(gappy, 0), false, "isHunkStart: -1 줄은 구간 시작이 아니다");

const overflow = lineHunkIndex({ lines: lines(3), hunks: [hunk("a", 2, 10, 1), hunk("b", 0, 2, 1)] });
eq([...overflow], [1, 0, 0], "lineHunkIndex: 범위 밖은 자르고 겹치면 먼저 온 hunk가 이긴다");

eq([...lineHunkIndex({ lines: [], hunks: [] })], [], "lineHunkIndex: 빈 파일");

// ── hunkAgeLevels ──────────────────────────────────────
eq(
  hunkAgeLevels([hunk("a", 1, 1, 500), hunk("b", 2, 1, 400), hunk("c", 3, 1, 300), hunk("d", 4, 1, 200), hunk("e", 5, 1, 100)]),
  [0, 1, 2, 3, 4],
  "hunkAgeLevels: 다섯 시각이면 한 단계씩",
);
eq(
  hunkAgeLevels([hunk("a", 1, 1, 1_000_000), hunk("b", 2, 1, 999_000), hunk("c", 3, 1, 1)]),
  [0, 1, 3],
  "hunkAgeLevels: 아주 오래된 커밋 하나가 나머지를 한 단계로 뭉치지 않는다(순위 기준)",
);
eq(hunkAgeLevels([hunk("a", 1, 1, 7), hunk("b", 2, 1, 7)]), [0, 0], "hunkAgeLevels: 시각이 하나뿐이면 전부 0");
eq(
  hunkAgeLevels([hunk("w", 1, 1, 9999, true), hunk("a", 2, 1, 10), hunk("b", 3, 1, 5)]),
  [0, 0, 2],
  "hunkAgeLevels: 커밋 안 된 구간은 0이고 순위 계산에서 빠진다",
);
const many = hunkAgeLevels(Array.from({ length: 40 }, (_, i) => hunk(String(i), i + 1, 1, 1000 - i)));
eq(Math.max(...many), AGE_LEVELS - 1, "hunkAgeLevels: 단계는 AGE_LEVELS-1을 넘지 않는다");
eq(many[0], 0, "hunkAgeLevels: 가장 최근은 0");

// ── visibleRange ───────────────────────────────────────
eq(visibleRange(0, 200, 5000, 20, 30), { first: 0, last: 40 }, "visibleRange: 맨 위");
eq(visibleRange(2000, 200, 5000, 20, 30), { first: 70, last: 140 }, "visibleRange: 중간");
eq(visibleRange(99_800, 200, 5000, 20, 30), { first: 4960, last: 5000 }, "visibleRange: 끝에서 count로 자른다");
eq(visibleRange(0, 200, 0, 20, 30), { first: 0, last: 0 }, "visibleRange: 빈 목록");

// ── moveIndex ──────────────────────────────────────────
eq(moveIndex(-1, 1, 3), 0, "moveIndex: 선택 없음에서 ↓는 첫 항목");
eq(moveIndex(-1, -1, 3), 2, "moveIndex: 선택 없음에서 ↑는 마지막 항목");
eq(moveIndex(2, 1, 3), 2, "moveIndex: 끝에서 멈춘다");
eq(moveIndex(0, -1, 3), 0, "moveIndex: 처음에서 멈춘다");
eq(moveIndex(1, 1, 3), 2, "moveIndex: 한 칸 이동");
eq(moveIndex(0, 1, 0), -1, "moveIndex: 빈 목록은 -1");

// ── truncatedLists ─────────────────────────────────────
function commits(n: number): CommitSummary[] {
  return Array.from({ length: n }, (_, i) => ({
    sha: `s${i}`,
    shortSha: `s${i}`,
    subject: "x",
    author: "T",
    timestamp: 0,
  }));
}
function compare(head: number, base: number, truncated: boolean): CompareResult {
  return {
    base: "main",
    head: "feature",
    mergeBase: "m",
    onlyInHead: commits(head),
    onlyInBase: commits(base),
    truncated,
    files: [],
  };
}
eq(truncatedLists(compare(500, 3, false)), { head: false, base: false }, "truncatedLists: 안 잘렸으면 둘 다 false");
eq(truncatedLists(compare(500, 3, true)), { head: true, base: false }, "truncatedLists: 긴 쪽에만 +more");
eq(truncatedLists(compare(500, 500, true)), { head: true, base: true }, "truncatedLists: 같으면 둘 다");
eq(truncatedLists(compare(0, 0, true)), { head: false, base: false }, "truncatedLists: 빈 목록에는 달지 않는다");

// ── 결과 ───────────────────────────────────────────────
for (const f of failures) console.log(`FAIL ${f}`);
console.log(`${assertions - failures.length}/${assertions} assertions passed`);
if (failures.length > 0) process.exitCode = 1;
