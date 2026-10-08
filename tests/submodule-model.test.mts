// 서브모듈 부품의 순수 함수(src/shell/submoduleModel.ts) 단위 테스트.
//
// 실행: node tests/submodule-model.test.mts   (Node 24+, 또는 22.18+. TS 직접 실행)
// 종료 코드: 실패가 하나라도 있으면 1.

import process from "node:process";
import type { CommitSummary, SubmoduleChange, SubmoduleInfo } from "../src/types.ts";
import {
  commitSections,
  panelButtons,
  pointerSummary,
  shortSha,
  submoduleBadges,
  submoduleTitle,
  unavailableReason,
} from "../src/shell/submoduleModel.ts";

let assertions = 0;
const failures: string[] = [];

function eq(actual: unknown, expected: unknown, what: string): void {
  assertions += 1;
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) failures.push(`${what}\n    expected ${e}\n    actual   ${a}`);
}

const A = "a".repeat(40);
const B = "b".repeat(40);

function info(patch: Partial<SubmoduleInfo> = {}): SubmoduleInfo {
  return {
    name: "libs/core",
    path: "libs/core",
    url: "https://example.com/core.git",
    branch: null,
    recordedSha: A,
    headSha: A,
    state: "ok",
    dirty: false,
    ...patch,
  };
}

function commit(sha: string): CommitSummary {
  return { sha, shortSha: shortSha(sha), subject: `s ${sha[0]}`, author: "dev", timestamp: 1_700_000_000 };
}

function change(patch: Partial<SubmoduleChange> = {}): SubmoduleChange {
  return {
    path: "libs/core",
    oldSha: A,
    newSha: B,
    dirty: false,
    available: true,
    ahead: [],
    behind: [],
    aheadTruncated: false,
    behindTruncated: false,
    ...patch,
  };
}

// ---------- 배지 ----------
eq(submoduleBadges(info()), [], "ok는 배지 없음");
eq(
  submoduleBadges(info({ state: "uninitialized", headSha: null })).map((b) => b.kind),
  ["uninitialized"],
  "uninitialized 배지",
);
eq(
  submoduleBadges(info({ state: "moved", headSha: B, dirty: true })).map((b) => b.kind),
  ["moved", "dirty"],
  "moved와 dirty는 함께 붙는다",
);
eq(submoduleBadges(info({ state: "moved", headSha: B }))[0]?.title.includes("bbbbbbb"), true, "moved 툴팁에 HEAD 짧은 sha");
eq(submoduleBadges(info({ state: "conflict", recordedSha: null })).map((b) => b.kind), ["conflict"], "conflict 배지");
eq(submoduleBadges(info({ dirty: true })).map((b) => b.kind), ["dirty"], "ok + dirty");

// ---------- 툴팁 ----------
eq(
  submoduleTitle(info({ state: "moved", dirty: true })),
  "libs/core (moved, dirty) at aaaaaaa from https://example.com/core.git",
  "툴팁 전체",
);
eq(submoduleTitle(info({ recordedSha: null, url: null })), "libs/core (ok)", "sha, url 없으면 생략");

// ---------- old → new ----------
eq(pointerSummary(change()), { kind: "changed", oldShort: "aaaaaaa", newShort: "bbbbbbb" }, "changed");
eq(pointerSummary(change({ oldSha: null })), { kind: "added", newShort: "bbbbbbb" }, "added");
eq(pointerSummary(change({ newSha: null })), { kind: "removed", oldShort: "aaaaaaa" }, "removed");
eq(pointerSummary(change({ newSha: A })), { kind: "same", short: "aaaaaaa" }, "same (unstaged dirty만)");
eq(pointerSummary(change({ oldSha: null, newSha: null })), { kind: "none" }, "양쪽 null");

// ---------- 버튼 노출 (계약) ----------
eq(panelButtons(null), { open: false, initialize: false }, "info 없으면 버튼 없음");
eq(panelButtons(info()), { open: true, initialize: false }, "ok면 Open만");
eq(panelButtons(info({ state: "moved" })), { open: true, initialize: false }, "moved면 Open만");
eq(panelButtons(info({ state: "conflict" })), { open: true, initialize: false }, "conflict면 Open만");
eq(panelButtons(info({ state: "uninitialized" })), { open: false, initialize: true }, "uninitialized면 Initialize만");

// ---------- available=false 안내 ----------
eq(unavailableReason(change(), info()), null, "available이면 안내 없음");
eq(
  unavailableReason(change({ available: false }), info({ state: "uninitialized" }))?.includes("not initialized"),
  true,
  "uninitialized 안내",
);
eq(unavailableReason(change({ available: false }), info())?.includes("Fetch"), true, "커밋 없음 안내는 fetch 권유");
eq(unavailableReason(change({ available: false }), null)?.includes(".gitmodules"), true, "삭제된 서브모듈 안내");

// ---------- 커밋 구간 ----------
eq(commitSections(change()), [], "둘 다 비면 구간 없음");
eq(
  commitSections(change({ ahead: [commit(B), commit(A)], aheadTruncated: true })),
  [{ key: "ahead", title: "New commits (2)", more: true }],
  "fast-forward는 New만, truncated면 more",
);
eq(
  commitSections(change({ ahead: [commit(B)], behind: [commit(A)] })),
  [
    { key: "ahead", title: "New commits (1)", more: false },
    { key: "behind", title: "Removed commits (1)", more: false },
  ],
  "갈라진 포인터는 두 구간, New가 먼저",
);
eq(
  commitSections(change({ available: false, ahead: [commit(B)] })),
  [],
  "available=false면 목록을 그리지 않는다",
);

// ── 결과 ───────────────────────────────────────────────
for (const f of failures) console.log(`FAIL ${f}`);
console.log(`${assertions - failures.length}/${assertions} assertions passed`);
if (failures.length > 0) process.exitCode = 1;
