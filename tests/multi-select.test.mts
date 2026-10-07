// 그래프 다중 선택 순수 함수(src/shell/multiSelect.ts) 단위 테스트.
//
// 실행: node tests/multi-select.test.mts   (Node 24+, 또는 22.18+. TS 직접 실행)
// 종료 코드: 실패가 하나라도 있으면 1.

import process from "node:process";
import type { CommitRow, RebaseStep } from "../src/types.ts";
import { markSquash, orderNewestFirst, orderOldestFirst, squashBase } from "../src/shell/multiSelect.ts";

let assertions = 0;
const failures: string[] = [];

function eq(actual: unknown, expected: unknown, what: string): void {
  assertions += 1;
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) failures.push(`${what}\n    expected ${e}\n    actual   ${a}`);
}

function row(sha: string, parents: string[]): CommitRow {
  return {
    sha,
    shortSha: sha.slice(0, 10),
    subject: `subject ${sha}`,
    author: "Tester",
    authorEmail: "t@example.com",
    timestamp: 0,
    parents,
    lane: 0,
    color: 0,
    isHead: false,
    isMerge: parents.length > 1,
    refs: [],
    edges: [],
  };
}

function step(sha: string): RebaseStep {
  return { sha, action: "pick", subject: `subject ${sha}`, message: null };
}

// 그래프 순서: 최신이 위. e → d → c → b → a(루트). x는 다른 브랜치(부모 c)
const rows: CommitRow[] = [
  row("e", ["d"]),
  row("x", ["c"]),
  row("d", ["c"]),
  row("c", ["b"]),
  row("b", ["a"]),
  row("a", []),
];

// ── 순서 ───────────────────────────────────────────────
eq(orderOldestFirst(["e", "b", "d"], rows), ["b", "d", "e"], "orderOldestFirst: 선택 순서와 무관하게 오래된 것부터");
eq(orderNewestFirst(["b", "e", "d"], rows), ["e", "d", "b"], "orderNewestFirst: 최신부터");
eq(orderOldestFirst(["d", "d", "c"], rows), ["c", "d"], "orderOldestFirst: 중복 제거");
eq(orderOldestFirst(["d", "zz"], rows), ["d"], "orderOldestFirst: 로드 범위 밖 sha는 버림");
eq(orderNewestFirst([], rows), [], "orderNewestFirst: 빈 선택");

// ── squashBase ─────────────────────────────────────────
eq(squashBase(["e", "c", "d"], rows), "b", "squashBase: 가장 오래된 선택(c)의 첫 부모");
eq(squashBase(["b", "c"], rows), "a", "squashBase: 부모가 루트여도 부모 sha");
eq(squashBase(["a", "b"], rows), null, "squashBase: 가장 오래된 선택이 루트면 null");
eq(squashBase(["e", "zz"], rows), null, "squashBase: 선택에 로드 범위 밖 sha가 있으면 null");
eq(squashBase([], rows), null, "squashBase: 빈 선택이면 null");
eq(squashBase(["e"], [row("e", ["d"])]), "d", "squashBase: 부모 행이 로드돼 있지 않아도 sha는 돌려줌");

// ── markSquash ─────────────────────────────────────────
// get_rebase_steps(base=b) 결과: todo 순서(오래된 것이 먼저)
const steps: RebaseStep[] = [step("c"), step("d"), step("e")];

const all = markSquash(steps, ["e", "c", "d"]);
eq(
  "steps" in all ? all.steps.map((s) => s.action) : all,
  ["pick", "squash", "squash"],
  "markSquash: 전체 연속, 첫 항목 pick 나머지 squash",
);
eq("steps" in all ? all.steps.map((s) => s.sha) : all, ["c", "d", "e"], "markSquash: 순서 보존");

const tail = markSquash(steps, ["e", "d"]);
eq(
  "steps" in tail ? tail.steps.map((s) => s.action) : tail,
  ["pick", "pick", "squash"],
  "markSquash: 덩어리 밖 커밋은 pick 유지",
);

const gap = markSquash(steps, ["c", "e"]);
eq(gap, { error: "Squash needs consecutive commits on the current branch." }, "markSquash: 비연속이면 error");

const outside = markSquash(steps, ["d", "x"]);
eq(outside, { error: "Squash needs consecutive commits on the current branch." }, "markSquash: 목록 밖 sha면 error");

const single = markSquash(steps, ["d"]);
eq("error" in single, true, "markSquash: 하나만 선택하면 error");

const dup = markSquash(steps, ["d", "d"]);
eq("error" in dup, true, "markSquash: 중복 sha 하나는 한 개 선택으로 취급");

// 입력 배열을 고치지 않는다
eq(steps.map((s) => s.action), ["pick", "pick", "pick"], "markSquash: 입력 steps 불변");

// ── 결과 ───────────────────────────────────────────────
for (const f of failures) console.log(`FAIL ${f}`);
console.log(`${assertions - failures.length}/${assertions} assertions passed`);
if (failures.length > 0) process.exitCode = 1;
