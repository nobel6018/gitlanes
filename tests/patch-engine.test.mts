// GitLanes 패치 엔진(src/shell/hunks.ts) 실검증 테스트.
//
// 실제 git으로 임시 레포를 만들고, Rust get_wip_file_diff와 같은 인자로 diff를 뽑고,
// 엔진으로 부분 패치를 만들어, Rust git_apply_patch와 같은 인자(stdin)로 적용한 뒤
// 결과 내용을 독립 오라클과 바이트 단위로 비교한다. 적용 성공 여부만 보지 않는다.
// 반대쪽 영역(인덱스 또는 워킹트리)이 그대로인지도 단언한다.
//
// 실행: npm run test:patch                 (Node 24+, 또는 22.18+. TS 직접 실행)
//       FUZZ=2000 SEED=999 npm run test:patch  (무작위 케이스 수와 seed 조정. 기본 FUZZ=200, SEED=12345)
// 종료 코드: 실패가 하나라도 있으면 1. 알려진 미해결 항목(KNOWN)은 실패로 세지 않는다.
// 출처: 2026-10 감사 하네스(~/leedo/gitlanes-audit-2026-10/audit-patch.md)를 레포로 옮긴 것.

import { Buffer } from "node:buffer";
import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync, chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { performance } from "node:perf_hooks";
import process, { type ProcessEnv } from "node:process";
import { parseUnifiedDiff, buildPatch, buildLinePatch, hasLossyDecoding } from "../src/shell/hunks.ts";

const startedAt = performance.now();

// ── 알려진 미해결 항목 ─────────────────────────────────────
// 시나리오를 실행은 하되 실패를 세지 않는다. 고쳐져서 통과하면 표시를 지우라고 알린다.

const KNOWN = {
  M3: "skipped (audit-patch M3: stale diff is a state-refresh issue, guarded by WipInfo.contentToken in the UI)",
  H4: "skipped (audit-patch H4: lossy UTF-8 decode, blocked in DiffPanel via hasLossyDecoding, not in the engine)",
} as const;

// ── 결과 집계 ──────────────────────────────────────────────

let assertions = 0;
const failures: { name: string; detail: string }[] = [];
const skipped: { name: string; reason: string; hidden: number }[] = [];
const knownNowPassing: { name: string; reason: string }[] = [];
let currentCase = "";

function check(cond: boolean, what: string, detail = ""): boolean {
  assertions += 1;
  if (!cond) {
    failures.push({ name: currentCase, detail: `${what}${detail ? `\n${detail}` : ""}` });
  }
  return cond;
}

/** 바이트 비교. 실패 시 기대/실제를 JSON 문자열(latin1)과 hex로 보여준다 */
function eqBuf(actual: Buffer | null, expected: Buffer | null, what: string): boolean {
  const same =
    actual !== null && expected !== null ? actual.equals(expected) : actual === expected;
  const show = (b: Buffer | null) =>
    b === null ? "null" : `${JSON.stringify(b.toString("latin1"))}${b.length <= 64 ? `  [${b.toString("hex")}]` : ""}`;
  return check(same, what, same ? "" : `  expected: ${show(expected)}\n  actual:   ${show(actual)}`);
}

// ── git 실행 (Rust와 같은 인자) ────────────────────────────

const CFG_DIR = mkdtempSync(join(tmpdir(), "gl-cfg-"));
const GLOBAL_CFG = join(CFG_DIR, "gitconfig");
// 개발자 ~/.gitconfig가 결과를 흔들지 않게 전역 설정을 테스트 것으로 바꾼다. 사용자 설정 적대 시나리오는
// 레포 로컬 config로 따로 건다. 레포마다 git config를 부르지 않으려고 공통값은 여기 둔다
writeFileSync(GLOBAL_CFG, "[user]\n\tname = t\n\temail = t@t\n[core]\n\tautocrlf = false\n[init]\n\tdefaultBranch = main\n");
const BASE_ENV: ProcessEnv = {
  ...process.env,
  GIT_CONFIG_GLOBAL: GLOBAL_CFG,
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_TERMINAL_PROMPT: "0",
  // src-tauri/src/git.rs가 모든 git 실행에 붙인다 (경로 인자를 glob이 아니라 리터럴로)
  GIT_LITERAL_PATHSPECS: "1",
  GIT_DIR: undefined,
  GIT_WORK_TREE: undefined,
  GIT_INDEX_FILE: undefined,
};

function git(repo: string, args: string[], input?: Buffer | string): Buffer {
  pristineDiffs.delete(repo);
  return execFileSync("git", ["-C", repo, ...args], { env: BASE_ENV, input, stdio: ["pipe", "pipe", "pipe"] });
}


/**
 * diff 모드.
 * - "rust": 앱이 실제로 쓰는 인자. 기본
 * - "u0": 엔진 헤더 계산을 context 0 입력으로 직접 검증하는 방어 테스트용(audit-patch H1).
 *   앱은 이 모양을 만들지 않지만, 엔진이 count 0 범위를 정확히 다루는지 본다
 */
type DiffMode = "rust" | "u0";

/**
 * repoFor가 처음 상태로 되돌린 뒤 아직 아무것도 바꾸지 않은 레포의 diff 캐시.
 * 같은 상태면 diff도 같으므로 다시 실행하지 않는다. applyPatch와 git()이 캐시를 무효로 만든다
 */
const pristineDiffs = new Map<string, Map<string, string>>();

/** src-tauri/src/commands.rs get_wip_file_diff. String::from_utf8_lossy와 같은 lossy 디코딩 */
function wipDiff(repo: string, file: string, area: "staged" | "unstaged", mode: DiffMode = "rust"): string {
  const cache = pristineDiffs.get(repo);
  const cacheKey = `${file}\0${area}\0${mode}`;
  const hit = cache?.get(cacheKey);
  if (hit !== undefined) return hit;
  // src-tauri/src/commands.rs의 get_wip_file_diff, ops/stage.rs의 git_apply_patch와 같아야 한다.
  // (PATCH_SOURCE_CONFIG_ARGS, PATCH_SOURCE_DIFF_ARGS) 사용자 설정(diff.context, diff.noprefix,
  // diff.suppressBlankEmpty, textconv, diff.external, color)이 패치 원료에 새지 않게 고정한다
  const args = ["-c", "core.quotepath=false", "--no-optional-locks", "-c", "diff.suppressBlankEmpty=false", "diff"];
  if (area === "staged") args.push("--cached");
  args.push("--no-color", "--no-ext-diff", "-M", "--src-prefix=a/", "--dst-prefix=b/", "--no-textconv");
  args.push(mode === "u0" ? "-U0" : "-U3");
  args.push("--");
  // commands.rs get_wip_file_diff: staged 갈래는 file이 rename의 새 경로면 원 경로를 앞에 함께 넣는다
  const source = area === "staged" ? stagedRenames(repo).find(([, to]) => to === file)?.[0] : undefined;
  if (source !== undefined) args.push(source);
  args.push(file);
  // Buffer.toString("utf8")은 잘못된 바이트를 U+FFFD로 바꾼다. from_utf8_lossy와 같다
  const diff = execFileSync("git", ["-C", repo, ...args], { env: BASE_ENV, stdio: ["pipe", "pipe", "pipe"] }).toString("utf8");
  cache?.set(cacheKey, diff);
  return diff;
}

/** src-tauri/src/ops/stage.rs staged_renames. 스테이지된 R 쌍 (원 경로, 새 경로). C는 원 경로가 살아 있어 뺀다 */
function stagedRenames(repo: string): [string, string][] {
  const out = execFileSync("git", ["-C", repo, "diff", "--cached", "-M", "--name-status", "--no-ext-diff", "-z"], {
    env: BASE_ENV,
    stdio: ["pipe", "pipe", "pipe"],
  }).toString("utf8");
  const fields = out.split("\0");
  const pairs: [string, string][] = [];
  for (let i = 0; i < fields.length; i++) {
    const status = fields[i];
    if (status === "") continue;
    if (status.startsWith("R") || status.startsWith("C")) {
      const from = fields[i + 1];
      const to = fields[i + 2];
      i += 2;
      if (from === undefined || to === undefined) break;
      if (status.startsWith("R")) pairs.push([from, to]);
    } else {
      i += 1;
    }
  }
  return pairs;
}

/** src-tauri/src/ops/stage.rs git_apply_patch */
function applyPatch(
  repo: string,
  patch: string,
  cached: boolean,
  reverse: boolean,
  mode: DiffMode = "rust",
): { ok: boolean; stderr: string } {
  // src-tauri/src/commands.rs의 get_wip_file_diff, ops/stage.rs의 git_apply_patch와 같아야 한다.
  // --unidiff-zero는 앱에서 빠졌다. "u0" 방어 테스트만 context 0 패치를 받기 위해 켠다
  const args = ["-c", "core.quotepath=false", "--no-optional-locks", "-C", repo, "apply"];
  if (mode === "u0") args.push("--unidiff-zero");
  args.push("--whitespace=nowarn");
  if (cached) args.push("--cached");
  if (reverse) args.push("--reverse");
  args.push("-");
  pristineDiffs.delete(repo);
  const body = patch.endsWith("\n") ? patch : `${patch}\n`;
  const r = spawnSync("git", args, { env: { ...BASE_ENV, LANG: "C", LC_ALL: "C" }, input: Buffer.from(body, "utf8") });
  return { ok: r.status === 0, stderr: r.stderr.toString() };
}

// ── 레포 준비 ──────────────────────────────────────────────

type Content = string | Buffer;
const buf = (c: Content): Buffer => (typeof c === "string" ? Buffer.from(c, "utf8") : c);

