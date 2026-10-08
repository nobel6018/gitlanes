// 서브모듈 추가 대화상자의 순수 함수(src/shell/submoduleAdd.ts) 단위 테스트.
//
// 실행: node tests/submodule-add.test.mts   (Node 24+, 또는 22.18+. TS 직접 실행)
// 종료 코드: 실패가 하나라도 있으면 1.

import process from "node:process";
import {
  pathAfterUrlChange,
  submoduleAddProblem,
  submodulePathFromUrl,
} from "../src/shell/submoduleAdd.ts";

let assertions = 0;
const failures: string[] = [];

function eq(actual: unknown, expected: unknown, what: string): void {
  assertions += 1;
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) failures.push(`${what}\n    expected ${e}\n    actual   ${a}`);
}

// ── submodulePathFromUrl ───────────────────────────────
const cases: Array<[string, string]> = [
  ["https://github.com/a/b.git", "b"],
  ["https://github.com/a/b", "b"],
  ["https://github.com/a/b.git/", "b"],
  ["https://github.com/a/b///", "b"],
  ["git@host:a/b.git", "b"],
  ["git@host:b.git", "b"],
  ["ssh://git@host:2222/a/b.git", "b"],
  ["../lib", "lib"],
  ["../lib/", "lib"],
  ["./vendor/proto.git", "proto"],
  ["/srv/git/proto.GIT", "proto"],
  ["C:\\repos\\proto\\", "proto"],
  ["file:///tmp/repo.git", "repo"],
  ["  https://github.com/a/b.git  ", "b"],
  ["b.git", "b"],
  ["my.lib.git", "my.lib"],
  ["", ""],
  ["   ", ""],
  ["..", ""],
  ["../", ""],
  [".", ""],
  [".git", ""],
  ["git@host:", ""],
  ["https://", ""],
];
for (const [url, expected] of cases) {
  eq(submodulePathFromUrl(url), expected, `submodulePathFromUrl(${JSON.stringify(url)})`);
}

// ── pathAfterUrlChange ─────────────────────────────────
eq(pathAfterUrlChange("", "https://github.com/a/b.git", ""), "b", "빈 Path는 URL을 따라 채운다");
eq(
  pathAfterUrlChange("https://github.com/a/b.git", "https://github.com/a/c.git", "b"),
  "c",
  "자동으로 채운 값이면 URL을 따라 바뀐다",
);
eq(
  pathAfterUrlChange("https://github.com/a/b.git", "https://github.com/a/c.git", "vendor/b"),
  "vendor/b",
  "사용자가 고친 Path는 URL이 바뀌어도 덮지 않는다",
);
eq(
  pathAfterUrlChange("https://github.com/a/b.git", "", "vendor/b"),
  "vendor/b",
  "URL을 지워도 고친 Path는 남는다",
);
eq(pathAfterUrlChange("https://github.com/a/b.git", "", "b"), "", "URL을 지우면 자동 값도 비운다");
eq(pathAfterUrlChange("x/b.git", "x/c.git", ""), "c", "사용자가 Path를 지우면 다시 따라간다");

// 한 글자씩 타이핑: 매 단계 자동 값을 따라간다
{
  const typed = "../lib";
  let prev = "";
  let path = "";
  for (let i = 1; i <= typed.length; i += 1) {
    const next = typed.slice(0, i);
    path = pathAfterUrlChange(prev, next, path);
    prev = next;
  }
  eq(path, "lib", "한 글자씩 타이핑해도 마지막 조각을 따라간다");
}

// Path를 먼저 고친 뒤 URL을 타이핑: 끝까지 그대로
{
  const typed = "git@host:a/proto.git";
  let prev = "";
  let path = "third_party/proto";
  for (let i = 1; i <= typed.length; i += 1) {
    const next = typed.slice(0, i);
    path = pathAfterUrlChange(prev, next, path);
    prev = next;
  }
  eq(path, "third_party/proto", "먼저 고친 Path는 URL 타이핑 중에도 유지된다");
}

// ── submoduleAddProblem ────────────────────────────────
eq(submoduleAddProblem("", ""), "URL is required.", "URL이 비면 막는다");
eq(submoduleAddProblem("  ", "lib"), "URL is required.", "공백뿐인 URL도 빈 값");
eq(submoduleAddProblem("https://x/a.git", ""), "Path is required.", "Path가 비면 막는다");
eq(submoduleAddProblem("https://x/a.git", "   "), "Path is required.", "공백뿐인 Path도 빈 값");
eq(submoduleAddProblem("--upload-pack=x", "lib"), "URL cannot start with -", "- 로 시작하는 URL은 막는다");
eq(submoduleAddProblem("https://x/a.git", "a"), null, "URL과 Path가 있으면 통과");
eq(
  submoduleAddProblem("https://x/a.git", "vendor/a/", ["vendor/a"]),
  "vendor/a is already a submodule.",
  "이미 있는 서브모듈 경로(끝 슬래시 무시)",
);
eq(submoduleAddProblem("https://x/a.git", "vendor/b", ["vendor/a"]), null, "다른 경로는 통과");

// ── 결과 ───────────────────────────────────────────────
for (const f of failures) console.log(`FAIL ${f}`);
console.log(`${assertions - failures.length}/${assertions} assertions passed`);
if (failures.length > 0) process.exitCode = 1;
