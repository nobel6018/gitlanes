// 커밋 메시지에서 PR 링크를 찾는 순수 함수(src/shell/prLink.ts) 단위 테스트.
//
// 실행: node tests/pr-link.test.mts   (Node 24+, 또는 22.18+. TS 직접 실행)
// 종료 코드: 실패가 하나라도 있으면 1.

import process from "node:process";
import { findPrRef, splitSubject } from "../src/shell/prLink.ts";

let assertions = 0;
const failures: string[] = [];

function eq(actual: unknown, expected: unknown, what: string): void {
  assertions += 1;
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) failures.push(`${what}\n    expected ${e}\n    actual   ${a}`);
}

const GH = "https://github.com/nobel6018/gitlanes";

function find(subject: string, body = "", remoteUrl = GH) {
  return findPrRef({ subject, body, remoteUrl });
}

// ── GitHub ─────────────────────────────────────────────
eq(
  find("Merge pull request #61 from nobel6018/release/v0.20.1"),
  { number: 61, token: { text: "#61", start: 19 }, url: `${GH}/pull/61` },
  "GitHub 머지 커밋",
);
eq(
  find("feat(graph): 레인 색 고정 (#123)"),
  { number: 123, token: { text: "#123", start: 22 }, url: `${GH}/pull/123` },
  "GitHub squash 꼬리",
);
eq(find("fix: crash (#9)  ")?.number, 9, "squash 꼬리 뒤 공백 허용");
eq(find("Fix #12 regression")?.number, undefined, "본문 속 이슈 참조는 PR로 보지 않는다");
eq(find("bump (#12) and more"), null, "꼬리가 아닌 (#N)은 무시");
eq(find("Merge pull request #61 from a/b", "", `${GH}/`)?.url, `${GH}/pull/61`, "remote 끝 슬래시 제거");
eq(
  find("Merge pull request #7 from a/fix-(#3)")?.number,
  7,
  "머지 커밋 관례가 squash 꼬리보다 우선",
);

// ── Bitbucket ──────────────────────────────────────────
eq(
  find("Merged in feature/x (pull request #7)", "", "https://bitbucket.org/team/app"),
  { number: 7, token: { text: "#7", start: 34 }, url: "https://bitbucket.org/team/app/pull-requests/7" },
  "Bitbucket 머지 커밋",
);

// ── GitLab ─────────────────────────────────────────────
eq(
  find("Merge branch 'feat' into 'main'", "Add thing\n\nSee merge request team/app!12\n", "https://gitlab.com/team/app"),
  { number: 12, token: null, url: "https://gitlab.com/team/app/-/merge_requests/12" },
  "GitLab 머지 커밋 본문",
);

// ── 해당 없음 ──────────────────────────────────────────
eq(find("chore: 0.20.1"), null, "일반 커밋");
eq(find("Merge branch 'main' into feat"), null, "로컬 머지");

// ── splitSubject ───────────────────────────────────────
{
  const subject = "Fix #12 regression (#34)";
  const pr = find(subject);
  eq(
    pr === null || pr.token === null ? null : splitSubject({ subject, token: pr.token }),
    ["Fix #12 regression (", "#34", ")"],
    "splitSubject: 패턴이 잡은 토큰만 자른다",
  );
}

// ── 결과 ───────────────────────────────────────────────
for (const f of failures) console.log(`FAIL ${f}`);
console.log(`${assertions - failures.length}/${assertions} assertions passed`);
if (failures.length > 0) process.exitCode = 1;