interface RepoSpec {
  file?: string;
  head: Content | null; // null = HEAD에 없음
  index?: Content | null; // 생략 = head와 같음. null = 인덱스에 없음
  work?: Content | null; // 생략 = index와 같음. null = 워킹트리에서 삭제
  config?: Record<string, string>;
  /** base 커밋 뒤에 거는 설정 (예: CRLF로 커밋된 뒤에 core.autocrlf=true를 켠 레포) */
  lateConfig?: Record<string, string>;
  attributes?: string;
}

const tmpRoots: string[] = [CFG_DIR];

// git 실행 한 번이 10ms 안팎이라 레포 준비 비용이 실행 시간을 좌우한다.
// 빈 .git을 한 번 만들어 복사하고, 레포 로컬 설정은 git config 대신 파일에 직접 쓴다
const TEMPLATE_GIT = join(CFG_DIR, "template");
git(CFG_DIR, ["init", "-q", "--template=", "template"]);

/** "diff.mask.textconv" 같은 키를 [diff "mask"] textconv = ... 로 쓴다 */
function writeLocalConfig(repo: string, config: Record<string, string>) {
  let text = "";
  for (const [key, value] of Object.entries(config)) {
    const first = key.indexOf(".");
    const last = key.lastIndexOf(".");
    const sub = first === last ? "" : ` "${key.slice(first + 1, last)}"`;
    const quoted = value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    text += `[${key.slice(0, first)}${sub}]\n\t${key.slice(last + 1)} = "${quoted}"\n`;
  }
  appendFileSync(join(repo, ".git", "config"), text);
}

function makeRepo(spec: RepoSpec): { repo: string; file: string } {
  const repo = mkdtempSync(join(tmpdir(), "gl-patch-"));
  tmpRoots.push(repo);
  const file = spec.file ?? "f.txt";
  cpSync(join(TEMPLATE_GIT, ".git"), join(repo, ".git"), { recursive: true });
  writeLocalConfig(repo, spec.config ?? {});
  if (spec.attributes !== undefined) writeFileSync(join(repo, ".gitattributes"), spec.attributes);
  writeFileSync(join(repo, "seed"), "seed\n");
  const path = join(repo, file);
  mkdirSync(dirname(path), { recursive: true });
  if (spec.head !== null) writeFileSync(path, buf(spec.head));
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-q", "-m", "base"]);
  writeLocalConfig(repo, spec.lateConfig ?? {});
  const index = spec.index === undefined ? spec.head : spec.index;
  if (index !== spec.head) {
    if (index === null) git(repo, ["rm", "-q", "--cached", "--", file]);
    else {
      writeFileSync(path, buf(index));
      git(repo, ["add", "--", file]);
    }
  }
  const work = spec.work === undefined ? index : spec.work;
  if (work === null) rmSync(path, { force: true });
  else if (work !== undefined) writeFileSync(path, buf(work));
  return { repo, file };
}

/**
 * 같은 spec이면 레포를 다시 쓴다. 인덱스 파일과 대상 파일 바이트만 처음 상태로 되돌린다.
 * runOp 말고 레포를 바꾸는 시나리오(chmod, 추가 커밋, config 변경)는 makeRepo를 쓴다.
 * 되돌린 워킹트리 파일은 mtime이 새로 찍히므로 git은 인덱스 stat 캐시를 믿지 않고 내용을 다시 본다
 */
const repoCache = new Map<string, {
  repo: string;
  file: string;
  index: Buffer;
  indexBlob: Buffer | null;
  diffs: Map<string, string>;
  work: Buffer | null;
}>();
/** repoFor가 되돌린 직후의 인덱스 내용. 첫 runOp가 git show를 생략하려고 한 번 꺼내 쓴다 */
const restoredIndexBlob = new Map<string, Buffer | null>();
function repoFor(spec: RepoSpec): { repo: string; file: string } {
  const key = JSON.stringify(spec);
  const hit = repoCache.get(key);
  if (hit !== undefined) {
    writeFileSync(join(hit.repo, ".git", "index"), hit.index);
    const path = join(hit.repo, hit.file);
    if (hit.work === null) rmSync(path, { force: true });
    else writeFileSync(path, hit.work);
    restoredIndexBlob.set(hit.repo, hit.indexBlob);
    pristineDiffs.set(hit.repo, hit.diffs);
    return { repo: hit.repo, file: hit.file };
  }
  const ctx = makeRepo(spec);
  const indexBlob = readIndex(ctx.repo, ctx.file);
  const diffs = new Map<string, string>();
  repoCache.set(key, { ...ctx, index: readIndexFile(ctx.repo), indexBlob, diffs, work: readWork(ctx.repo, ctx.file) });
  restoredIndexBlob.set(ctx.repo, indexBlob);
  pristineDiffs.set(ctx.repo, diffs);
  return ctx;
}

/** 인덱스 항목의 모드("100644" 등). 인덱스에 없으면 null */
function indexMode(repo: string, file: string): string | null {
  const out = git(repo, ["ls-files", "-s", "--", file]).toString();
  return out === "" ? null : out.split(" ")[0];
}

function readIndex(repo: string, file: string): Buffer | null {
  const r = spawnSync("git", ["-C", repo, "show", `:${file}`], { env: BASE_ENV });
  return r.status === 0 ? r.stdout : null;
}
/** .git/index 파일 바이트. 워킹트리만 바꾸는 동작이 인덱스를 건드리지 않았는지 git 실행 없이 본다 */
function readIndexFile(repo: string): Buffer {
  return readFileSync(join(repo, ".git", "index"));
}
function readWork(repo: string, file: string): Buffer | null {
  const p = join(repo, file);
  return existsSync(p) ? readFileSync(p) : null;
}

// ── 독립 오라클 ────────────────────────────────────────────
// 엔진 파서를 쓰지 않고 git diff 원문과 대상 파일 내용만으로 기대 결과를 만든다.
// 줄은 (본문, 개행 유무)로 다룬다. "\n"으로만 나누므로 CRLF 파일의 "\r"은 본문에 남는다.

interface L { text: string; eol: boolean }
interface OHunk { oldStart: number; oldLines: number; newStart: number; newLines: number; lines: { sign: string; text: string; noEol: boolean }[] }

function splitLines(content: string): L[] {
  if (content === "") return [];
  const parts = content.split("\n");
  const out: L[] = parts.map((t) => ({ text: t, eol: true }));
  if (parts[parts.length - 1] === "") out.pop();
  else out[out.length - 1].eol = false;
  return out;
}
function joinLines(lines: L[]): string {
  return lines.map((l, i) => l.text + (i < lines.length - 1 || l.eol ? "\n" : "")).join("");
}

function oracleParse(diff: string): OHunk[] {
  const hunks: OHunk[] = [];
  let cur: OHunk | null = null;
  const raw = diff.endsWith("\n") ? diff.slice(0, -1) : diff;
  for (const line of raw.split("\n")) {
    const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (m) {
      cur = { oldStart: +m[1], oldLines: m[2] === undefined ? 1 : +m[2], newStart: +m[3], newLines: m[4] === undefined ? 1 : +m[4], lines: [] };
      hunks.push(cur);
      continue;
    }
    if (!cur) continue;
    if (line.startsWith("\\")) {
      cur.lines.push({ sign: "\\", text: line, noEol: false });
      for (let i = cur.lines.length - 2; i >= 0; i--) {
        if (cur.lines[i].sign !== "\\") { cur.lines[i].noEol = true; break; }
      }
      continue;
    }
    cur.lines.push({ sign: line[0] ?? " ", text: line.slice(1), noEol: false });
  }
  return hunks;
}

/**
 * forward: base = old쪽(스테이지 대상 인덱스). 고른 -를 지우고 고른 +를 넣는다.
 * reverse: base = new쪽(언스테이지 대상 인덱스, 버리기 대상 워킹트리). 고른 +를 지우고 고른 -를 되살린다.
 */
function oracle(diff: string, base: string, picked: ReadonlySet<string>, reverse: boolean): string {
  const hunks = oracleParse(diff);
  const src = splitLines(base);
  const out: L[] = [];
  let ptr = 0;
  hunks.forEach((h, hi) => {
    const start = reverse ? (h.newLines === 0 ? h.newStart : h.newStart - 1) : (h.oldLines === 0 ? h.oldStart : h.oldStart - 1);
    while (ptr < start) out.push(src[ptr++]);
    h.lines.forEach((ln, li) => {
      const isPicked = picked.has(`${hi}:${li}`);
      const keepSign = reverse ? "+" : "-"; // base에 실제로 있는 변경 줄
      const addSign = reverse ? "-" : "+"; // base에 없는 변경 줄
      if (ln.sign === " ") {
        const s = src[ptr++];
        if (s === undefined || s.text !== ln.text) throw new Error(`oracle context mismatch at ${hi}:${li}`);
        out.push(s);
      } else if (ln.sign === keepSign) {
        const s = src[ptr++];
        if (s === undefined || s.text !== ln.text) throw new Error(`oracle change mismatch at ${hi}:${li}`);
        if (!isPicked) out.push(s);
      } else if (ln.sign === addSign) {
        if (isPicked) out.push({ text: ln.text, eol: !ln.noEol });
      }
    });
  });
  while (ptr < src.length) out.push(src[ptr++]);
  return joinLines(out);
}

// ── 시나리오 실행기 ────────────────────────────────────────

type Op = "stage" | "unstage" | "discard";
const ALL_OPS: Op[] = ["stage", "unstage", "discard"];
const OPS: Record<Op, { area: "staged" | "unstaged"; cached: boolean; reverse: boolean }> = {
  stage: { area: "unstaged", cached: true, reverse: false },
  unstage: { area: "staged", cached: true, reverse: true },
  discard: { area: "unstaged", cached: false, reverse: true },
};

/** unstage는 인덱스에, 나머지는 워킹트리에 변경을 둔다 */
function specFor(op: Op, head: Content, work: Content, extra: Partial<RepoSpec> = {}): RepoSpec {
  return op === "unstage" ? { head, index: work, ...extra } : { head, work, ...extra };
}

/** 선택 지정: hunk 번호 목록, 또는 "+본문"/"-본문" 줄 지정(같은 본문이 여럿이면 "#n"으로 n번째) */
type Pick = { hunks: number[] } | { lines: string[] } | { keys: string[] };

function resolvePick(diff: string, pick: Pick): Set<string> {
  const hunks = oracleParse(diff);
  const set = new Set<string>();
  if ("keys" in pick) pick.keys.forEach((k) => set.add(k));
  else if ("hunks" in pick) {
    for (const hi of pick.hunks) hunks[hi]?.lines.forEach((l, li) => { if (l.sign === "+" || l.sign === "-") set.add(`${hi}:${li}`); });
  } else {
    for (const spec of pick.lines) {
      const [want, nth] = spec.includes("#") ? [spec.slice(0, spec.lastIndexOf("#")), +spec.slice(spec.lastIndexOf("#") + 1)] : [spec, 0];
      let seen = 0;
      let found = false;
      hunks.forEach((h, hi) => h.lines.forEach((l, li) => {
        if (!found && l.sign + l.text === want) {
          if (seen === nth) { set.add(`${hi}:${li}`); found = true; }
          seen += 1;
        }
      }));
      if (!found) throw new Error(`pick not found: ${JSON.stringify(spec)}`);
    }
  }
  return set;
}

function changeKeys(diff: string): string[] {
  const keys: string[] = [];
  oracleParse(diff).forEach((h, hi) => h.lines.forEach((l, li) => { if (l.sign === "+" || l.sign === "-") keys.push(`${hi}:${li}`); }));
  return keys;
}

interface RunResult { ok: boolean; stderr: string; patch: string; diff: string; picked: Set<string> }

interface RunOpts {
  expectOk?: boolean;
  /** 오라클 대신 쓸 기대 내용 */
  expected?: Content;
  /** 대상 내용 전처리/후처리 (autocrlf 워킹트리처럼 diff와 디스크 표현이 다를 때) */
  expectedFrom?: (diff: string, base: Buffer, picked: Set<string>) => Buffer;
  viaHunks?: boolean;
  mode?: DiffMode;
  /** 호출 측이 이미 읽은 diff (같은 상태에서 다시 읽지 않으려고) */
  diff?: string;
}

/** 엔진으로 패치를 만들어 적용하고 결과를 오라클과 비교한다. expectOk=false면 실패(무변경)를 기대 */
function runOp(ctx: { repo: string; file: string }, op: Op, pick: Pick, opts: RunOpts = {}): RunResult {
  const { repo, file } = ctx;
  const o = OPS[op];
  const mode = opts.mode ?? "rust";
  const diff = opts.diff ?? wipDiff(repo, file, o.area, mode);
  const parsed = parseUnifiedDiff(diff);
  const picked = resolvePick(diff, pick);
  const patch = "hunks" in pick && opts.viaHunks !== false
    ? buildPatch(parsed, pick.hunks, o.reverse)
    : buildLinePatch(parsed, picked, o.reverse);

  // 엔진이 만든 선택 키가 엔진 자신의 줄 번호와 같은 줄을 가리키는지 (UI 좌표 일치)
  for (const k of picked) {
    const [hi, li] = k.split(":").map(Number);
    const kind = parsed.hunks[hi]?.lines[li]?.kind;
    check(kind === "add" || kind === "del", `picked key ${k} maps to a change line in engine parse`);
  }

  // 인덱스 내용(git show)은 cached 동작에서만 읽는다. 워킹트리 동작은 .git/index 바이트가 그대로인지만 본다
  const cachedBlob = restoredIndexBlob.get(repo);
  restoredIndexBlob.delete(repo);
  const beforeIndexFile = readIndexFile(repo);
  const beforeIndex = o.cached ? (cachedBlob !== undefined ? cachedBlob : readIndex(repo, file)) : null;
  const beforeWork = readWork(repo, file);
  const r = applyPatch(repo, patch, o.cached, o.reverse, mode);
  const afterIndexFile = readIndexFile(repo);
  const afterWork = readWork(repo, file);

  const expectOk = opts.expectOk ?? true;
  const context = `  diff:\n${indent(diff)}\n  patch:\n${indent(patch)}`;
  check(r.ok === expectOk, `apply ${expectOk ? "succeeds" : "fails"} (${op})`, `  stderr: ${r.stderr.trim()}\n${context}`);

  const target = o.cached ? "index" : "work";
  if (!expectOk || !r.ok) {
    eqBuf(afterIndexFile, beforeIndexFile, "index untouched on failure");
    eqBuf(afterWork, beforeWork, "worktree untouched on failure");
    return { ok: r.ok, stderr: r.stderr, patch, diff, picked };
  }
  const base = (target === "index" ? beforeIndex : beforeWork) ?? Buffer.alloc(0);
  const expected = opts.expected !== undefined
    ? buf(opts.expected)
    : opts.expectedFrom !== undefined
      ? opts.expectedFrom(diff, base, picked)
      : Buffer.from(oracle(diff, base.toString("utf8"), picked, o.reverse), "utf8");
  const actual = target === "index" ? readIndex(repo, file) : afterWork;
  // 결과 파일이 완전히 비면 git은 인덱스 항목을 지울 수도 있다(삭제 패치). 내용 비교는 빈 버퍼로 맞춘다
  if (!eqBuf(actual ?? Buffer.alloc(0), expected, `${target} content after ${op} == oracle`)) {
    failures[failures.length - 1].detail += `\n${context}`;
  }
  if (target === "index") eqBuf(afterWork, beforeWork, "worktree untouched by cached op");
  else eqBuf(afterIndexFile, beforeIndexFile, "index untouched by worktree discard");
  return { ok: r.ok, stderr: r.stderr, patch, diff, picked };
}

function indent(text: string): string {
  return text.replace(/\n$/, "").split("\n").map((l) => `    | ${JSON.stringify(l).slice(1, -1)}`).join("\n");
}

/** known을 주면 실패해도 세지 않고 skipped로 돌린다 */
function scenario(name: string, fn: () => void, known?: string) {
  currentCase = name;
  const before = failures.length;
  try {
    fn();
  } catch (e) {
    check(false, "threw", String((e as Error).stack ?? e));
  }
  if (known === undefined) return;
  const hidden = failures.length - before;
  if (hidden > 0) {
    failures.splice(before);
    skipped.push({ name, reason: known, hidden });
  } else {
    knownNowPassing.push({ name, reason: known });
  }
}

const lines = (...xs: string[]) => xs.map((x) => `${x}\n`).join("");
const crlf = (...xs: string[]) => xs.map((x) => `${x}\r\n`).join("");
const range = (from: number, to: number, p = "l") => Array.from({ length: to - from + 1 }, (_, i) => `${p}${from + i}`);

// ── 고정 시나리오 ──────────────────────────────────────────

const BASE20 = lines(...range(1, 20));
// 3개 hunk: 2줄 바꿈, 5줄 뒤 3줄 삽입, 끝 부근 1줄 삭제
const MULTI = lines("l1", "L2", "l3", ...range(4, 9), "n1", "n2", "n3", ...range(10, 17), "l19", "l20");

for (const op of ALL_OPS) {
  for (const [label, hunks] of [["first", [0]], ["middle", [1]], ["last", [2]], ["first+last", [0, 2]], ["all", [0, 1, 2]]] as const) {
    scenario(`multi-hunk ${op} ${label}`, () => {
      const ctx = repoFor(specFor(op, BASE20, MULTI));
      const d = oracleParse(wipDiff(ctx.repo, ctx.file, OPS[op].area));
      check(d.length === 3, "fixture has 3 hunks", `got ${d.length}`);
      runOp(ctx, op, { hunks: [...hunks] });
    });
  }
}

// 줄 단위: add만, del만, 섞어서, 비연속, hunk 경계 줄
const LBASE = lines("a", "b", "c", "d", "e", "f", "g", "h");
const LNEW = lines("a", "B1", "B2", "c", "d", "X", "e", "f", "h");
const LPICKS: [string, string[]][] = [
  ["add only", ["+B2"]],
  ["del only", ["-b"]],
  ["del of g only", ["-g"]],
  ["mixed del+add", ["-b", "+B1"]],
  ["non-contiguous", ["+B1", "+X", "-g"]],
  ["second add of pair", ["+B2"]],
];
for (const op of ALL_OPS) {
  for (const [label, sel] of LPICKS) {
    scenario(`lines ${op} ${label}`, () => runOp(repoFor(specFor(op, LBASE, LNEW)), op, { lines: sel }));
  }
}

// 앞 hunk가 줄 수를 바꿔 oldStart != newStart인 상태에서 뒤 hunk만, 뒤 hunk의 일부 줄만
{
  const head = lines(...range(1, 30));
  const work = lines("l1", "i1", "i2", "i3", "i4", ...range(2, 19), "M20", "M20b", ...range(21, 30));
  for (const op of ALL_OPS) {
    scenario(`shifted later hunk ${op}`, () => runOp(repoFor(specFor(op, head, work)), op, { hunks: [1] }));
    scenario(`shifted later hunk ${op} partial line`, () => runOp(repoFor(specFor(op, head, work)), op, { lines: ["+M20b"] }));
    scenario(`shifted both hunks partial lines ${op}`, () => runOp(repoFor(specFor(op, head, work)), op, { lines: ["+i2", "+M20b", "-l20"] }));
  }
}

// \ No newline at end of file: old쪽, new쪽, 양쪽. 변경 줄의 모든 부분집합을 전수 검증
function exhaustive(label: string, head: Content, work: Content, extra: Partial<RepoSpec> = {}, opts: RunOpts = {}) {
  for (const op of ALL_OPS) {
    scenario(`${label} ${op} whole hunk`, () => runOp(repoFor(specFor(op, head, work, extra)), op, { hunks: [0] }, opts));
    const ctx0 = repoFor(specFor(op, head, work, extra));
    const keysAll = changeKeys(wipDiff(ctx0.repo, ctx0.file, OPS[op].area));
    const n = keysAll.length;
    for (let mask = 1; mask < 1 << n && n <= 6; mask++) {
      const keys = keysAll.filter((_, i) => mask & (1 << i));
      scenario(`${label} ${op} subset ${keys.join(",")}`, () => runOp(repoFor(specFor(op, head, work, extra)), op, { keys }, opts));
    }
  }
}

{
  const cases: [string, string, string][] = [
    ["old lacks EOL", "a\nb\nc", "a\nb\nc\nd\n"],
    ["new lacks EOL", "a\nb\nc\n", "a\nb\nC"],
    ["both lack EOL, last changed", "a\nb\nc", "a\nb\nC"],
    ["both lack EOL, change above", "a\nb\nc\nd\ne\nf\ng", "a\nB\nc\nd\ne\nf\ng"],
    ["both lack EOL, append", "a\nb", "a\nb\nc\nd"],
    ["only EOL added", "a\nb", "a\nb\n"],
    ["only EOL removed", "a\nb\n", "a\nb"],
    ["remove last lines, new lacks EOL", "a\nb\nc\nd\n", "a\nb"],
  ];
  for (const [label, head, work] of cases) exhaustive(`noeol ${label}`, head, work);
}

// 파일 맨 앞/맨 끝, 1줄 파일, 빈 파일이 되는 변경
{
  const cases: [string, string, string][] = [
    ["insert at top", lines("a", "b", "c", "d"), lines("NEW", "a", "b", "c", "d")],
    ["delete top", lines("a", "b", "c", "d"), lines("b", "c", "d")],
    ["append at end", lines("a", "b", "c", "d"), lines("a", "b", "c", "d", "NEW")],
    ["delete end", lines("a", "b", "c", "d"), lines("a", "b", "c")],
    ["one-line file change", lines("only"), lines("ONLY")],
    ["one-line file to empty", lines("only"), ""],
    ["file to empty", lines("a", "b", "c"), ""],
    ["empty to content", "", lines("a", "b")],
    ["one line noeol to empty", "x", ""],
  ];
  for (const [label, head, work] of cases) {
    for (const op of ALL_OPS) {
      scenario(`edge ${label} ${op} hunk`, () => runOp(repoFor(specFor(op, head, work)), op, { hunks: [0] }));
      scenario(`edge ${label} ${op} first change line`, () => {
        const ctx = repoFor(specFor(op, head, work));
        runOp(ctx, op, { keys: [changeKeys(wipDiff(ctx.repo, ctx.file, OPS[op].area))[0]] });
      });
      scenario(`edge ${label} ${op} last change line`, () => {
        const ctx = repoFor(specFor(op, head, work));
        const keys = changeKeys(wipDiff(ctx.repo, ctx.file, OPS[op].area));
        runOp(ctx, op, { keys: [keys[keys.length - 1]] });
      });
    }
  }
}

// count 0 범위의 start 계산 (audit-patch H1). 앱은 -U3을 고정해 이 모양을 덜 만들지만,
// 엔진 헤더 계산 자체를 context 0 입력으로 검증한다. 순수 삽입/삭제 hunk는 한쪽 count가 0이다
{
  const head = lines(...range(1, 12));
  const work = lines("l1", "X1", "X2", "l2", "l3", "l5", "Y", "l7", ...range(8, 11), "Z");
  for (const op of ALL_OPS) {
    const spec = () => specFor(op, head, work);
    const u0: RunOpts = { mode: "u0" };
    scenario(`-U0 engine header math ${op} every hunk one by one`, () => {
      const ctx = repoFor(spec());
      for (let guard = 0; guard < 10; guard++) {
        const n = oracleParse(wipDiff(ctx.repo, ctx.file, OPS[op].area, "u0")).length;
        if (n === 0) break;
        if (!runOp(ctx, op, { hunks: [n - 1] }, u0).ok) break;
      }
      const d = wipDiff(ctx.repo, ctx.file, OPS[op].area);
      check(d === "", `${op}: nothing left after processing every -U0 hunk`, d);
    });
    for (let h = 0; h < 4; h++) {
      scenario(`-U0 engine header math ${op} hunk ${h} alone`, () => runOp(repoFor(spec()), op, { hunks: [h] }, u0));
    }
    scenario(`-U0 engine header math ${op} later hunks only`, () => runOp(repoFor(spec()), op, { hunks: [2, 3] }, u0));
    scenario(`-U0 engine header math ${op} pure insert partial`, () => runOp(repoFor(spec()), op, { lines: ["+X2"] }, u0));
    scenario(`-U0 engine header math ${op} replace del only`, () => runOp(repoFor(spec()), op, { lines: ["-l6"] }, u0));
    scenario(`-U0 engine header math ${op} replace add only`, () => runOp(repoFor(spec()), op, { lines: ["+Y"] }, u0));
    scenario(`-U0 engine header math ${op} pure delete`, () => runOp(repoFor(spec()), op, { lines: ["-l4"] }, u0));
    scenario(`-U0 engine header math ${op} tail`, () => runOp(repoFor(spec()), op, { lines: ["+Z"] }, u0));
    scenario(`-U0 engine header math ${op} insert + delete across hunks`, () => runOp(repoFor(spec()), op, { lines: ["+X1", "-l4", "+Z"] }, u0));
  }
}

// 이미 staged 변경이 있는 파일에서 unstaged hunk를 stage / discard
{
  const head = lines(...range(1, 20));
  const index = lines("l1", "S", ...range(2, 20)); // staged: 위쪽 삽입
  const work = lines("l1", "S", ...range(2, 10), "W", ...range(11, 20), "W2"); // unstaged: 아래쪽 2곳
  scenario("stage on top of staged change", () => {
    const ctx = makeRepo({ head, index, work });
    for (let guard = 0; guard < 5 && wipDiff(ctx.repo, ctx.file, "unstaged") !== ""; guard++) {
      if (!runOp(ctx, "stage", { hunks: [0] }).ok) break;
    }
    check(wipDiff(ctx.repo, ctx.file, "unstaged") === "", "everything staged");
    eqBuf(readIndex(ctx.repo, ctx.file), Buffer.from(work), "index == worktree");
  });
  scenario("discard on top of staged change keeps staged", () => {
    const ctx = makeRepo({ head, index, work });
    runOp(ctx, "discard", { lines: ["+W"] });
    eqBuf(readIndex(ctx.repo, ctx.file), Buffer.from(index), "staged content intact");
  });
  scenario("unstage staged hunk while unstaged change sits nearby", () => {
    const work2 = lines("l1", "S", "T", ...range(2, 20));
    const ctx = makeRepo({ head, index, work: work2 });
    runOp(ctx, "unstage", { hunks: [0] });
    eqBuf(readWork(ctx.repo, ctx.file), Buffer.from(work2), "worktree intact");
  });
  scenario("staged and unstaged edit the same region", () => {
    const idx = lines("l1", "A", ...range(3, 20));
    const wk = lines("l1", "A", "B", ...range(3, 20));
    runOp(makeRepo({ head, index: idx, work: wk }), "stage", { hunks: [0] });
    runOp(makeRepo({ head, index: idx, work: wk }), "unstage", { lines: ["+A"] });
  });
}

// 특수 내용: 탭, 트레일링 공백, 긴 줄, 멀티바이트, "+++"/"---"/"@@"/"\" 로 시작하는 내용
{
  const long = "x".repeat(20000);
  const head = lines("a", "\tindented", "trail   ", "--- not header", "+++ not header", "@@ -1,2 +1,2 @@ fake", "\\ backslash", "한글", long, "z");
  const work = lines("a", "\tINDENTED\t", "trail ", "--- still not", "-- minus", "++ plus", "+++ added", "@@ -9 +9 @@ fake2", "\\ No newline at end of file", "한글 수정 😀", long + "y", "z");
  for (const op of ALL_OPS) {
    scenario(`special content ${op} whole`, () => runOp(repoFor(specFor(op, head, work)), op, { hunks: [0] }));
    const ctx0 = repoFor(specFor(op, head, work));
    const diff = wipDiff(ctx0.repo, ctx0.file, OPS[op].area);
    for (const key of changeKeys(diff)) {
      scenario(`special content ${op} single ${key}`, () => runOp(repoFor(specFor(op, head, work)), op, { keys: [key] }));
    }
    scenario(`special content ${op} every other line`, () => {
      const ctx = repoFor(specFor(op, head, work));
      const keys = changeKeys(wipDiff(ctx.repo, ctx.file, OPS[op].area)).filter((_, i) => i % 2 === 0);
      runOp(ctx, op, { keys });
    });
  }
}

// CRLF로 커밋된 파일 (core.autocrlf=false). "\r"은 줄 구분자가 아니라 줄 내용이다
{
  const head = crlf(...range(1, 20));
  const work = crlf("l1", "L2", "l3", ...range(4, 9), "n1", "n2", "n3", ...range(10, 17), "l19", "l20");
  for (const op of ALL_OPS) {
    for (const [label, hunks] of [["first", [0]], ["middle", [1]], ["last", [2]], ["all", [0, 1, 2]]] as const) {
      scenario(`crlf committed ${op} hunk ${label}`, () => runOp(repoFor(specFor(op, head, work)), op, { hunks: [...hunks] }));
    }
    scenario(`crlf committed ${op} lines`, () => runOp(repoFor(specFor(op, head, work)), op, { lines: ["+L2\r", "+n2\r", "-l18\r"] }));
  }
  exhaustive("crlf committed small", crlf("a", "b", "c", "d", "e", "f", "g", "h"), crlf("a", "B", "c", "d", "X", "e", "f", "h"));
  exhaustive("crlf committed, last line without EOL", "a\r\nb\r\nc", "a\r\nB\r\nc\r\nd");
  // 한 파일에 CRLF와 LF가 섞인 경우. 줄마다 끝이 그대로 보존돼야 한다
  exhaustive("mixed eol", "a\r\nb\nc\r\nd\ne\r\n", "a\r\nB\nc\r\nd\nX\r\ne\r\n");
  // 줄 끝 "\r"만 바뀐 변경 (LF -> CRLF). 같은 본문처럼 보이지만 다른 줄이다
  exhaustive("eol only changed lf to crlf", lines("a", "b", "c", "d"), "a\nb\r\nc\nd\r\n");
}

// core.autocrlf=true (Windows 기본). 인덱스는 LF, 워킹트리는 CRLF. diff에는 "\r"이 없다
{
  const toCrlf = (s: string) => s.replace(/\r?\n/g, "\r\n");
  const headLf = lines(...range(1, 20));
  const workLf = MULTI;
  const autocrlf = { config: { "core.autocrlf": "true" } };
  // 워킹트리 쪽 기대값: diff(LF)로 오라클을 돌리고 결과를 CRLF로 바꾼다 (git apply가 convert_to_working_tree를 거친다)
  const crlfWork: RunOpts = {
    expectedFrom: (diff, base, picked) =>
      Buffer.from(toCrlf(oracle(diff, base.toString("utf8").replace(/\r\n/g, "\n"), picked, true)), "utf8"),
  };
  for (const op of ALL_OPS) {
    const spec = (): RepoSpec => (op === "unstage"
      ? { head: headLf, index: workLf, work: toCrlf(workLf), ...autocrlf }
      : { head: headLf, work: toCrlf(workLf), ...autocrlf });
    const opts = op === "discard" ? crlfWork : {};
    for (const [label, hunks] of [["first", [0]], ["last", [2]], ["all", [0, 1, 2]]] as const) {
      scenario(`autocrlf=true ${op} hunk ${label}`, () => {
        const ctx = repoFor(spec());
        // 커밋 전에 HEAD를 LF로 넣었으니 워킹트리만 CRLF로 바꿔도 내용 변경이 없어야 한다
        const d = wipDiff(ctx.repo, ctx.file, OPS[op].area);
        check(!d.includes("\r"), "autocrlf diff has no CR", d);
        runOp(ctx, op, { hunks: [...hunks] }, opts);
        const work = readWork(ctx.repo, ctx.file);
        if (work !== null && op === "discard") {
          check(!/[^\r]\n/.test(work.toString("utf8")), "worktree stays CRLF after discard", JSON.stringify(work.toString()));
        }
      });
    }
    scenario(`autocrlf=true ${op} lines`, () => runOp(repoFor(spec()), op, { lines: ["+L2", "+n2", "-l18"] }, opts));
  }
}

// CRLF가 이미 커밋된 레포에 core.autocrlf=true를 켠 경우 (git은 이 파일을 변환하지 않는다)
{
  const head = crlf(...range(1, 12));
  const work = crlf("l1", "L2", ...range(3, 9), "N", ...range(10, 12));
  for (const op of ALL_OPS) {
    const spec = (): RepoSpec => ({ ...specFor(op, head, work), lateConfig: { "core.autocrlf": "true" } });
    scenario(`crlf committed + autocrlf=true ${op} hunk`, () => runOp(repoFor(spec()), op, { hunks: [0] }));
    scenario(`crlf committed + autocrlf=true ${op} one line`, () => runOp(repoFor(spec()), op, { lines: ["+N\r"] }));
  }
}

// 경로: 공백, 한글, 하위 디렉토리, glob 문자 (GIT_LITERAL_PATHSPECS)
for (const file of ["dir with space/my file.txt", "한글/파일.txt", "a/b/c.txt", "[ab].txt", "*.txt"]) {
  scenario(`path ${file} stage+discard`, () => {
    const ctx = makeRepo({ file, head: BASE20, work: MULTI });
    // glob으로 해석되면 함께 잡힐 이웃 파일. 변경을 둬서 diff에 섞이면 드러나게 한다
    for (const decoy of ["a.txt", "b.txt"]) writeFileSync(join(ctx.repo, decoy), "decoy\n");
    git(ctx.repo, ["add", "--", "a.txt", "b.txt"]);
    git(ctx.repo, ["commit", "-q", "-m", "decoys"]);
    for (const decoy of ["a.txt", "b.txt"]) writeFileSync(join(ctx.repo, decoy), "decoy changed\n");
    const d = wipDiff(ctx.repo, ctx.file, "unstaged");
    check((d.match(/^diff --git /gm) ?? []).length === 1, "diff covers exactly one file", d.split("\n").filter((l) => l.startsWith("diff --git")).join("\n"));
    runOp(ctx, "stage", { hunks: [1] });
    runOp(ctx, "discard", { lines: ["+L2"] });
  });
}

// 같은 패치를 두 번 적용(연속 클릭, 갱신 전의 낡은 diff로 다시 누름). 두 번째는 거절돼야 한다 (audit-patch H2)
{
  const cases: [string, string, string, Op, Pick][] = [
    ["middle insert", lines(...range(1, 10)), lines(...range(1, 5), "NEW", ...range(6, 10)), "stage", { hunks: [0] }],
    ["append at end", lines(...range(1, 10)), lines(...range(1, 10), "NEW"), "stage", { hunks: [0] }],
    ["insert at top", lines(...range(1, 10)), lines("NEW", ...range(1, 10)), "stage", { hunks: [0] }],
    ["append at end, discard", lines(...range(1, 10)), lines(...range(1, 10), "NEW"), "discard", { hunks: [0] }],
    ["delete at end, discard", lines(...range(1, 10)), lines(...range(1, 9)), "discard", { hunks: [0] }],
    ["delete at top, discard", lines(...range(1, 10)), lines(...range(2, 10)), "discard", { hunks: [0] }],
    ["repeated lines middle insert", lines("x", "x", "x", "x", "x", "x", "x", "x"), lines("x", "x", "x", "x", "NEW", "x", "x", "x", "x"), "stage", { hunks: [0] }],
  ];
  for (const [label, head, work, op, pick] of cases) {
    scenario(`double apply ${label} (${op})`, () => {
      const ctx = makeRepo({ head, work, config: { "diff.context": "0" } });
      const first = runOp(ctx, op, pick);
      const o = OPS[op];
      const snapIndex = readIndex(ctx.repo, ctx.file);
      const snapWork = readWork(ctx.repo, ctx.file);
      const second = applyPatch(ctx.repo, first.patch, o.cached, o.reverse);
      const nowIndex = readIndex(ctx.repo, ctx.file);
      const nowWork = readWork(ctx.repo, ctx.file);
      const same = (a: Buffer | null, b: Buffer | null) => (a === null || b === null ? a === b : a.equals(b));
      check(!second.ok && same(nowIndex, snapIndex) && same(nowWork, snapWork), "second identical apply is rejected and changes nothing",
        `  second ok=${second.ok}\n  index now: ${JSON.stringify(nowIndex?.toString())}\n  work now: ${JSON.stringify(nowWork?.toString())}`);
    });
  }
}

// 사용자 git 설정 적대 시나리오. 고정 인자(-U3, a/ b/ 접두, --no-textconv, --no-ext-diff, --no-color) 덕에
// 결과가 기본 설정과 같아야 한다. 이번 수정(v0.15.1)의 회귀 방지다
{
  const extDiff = (repo: string) => {
    const script = join(repo, ".git", "ext-diff.sh");
    writeFileSync(script, "#!/bin/sh\necho 'external diff garbage'\n");
    chmodSync(script, 0o755);
    return script;
  };
  const mask = { "diff.mask.textconv": "sed s/secret=.*/secret=***/" };
  for (const ctxLines of ["0", "1", "10"]) {
    for (const op of ALL_OPS) {
      const head = lines(...range(1, 12));
      const work = lines("l1", "X1", "X2", "l2", "l3", "l5", "Y", "l7", ...range(8, 11), "Z");
      const spec = () => specFor(op, head, work, { config: { "diff.context": ctxLines } });
      scenario(`config diff.context=${ctxLines} ${op} every hunk one by one`, () => {
        const ctx = repoFor(spec());
        for (let guard = 0; guard < 10; guard++) {
          const n = oracleParse(wipDiff(ctx.repo, ctx.file, OPS[op].area)).length;
          if (n === 0) break;
          if (!runOp(ctx, op, { hunks: [n - 1] }).ok) break;
        }
        const d = wipDiff(ctx.repo, ctx.file, OPS[op].area);
        check(d === "", `nothing left after processing every hunk`, d);
      });
      scenario(`config diff.context=${ctxLines} ${op} pure insert partial`, () => runOp(repoFor(spec()), op, { lines: ["+X2"] }));
      scenario(`config diff.context=${ctxLines} ${op} pure delete`, () => runOp(repoFor(spec()), op, { lines: ["-l4"] }));
      scenario(`config diff.context=${ctxLines} ${op} tail`, () => runOp(repoFor(spec()), op, { lines: ["+Z"] }));
    }
  }
  scenario("config diff.context=0: hunks still carry 3 context lines", () => {
    const ctx = makeRepo({ head: BASE20, work: MULTI, config: { "diff.context": "0" } });
    const h = oracleParse(wipDiff(ctx.repo, ctx.file, "unstaged"))[0];
    check(h.lines[0].sign === " ", "first hunk starts with context", JSON.stringify(h.lines.slice(0, 3)));
  });
  for (const op of ALL_OPS) {
    scenario(`config diff.noprefix=true ${op}`, () => {
      const ctx = repoFor(specFor(op, BASE20, MULTI, { file: "src/app.txt", config: { "diff.noprefix": "true" } }));
      runOp(ctx, op, { hunks: [0] });
    });
    scenario(`config diff.mnemonicPrefix=true ${op}`, () => {
      const ctx = repoFor(specFor(op, BASE20, MULTI, { config: { "diff.mnemonicPrefix": "true" } }));
      runOp(ctx, op, { hunks: [1] });
    });
    scenario(`config color.ui=always, color.diff=always ${op}`, () => {
      const ctx = repoFor(specFor(op, BASE20, MULTI, { config: { "color.ui": "always", "color.diff": "always" } }));
      runOp(ctx, op, { lines: ["+n2"] });
    });
    scenario(`config diff.external ${op}`, () => {
      const ctx = makeRepo(specFor(op, BASE20, MULTI));
      git(ctx.repo, ["config", "diff.external", extDiff(ctx.repo)]);
      check(!wipDiff(ctx.repo, ctx.file, OPS[op].area).includes("garbage"), "external diff is not used");
      runOp(ctx, op, { hunks: [2] });
    });
    scenario(`config diff.interHunkContext=20 merges hunks ${op}`, () => {
      const ctx = repoFor(specFor(op, BASE20, MULTI, { config: { "diff.interHunkContext": "20" } }));
      runOp(ctx, op, { lines: ["+L2", "-l18"] });
    });
    scenario(`config textconv filter ${op}`, () => {
      const ctx = repoFor(specFor(op, lines("a", "secret=1", "c", "d"), lines("a", "secret=1", "c", "secret=2", "d"), { config: mask, attributes: "*.txt diff=mask\n" }));
      check(!wipDiff(ctx.repo, ctx.file, OPS[op].area).includes("***"), "textconv output is not in the patch source");
      runOp(ctx, op, { hunks: [0] });
    });
  }
  scenario("config diff.noprefix=true with same-named file at shorter path", () => {
    // noprefix 출력을 -p1로 벗기면 "src/app.txt"가 "app.txt"가 된다. 그 파일이 루트에 있어도 건드리면 안 된다
    const ctx = makeRepo({ file: "src/app.txt", head: BASE20, work: MULTI, config: { "diff.noprefix": "true" } });
    writeFileSync(join(ctx.repo, "app.txt"), BASE20);
    git(ctx.repo, ["add", "app.txt"]);
    git(ctx.repo, ["commit", "-q", "-m", "decoy"]);
    runOp(ctx, "stage", { hunks: [0] });
    eqBuf(readIndex(ctx.repo, "app.txt"), Buffer.from(BASE20), "decoy root app.txt untouched in index");
  });
  for (const op of ALL_OPS) {
    scenario(`config diff.suppressBlankEmpty=true ${op}`, () => {
      const ctx = makeRepo(specFor(op, lines("a", "", "b", "", "c", "", "d"), lines("a", "", "B", "", "c", "", "d"), { config: { "diff.suppressBlankEmpty": "true" } }));
      const d = wipDiff(ctx.repo, ctx.file, OPS[op].area);
      check(d.split("\n").includes(" "), "blank context line keeps its space prefix", d);
      runOp(ctx, op, { lines: ["+B"] });
    });
  }
  scenario("config all hostile settings at once", () => {
    const config = { "diff.context": "0", "diff.noprefix": "true", "diff.mnemonicPrefix": "true", "color.ui": "always", "diff.interHunkContext": "5", ...mask };
    for (const op of ALL_OPS) {
      const ctx = makeRepo(specFor(op, lines("secret=0", ...range(1, 20)), lines("secret=0", ...MULTI.trimEnd().split("\n"), "secret=9"), { file: "src/app.txt", config, attributes: "*.txt diff=mask\n" }));
      git(ctx.repo, ["config", "diff.external", extDiff(ctx.repo)]);
      runOp(ctx, op, { lines: ["+L2", "+secret=9"] });
    }
  });
}

// rename, 모드 변경, 바이너리, 새 파일, 삭제된 파일, intent-to-add
scenario("binary file: engine yields no hunks", () => {
  const ctx = makeRepo({ file: "b.bin", head: Buffer.from([0, 1, 2, 3]), work: Buffer.from([0, 1, 9, 3, 4]) });
  const p = parseUnifiedDiff(wipDiff(ctx.repo, ctx.file, "unstaged"));
  check(p.hunks.length === 0, "no hunks for binary -> canPatch false");
  check(buildPatch(p, [0], false) === "", "buildPatch returns empty");
});
scenario("mode change only: no hunks", () => {
  const ctx = makeRepo({ head: BASE20 });
  chmodSync(join(ctx.repo, ctx.file), 0o755);
  const p = parseUnifiedDiff(wipDiff(ctx.repo, ctx.file, "unstaged"));
  check(p.hunks.length === 0, "no hunks for pure chmod");
});
// 부분 패치는 old mode/new mode를 싣지 않는다(audit-patch L1). 모드는 파일 단위 stage에서만 바뀐다
scenario("mode change + content: staging one hunk keeps the index mode", () => {
  const ctx = makeRepo({ head: BASE20, work: MULTI });
  chmodSync(join(ctx.repo, ctx.file), 0o755);
  runOp(ctx, "stage", { hunks: [0] });
  check(indexMode(ctx.repo, ctx.file) === "100644", "hunk stage does not silently stage the mode change", `  index mode now ${indexMode(ctx.repo, ctx.file)}`);
});
scenario("mode change + content: staging every line still keeps the index mode", () => {
  const ctx = makeRepo({ head: BASE20, work: MULTI });
  chmodSync(join(ctx.repo, ctx.file), 0o755);
  const diff = wipDiff(ctx.repo, ctx.file, "unstaged");
  check(diff.includes("new mode 100755"), "diff carries the mode change", diff.split("\n").slice(0, 4).join("\n"));
  runOp(ctx, "stage", { keys: changeKeys(diff) }, { diff });
  check(indexMode(ctx.repo, ctx.file) === "100644", "line stage of all changes leaves chmod for the file-level stage", `  index mode now ${indexMode(ctx.repo, ctx.file)}`);
});
scenario("mode change + content: unstaging one hunk keeps the staged mode", () => {
  const ctx = makeRepo({ head: BASE20, work: MULTI });
  chmodSync(join(ctx.repo, ctx.file), 0o755);
  git(ctx.repo, ["add", "--", ctx.file]);
  runOp(ctx, "unstage", { hunks: [0] });
  check(indexMode(ctx.repo, ctx.file) === "100755", "hunk unstage does not revert the staged chmod", `  index mode now ${indexMode(ctx.repo, ctx.file)}`);
});
scenario("mode change + content: discarding one hunk keeps the worktree mode", () => {
  const ctx = makeRepo({ head: BASE20, work: MULTI });
  chmodSync(join(ctx.repo, ctx.file), 0o755);
  runOp(ctx, "discard", { hunks: [1] });
  const exec = (statSync(join(ctx.repo, ctx.file)).mode & 0o111) !== 0;
  check(exec, "hunk discard does not drop the executable bit from the worktree file");
});
// staged rename은 원 경로를 함께 넣어 rename diff로 나온다(audit-patch M2, commands.rs). 부분 역방향 패치가
// rename 헤더를 그대로 실으면 고른 줄과 함께 rename까지 풀린다. 엔진이 새 경로끼리의 수정 패치로 바꾼다
/** old.txt(BASE20)를 to로 옮기고 MULTI로 고쳐 함께 stage한 레포. 인덱스 바이트를 돌려줘 되돌릴 수 있게 한다 */
function stagedRenameRepo(to: string): { repo: string; file: string; index: Buffer } {
  const ctx = makeRepo({ head: BASE20, file: "old.txt" });
  mkdirSync(dirname(join(ctx.repo, to)), { recursive: true });
  git(ctx.repo, ["mv", "old.txt", to]);
  writeFileSync(join(ctx.repo, to), MULTI);
  git(ctx.repo, ["add", "--", to]);
  return { repo: ctx.repo, file: to, index: readIndexFile(ctx.repo) };
}
/** 인덱스의 rename 상태. "R old.txt -> new.txt" 같은 꼴 */
function stagedStatus(repo: string): string {
  const out = git(repo, ["diff", "--cached", "-M", "--name-status", "-z"]).toString("utf8").split("\0").filter((f) => f !== "");
  const rows: string[] = [];
  for (let i = 0; i < out.length; i++) {
    const status = out[i];
    rows.push(status.startsWith("R") ? `R ${out[++i]} -> ${out[++i]}` : `${status} ${out[++i]}`);
  }
  return rows.join(", ");
}
scenario("staged rename + edit: the WIP diff is a rename", () => {
  const ctx = stagedRenameRepo("new.txt");
  const diff = wipDiff(ctx.repo, ctx.file, "staged");
  check(diff.includes("rename from old.txt") && !diff.includes("new file mode"), "staged WIP diff of a renamed file shows the rename", diff.split("\n").slice(0, 6).join("\n"));
});
for (const to of ["new.txt", "a b.txt", 'dir/q"x y.txt']) {
  scenario(`staged rename + edit: unstage one line keeps the rename (${to})`, () => {
    const ctx = stagedRenameRepo(to);
    const r = runOp(ctx, "unstage", { lines: ["+L2"] });
    check(!r.patch.includes("rename from"), "partial reverse patch drops the rename header", r.patch.split("\n").slice(0, 4).join("\n"));
    check(stagedStatus(ctx.repo) === `R old.txt -> ${to}`, "rename stays staged", `  status: ${stagedStatus(ctx.repo)}`);
  });
}
scenario("staged rename + edit: unstage every proper subset of lines", () => {
  const ctx = stagedRenameRepo("new.txt");
  const keys = changeKeys(wipDiff(ctx.repo, ctx.file, "staged"));
  for (let mask = 1; mask < (1 << keys.length) - 1; mask++) {
    writeFileSync(join(ctx.repo, ".git", "index"), ctx.index);
    pristineDiffs.delete(ctx.repo);
    const pick = keys.filter((_, i) => mask & (1 << i));
    runOp(ctx, "unstage", { keys: pick });
    check(stagedStatus(ctx.repo) === "R old.txt -> new.txt", `rename stays staged after unstaging ${pick.join(",")}`, `  status: ${stagedStatus(ctx.repo)}`);
  }
});
scenario("staged rename + edit: unstaging every line also unstages the rename", () => {
  // 파일 단위 unstage(ops/stage.rs with_rename_sources)와 같은 결과: 원 경로가 HEAD 내용으로 인덱스에 돌아온다
  const ctx = stagedRenameRepo("new.txt");
  const diff = wipDiff(ctx.repo, ctx.file, "staged");
  const patch = buildLinePatch(parseUnifiedDiff(diff), new Set(changeKeys(diff)), true);
  check(patch.includes("rename from old.txt"), "whole-file reverse patch keeps the rename header");
  const work = readWork(ctx.repo, ctx.file);
  const r = applyPatch(ctx.repo, patch, true, true);
  check(r.ok, "apply succeeds (unstage all)", r.stderr.trim());
  eqBuf(readIndex(ctx.repo, "old.txt"), buf(BASE20), "old path is back in the index with HEAD content");
  check(readIndex(ctx.repo, ctx.file) === null, "new path leaves the index");
  eqBuf(readWork(ctx.repo, ctx.file), work, "worktree untouched by cached op");
});
scenario("staged rename + further worktree edit: stage one line keeps the rename", () => {
  const ctx = stagedRenameRepo("new.txt");
  writeFileSync(join(ctx.repo, ctx.file), MULTI.replace("l5\n", "L5\n").replace("l15\n", "L15\n"));
  const r = runOp(ctx, "stage", { lines: ["+L5"] });
  check(!r.diff.includes("rename from"), "unstaged diff of a renamed file is a plain edit");
  check(stagedStatus(ctx.repo) === "R old.txt -> new.txt", "rename stays staged", `  status: ${stagedStatus(ctx.repo)}`);
});
scenario("rename header in the forward direction: partial stage carries the rename", () => {
  // 앱의 unstaged diff에는 rename이 나오지 않는다. 엔진이 정방향 rename 헤더를 그대로 두는지만 본다.
  // 새 경로가 아직 인덱스에 없으므로 새 경로끼리로 바꾸면 거절된다
  const ctx = stagedRenameRepo("new.txt");
  const diff = wipDiff(ctx.repo, ctx.file, "staged");
  git(ctx.repo, ["reset", "-q"]);
  const picked = resolvePick(diff, { lines: ["+L2"] });
  const patch = buildLinePatch(parseUnifiedDiff(diff), picked, false);
  const r = applyPatch(ctx.repo, patch, true, false);
  check(r.ok, "apply succeeds (forward partial rename)", r.stderr.trim());
  eqBuf(readIndex(ctx.repo, "new.txt"), Buffer.from(oracle(diff, BASE20, picked, false), "utf8"), "new path gets HEAD content plus the picked line");
  check(readIndex(ctx.repo, "old.txt") === null, "old path leaves the index");
});
// 부분 선택이 new/deleted 헤더를 그대로 실으면 거절된다(audit-patch M1). 엔진이 일반 수정 패치로 바꾼다.
// 고른 줄이 파일 전체가 아니면 결과 쪽 파일이 남아야 하고, 전체면 파일 단위 동작과 같아야 한다
const NEW4 = lines("a", "b", "c", "d");
scenario("staged new file: unstage some lines", () => {
  const ctx = makeRepo({ head: null, index: NEW4, work: NEW4 });
  runOp(ctx, "unstage", { lines: ["+b"] });
  check(indexMode(ctx.repo, ctx.file) === "100644", "partially unstaged new file stays in the index");
});
scenario("staged new file: unstage every proper subset of lines", () => {
  const spec: RepoSpec = { head: null, index: NEW4, work: NEW4 };
  const keys = changeKeys(wipDiff(repoFor(spec).repo, "f.txt", "staged"));
  for (let mask = 1; mask < (1 << keys.length) - 1; mask++) {
    const ctx = repoFor(spec);
    const pick = keys.filter((_, i) => mask & (1 << i));
    const r = runOp(ctx, "unstage", { keys: pick });
    if (r.ok) check(indexMode(ctx.repo, ctx.file) !== null, `new file stays in the index after unstaging ${pick.length}/${keys.length} lines`);
  }
});
scenario("staged new file: unstage all lines one by one removes nothing early", () => {
  const ctx = makeRepo({ head: null, index: NEW4, work: NEW4 });
  for (const text of ["+a", "+b", "+c"]) {
    runOp(ctx, "unstage", { lines: [text] });
    check(indexMode(ctx.repo, ctx.file) !== null, `new file still in the index after unstaging ${text}`);
  }
});
scenario("staged new executable file with a quoted path: unstage some lines keeps mode", () => {
  const file = 'dir/q"x.sh';
  const ctx = makeRepo({ file, head: null, index: null, work: NEW4 });
  chmodSync(join(ctx.repo, file), 0o755);
  git(ctx.repo, ["add", "--", file]);
  const diff = wipDiff(ctx.repo, file, "staged");
  check(diff.includes('+++ "b/dir/q\\"x.sh"'), "diff quotes the path", diff.split("\n").slice(0, 5).join("\n"));
  runOp(ctx, "unstage", { lines: ["+c"] }, { diff });
  check(indexMode(ctx.repo, file) === "100755", "partial unstage keeps the new file mode", `  index mode now ${indexMode(ctx.repo, file)}`);
});
scenario("intent-to-add file: discard some lines", () => {
  const ctx = makeRepo({ head: null, index: null, work: NEW4 });
  git(ctx.repo, ["add", "-N", "--", ctx.file]);
  runOp(ctx, "discard", { lines: ["+b", "+d"] });
});
scenario("staged new file: unstage whole hunk removes from index", () => {
  runOp(makeRepo({ head: null, index: lines("a", "b", "c"), work: lines("a", "b", "c") }), "unstage", { hunks: [0] });
});
scenario("deleted in worktree: stage some deletions", () => {
  const ctx = makeRepo({ head: lines("a", "b", "c"), work: null });
  runOp(ctx, "stage", { lines: ["-b"] });
  check(indexMode(ctx.repo, ctx.file) === "100644", "partially staged deletion keeps the file in the index");
});
scenario("deleted in worktree: stage every proper subset of deletions", () => {
  const spec: RepoSpec = { head: NEW4, work: null };
  const keys = changeKeys(wipDiff(repoFor(spec).repo, "f.txt", "unstaged"));
  for (let mask = 1; mask < (1 << keys.length) - 1; mask++) {
    const ctx = repoFor(spec);
    const pick = keys.filter((_, i) => mask & (1 << i));
    const r = runOp(ctx, "stage", { keys: pick });
    if (r.ok) check(indexMode(ctx.repo, ctx.file) !== null, `file stays in the index after staging ${pick.length}/${keys.length} deletions`);
  }
});
scenario("deleted in worktree: staging all deletion lines stages the deletion", () => {
  const ctx = makeRepo({ head: NEW4, work: null });
  const diff = wipDiff(ctx.repo, ctx.file, "unstaged");
  runOp(ctx, "stage", { keys: changeKeys(diff) }, { diff });
  check(indexMode(ctx.repo, ctx.file) === null, "selecting every line keeps the deleted file header (file leaves the index)");
});
scenario("deleted executable in worktree: stage some deletions keeps mode", () => {
  const ctx = makeRepo({ head: NEW4 });
  chmodSync(join(ctx.repo, ctx.file), 0o755);
  git(ctx.repo, ["add", "--", ctx.file]);
  git(ctx.repo, ["commit", "-q", "-m", "exec"]);
  rmSync(join(ctx.repo, ctx.file));
  runOp(ctx, "stage", { lines: ["-a", "-c"] });
  check(indexMode(ctx.repo, ctx.file) === "100755", "partial deletion stage keeps the mode", `  index mode now ${indexMode(ctx.repo, ctx.file)}`);
});
scenario("deleted in worktree: discard some deletions (restore lines)", () => {
  runOp(makeRepo({ head: lines("a", "b", "c"), work: null }), "discard", { lines: ["-b"] });
});
scenario("staged deletion: unstage some lines", () => {
  runOp(makeRepo({ head: lines("a", "b", "c"), index: null, work: null }), "unstage", { lines: ["-b"] });
});
scenario("intent-to-add file: stage some lines", () => {
  const ctx = makeRepo({ head: null, index: null, work: lines("a", "b", "c") });
  git(ctx.repo, ["add", "-N", "--", ctx.file]);
  runOp(ctx, "stage", { lines: ["+a"] });
});

// UTF-8이 아닌 파일 (audit-patch H4). 엔진은 바이트를 모른다. DiffPanel이 hasLossyDecoding으로 버튼을 숨긴다
scenario("non-UTF-8 (Latin-1) bytes in context: refused, nothing changes", () => {
  const head = Buffer.from("caf\xe9 one\nline2\nline3\nline4\n", "latin1");
  const work = Buffer.from("caf\xe9 one\nline2\nline3\nna\xefve add\nline4\n", "latin1");
  const ctx = makeRepo({ head, work });
  const diff = wipDiff(ctx.repo, ctx.file, "unstaged");
  const r = applyPatch(ctx.repo, buildPatch(parseUnifiedDiff(diff), [0], false), true, false);
  const idx = readIndex(ctx.repo, ctx.file);
  check(!r.ok || (idx !== null && idx.equals(work)), "Latin-1 bytes either staged verbatim or refused (never U+FFFD)",
    `  apply ok=${r.ok}\n  index bytes: ${idx?.toString("hex")}\n  work bytes:  ${work.toString("hex")}`);
});
scenario("non-UTF-8 (Latin-1) bytes only in the added line", () => {
  const head = Buffer.from("a\nb\nc\nd\ne\nf\n", "latin1");
  const work = Buffer.from("a\nb\nc\nna\xefve\nd\ne\nf\n", "latin1");
  const ctx = makeRepo({ head, work });
  const diff = wipDiff(ctx.repo, ctx.file, "unstaged");
  const r = applyPatch(ctx.repo, buildPatch(parseUnifiedDiff(diff), [0], false), true, false);
  const idx = readIndex(ctx.repo, ctx.file);
  check(!r.ok || (idx !== null && idx.equals(work)), "Latin-1 added line staged verbatim or refused (never U+FFFD)",
    `  apply ok=${r.ok}\n  index bytes: ${idx?.toString("hex")}\n  work bytes:  ${work.toString("hex")}`);
}, KNOWN.H4);
scenario("non-UTF-8 guard: hasLossyDecoding flags lossy diffs and only those", () => {
  const cases: [string, Buffer, Buffer, boolean][] = [
    ["Latin-1 added line", Buffer.from("a\nb\n", "latin1"), Buffer.from("a\nna\xefve\nb\n", "latin1"), true],
    ["EUC-KR added line", Buffer.from("a\nb\n"), Buffer.concat([Buffer.from("a\n"), Buffer.from([0xc7, 0xd1, 0xb1, 0xdb, 0x0a]), Buffer.from("b\n")]), true],
    ["UTF-8 Korean and emoji", Buffer.from("a\nb\n"), Buffer.from("a\n한글 😀\nb\n"), false],
    ["ASCII", Buffer.from("a\nb\n"), Buffer.from("a\nc\nb\n"), false],
  ];
  for (const [label, head, work, lossy] of cases) {
    const ctx = makeRepo({ head, work });
    const diff = wipDiff(ctx.repo, ctx.file, "unstaged");
    check(hasLossyDecoding(diff) === lossy, `${label}: hasLossyDecoding === ${lossy}`, diff);
  }
});
scenario("non-UTF-8 file, change far from non-ASCII line", () => {
  const head = Buffer.from("a\nb\nc\nd\ne\nf\ng\nh\ncaf\xe9\n", "latin1");
  const work = Buffer.from("A\nb\nc\nd\ne\nf\ng\nh\ncaf\xe9\n", "latin1");
  runOp(makeRepo({ head, work }), "stage", { hunks: [0] }, { expected: work });
});
scenario("stale diff: worktree edited after diff was read, then Stage hunk", () => {
  const ctx = makeRepo({ head: lines(...range(1, 10)), work: lines(...range(1, 5), "v1", ...range(6, 10)) });
  const diff = wipDiff(ctx.repo, ctx.file, "unstaged");
  writeFileSync(join(ctx.repo, ctx.file), lines(...range(1, 5), "v2", ...range(6, 10)));
  const r = applyPatch(ctx.repo, buildPatch(parseUnifiedDiff(diff), [0], false), true, false);
  const idx = readIndex(ctx.repo, ctx.file)?.toString() ?? "";
  check(!(r.ok && idx.includes("v1")), "stale view cannot stage a line that no longer exists in the worktree",
    `  apply ok=${r.ok}\n  index: ${JSON.stringify(idx)}`);
}, KNOWN.M3);

// 왕복: stage 후 같은 줄 unstage하면 인덱스가 HEAD로 돌아온다
scenario("roundtrip stage lines then unstage same lines", () => {
  const ctx = repoFor({ head: LBASE, work: LNEW });
  runOp(ctx, "stage", { lines: ["-b", "+B2", "+X"] });
  runOp(ctx, "unstage", { lines: ["-b", "+B2", "+X"] });
  eqBuf(readIndex(ctx.repo, ctx.file), Buffer.from(LBASE), "index back to HEAD");
});
scenario("roundtrip on crlf committed file", () => {
  const head = crlf("a", "b", "c", "d", "e", "f", "g", "h");
  const ctx = makeRepo({ head, work: crlf("a", "B1", "B2", "c", "d", "X", "e", "f", "h") });
  runOp(ctx, "stage", { lines: ["-b\r", "+B2\r", "+X\r"] });
  runOp(ctx, "unstage", { lines: ["-b\r", "+B2\r", "+X\r"] });
  eqBuf(readIndex(ctx.repo, ctx.file), Buffer.from(head), "index back to HEAD");
});

// ── 무작위 퍼즈 ────────────────────────────────────────────
// 반복이 많은 짧은 알파벳으로 위치 탐색이 헷갈리기 쉬운 상황을 일부러 만든다.
// "\r"이 붙은 줄을 섞어 CRLF와 LF가 섞인 파일도 만든다. 일부는 -U0 입력으로 헤더 계산을 본다.
// seed가 고정이라 같은 FUZZ/SEED면 항상 같은 케이스가 나온다.

const FUZZ = Number(process.env.FUZZ ?? 200);
const SEED = Number(process.env.SEED ?? 12345);
let seed = SEED;
const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
const ri = (n: number) => Math.floor(rnd() * n);
const ALPHA = ["a", "b", "c", "x", "", "  y", "}", "a\r", "\r"];

function randFile(): string {
  const n = ri(12);
  const ls = Array.from({ length: n }, () => ALPHA[ri(ALPHA.length)]);
  const s = ls.map((l) => l + "\n").join("");
  return n > 0 && rnd() < 0.25 ? s.slice(0, -1) : s;
}
function mutate(s: string): string {
  const ls = splitLines(s);
  const out: L[] = [];
  for (const l of ls) {
    const r = rnd();
    if (r < 0.15) continue;
    if (r < 0.3) out.push({ text: ALPHA[ri(ALPHA.length)] + "m", eol: true });
    else out.push({ ...l, eol: true });
    if (rnd() < 0.15) out.push({ text: ALPHA[ri(ALPHA.length)] + "n", eol: true });
  }
  if (rnd() < 0.2) out.unshift({ text: "top", eol: true });
  if (rnd() < 0.2) out.push({ text: "tail", eol: true });
  if (out.length > 0 && rnd() < 0.3) out[out.length - 1].eol = false;
  return joinLines(out);
}

// 퍼즈는 케이스마다 레포를 만들지 않고 (op, config)별 레포 하나에 내용만 바꿔 쓴다.
// stage/discard는 인덱스와 워킹트리만, unstage는 HEAD와 인덱스만 맞추면 된다
const fuzzPool = new Map<string, { repo: string; file: string }>();
function fuzzRepo(op: Op, head: string, work: string, config: Record<string, string>): { repo: string; file: string } {
  const key = `${op}${JSON.stringify(config)}`;
  const ctx = fuzzPool.get(key) ?? makeRepo({ head: "", config });
  fuzzPool.set(key, ctx);
  const path = join(ctx.repo, ctx.file);
  writeFileSync(path, head);
  git(ctx.repo, ["add", "--", ctx.file]);
  if (op === "unstage") {
    git(ctx.repo, ["commit", "-q", "--allow-empty", "-m", "fuzz"]);
    writeFileSync(path, work);
    git(ctx.repo, ["add", "--", ctx.file]);
    restoredIndexBlob.set(ctx.repo, Buffer.from(work));
  } else {
    writeFileSync(path, work);
    restoredIndexBlob.set(ctx.repo, Buffer.from(head));
  }
  return ctx;
}

const fuzzFailures: string[] = [];
let fuzzRun = 0;
for (let i = 0; i < FUZZ; i++) {
  const head = randFile();
  const work = mutate(head);
  const op = ALL_OPS[ri(3)];
  const config: Record<string, string> = rnd() < 0.4 ? { "diff.context": String(ri(4)) } : {};
  const mode: DiffMode = rnd() < 0.15 ? "u0" : "rust";
  if (head === work) continue;
  const ctx = fuzzRepo(op, head, work, config);
  const diff = wipDiff(ctx.repo, ctx.file, OPS[op].area, mode);
  const keys = changeKeys(diff).filter(() => rnd() < 0.5);
  if (keys.length === 0) continue;
  fuzzRun += 1;
  const before = failures.length;
  scenario(`fuzz#${i} ${op} mode=${mode} cfg=${JSON.stringify(config)}`, () => runOp(ctx, op, { keys }, { mode, diff }));
  if (failures.length > before) {
    fuzzFailures.push(JSON.stringify({ i, op, mode, config, head, work, keys }));
  }
}

// ── 보고 ───────────────────────────────────────────────────

for (const r of tmpRoots) rmSync(r, { recursive: true, force: true });

const byCase = new Map<string, string[]>();
for (const f of failures) byCase.set(f.name, [...(byCase.get(f.name) ?? []), f.detail]);
for (const [name, details] of byCase) {
  console.log(`\nFAIL ${name}`);
  for (const d of details) console.log(`  - ${d.split("\n").join("\n    ")}`);
}
if (fuzzFailures.length > 0) {
  console.log(`\nfuzz repro inputs (${fuzzFailures.length}, SEED=${SEED} FUZZ=${FUZZ}):`);
  fuzzFailures.slice(0, 10).forEach((f) => console.log(`  ${f}`));
}
for (const s of skipped) console.log(`SKIP ${s.name}: ${s.reason} (${s.hidden} failing assertions hidden)`);
for (const k of knownNowPassing) console.log(`NOTE ${k.name} now passes. Remove its KNOWN marker: ${k.reason}`);

const seconds = ((performance.now() - startedAt) / 1000).toFixed(1);
console.log(
  `\n${assertions} assertions, ${failures.length} failed in ${byCase.size} scenarios, ` +
    `${skipped.length} skipped, fuzz ${fuzzRun} cases (SEED=${SEED}), ${seconds}s`,
);
process.exitCode = failures.length > 0 ? 1 : 0;
