// 검증용 하네스 엔트리 — Tauri 런타임 없이 App 전체를 mock IPC 위에서 렌더링한다.
// 앱 코드는 건드리지 않고 IPC 경계만 가로챈다. 배포 번들과 무관(dev-app.html 전용).
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { mockIPC } from "@tauri-apps/api/mocks";
import App from "../App";
import { makeMockGraph } from "../graph";
import type {
  AddSubmoduleOptions,
  BlameHunk,
  BlameResult,
  CommitDetails,
  CommitRow,
  CommitSummary,
  CommitTemplate,
  CompareResult,
  ConflictFile,
  FileChange,
  FileHistoryEntry,
  GraphData,
  OpResult,
  PendingOp,
  RebaseStep,
  RefEntry,
  RefSnapshot,
  RemoteInfo,
  RepoInfo,
  RepoState,
  SearchMatch,
  StashInfo,
  SubmoduleChange,
  SubmoduleChangeSource,
  SubmoduleInfo,
  SyncState,
  UndoEntry,
  WipDetails,
  WipInfo,
  WorktreeInfo,
} from "../types";
import "../theme.css";

const MOCK_PATH = "/mock/awesome-project";
/** 다이얼로그를 열 때마다 번갈아 나오는 두 번째/세 번째 mock 레포 (탭 독립성 확인용) */
const MOCK_PICK_PATHS = ["/mock/second-repo", "/mock/third-repo"];
let pickCursor = 0;
/** get_remote_url이 돌려줄 고정 GitHub URL */
const MOCK_REMOTE_URL = "https://github.com/gitlanes/awesome-project";
/** 전체 커밋 수. limit이 이 값보다 작으면 hasMore가 켜진다. */
const TOTAL_COMMITS = 12340;
/** 하네스 시작 후 이 시간이 지나면 토큰과 wip이 한 번 바뀐다 (자동 새로고침 검증용) */
const TOKEN_FLIP_MS = 30_000;
const STARTED_AT = Date.now();

function flipped(): boolean {
  return Date.now() - STARTED_AT >= TOKEN_FLIP_MS;
}

/**
 * 쓰기가 일어날 때마다 오르는 값. WIP 내용 지문(contentToken)에 섞는다.
 * graphToken에는 섞지 않는다. stage처럼 ref를 안 바꾸는 쓰기는 실제 git에서도 지문이 같다
 */
let writeSalt = 0;

/**
 * ref, HEAD, 체크아웃된 브랜치, 스태시 목록 중 하나라도 바꾸는 쓰기에서만 오른다.
 * CONTRACTS v0.15.2 3번의 graphToken과 같은 규칙이다 (refSaltAfter 참고)
 */
let refSalt = 0;

/** refs 지문. 30초 전후로 한 번, 그리고 ref를 바꾸는 쓰기마다 바뀐다 */
function currentToken(): string {
  return `mock-graph-token-v${flipped() ? 2 : 1}-${refSalt}`;
}

/**
 * 워킹 트리 상태. 쓰기 command가 실제로 이걸 고친다.
 * stage 하면 파일이 unstaged에서 staged로 옮겨 가고, commit 하면 staged가 비면서
 * 그래프에 행이 하나 생긴다. 그래야 UI 흐름을 눈으로 검증할 수 있다.
 */
const wipStore: WipDetails = {
  staged: [
    { path: "src/shell/api.ts", oldPath: null, status: "M", additions: 15, deletions: 0 },
    { path: "src/types.ts", oldPath: null, status: "M", additions: 9, deletions: 1 },
  ],
  unstaged: [
    { path: "src/shell/RepoWorkspace.tsx", oldPath: null, status: "M", additions: 42, deletions: 11 },
    { path: "src/shell/shell.css", oldPath: null, status: "M", additions: 18, deletions: 2 },
    { path: "src/graph/GraphView.tsx", oldPath: null, status: "M", additions: 7, deletions: 7 },
    // v0.19: 서브모듈 HEAD가 기록과 다르다(SUBMODULE_STORE의 third_party/proto, moved+dirty)
    { path: "third_party/proto", oldPath: null, status: "M", additions: 0, deletions: 0, submodule: true },
  ],
  untracked: [
    { path: "docs/wip-viewer.md", oldPath: null, status: "A", additions: 64, deletions: 0 },
  ],
};

/** 30초 플립으로 늘어나는 파일을 한 번만 밀어 넣는다 (자동 새로고침 검증용) */
let flipApplied = false;

function applyFlip(): void {
  if (flipApplied || !flipped()) {
    return;
  }
  flipApplied = true;
  wipStore.unstaged.push({
    path: "src/shell/WipDetailPanel.tsx",
    oldPath: null,
    status: "M",
    additions: 23,
    deletions: 4,
  });
}

/**
 * 워킹 트리 내용 편집 횟수. 파일 수는 그대로 두고 내용만 바꾼 상황(audit-state M1)을 흉내낸다.
 * 콘솔에서 `__mockEdit()`를 부르면 오른다. 그러면 contentToken과 unstaged diff가 같이 바뀐다
 */
let contentEdits = 0;

declare global {
  interface Window {
    /** 하네스 전용: 파일 수는 그대로 두고 워킹 트리 내용만 바꾼다 */
    __mockEdit?: () => number;
    /** 하네스 전용: command별 호출 횟수. 콘솔에서 `__mockCalls` 로 읽는다 */
    __mockCalls?: Record<string, number>;
    /** 하네스 전용: 쓰기 command가 진행 중일 때 시작된 읽기 command 횟수 */
    __mockCallsDuringWrite?: Record<string, number>;
    /** 하네스 전용: 두 카운터를 비운다 */
    __mockResetCalls?: () => void;
  }
}

const callCounts: Record<string, number> = {};
const callsDuringWrite: Record<string, number> = {};
/** 지금 진행 중인 쓰기 command 수 */
let writesInFlight = 0;

window.__mockCalls = callCounts;
window.__mockCallsDuringWrite = callsDuringWrite;
window.__mockResetCalls = () => {
  for (const key of Object.keys(callCounts)) {
    delete callCounts[key];
  }
  for (const key of Object.keys(callsDuringWrite)) {
    delete callsDuringWrite[key];
  }
};

/** 호출을 센다. 쓰기 진행 중에 시작된 읽기는 따로 센다 (폴링 가드 검증용) */
function countCall(cmd: string): void {
  callCounts[cmd] = (callCounts[cmd] ?? 0) + 1;
  if (writesInFlight > 0 && !cmd.startsWith("git_")) {
    callsDuringWrite[cmd] = (callsDuringWrite[cmd] ?? 0) + 1;
  }
}

window.__mockEdit = () => {
  contentEdits += 1;
  console.log("[mock] content edit", contentEdits);
  return contentEdits;
};

function currentWip(): WipInfo | null {
  applyFlip();
  const paths = new Set<string>();
  for (const area of [wipStore.staged, wipStore.unstaged, wipStore.untracked]) {
    for (const file of area) {
      paths.add(file.path);
    }
  }
  if (paths.size === 0) {
    return null;
  }
  // changedFiles가 총계고 staged/untracked는 그 부분집합이다.
  // unstaged = changedFiles - stagedFiles - untrackedFiles로 유도되므로
  // 이 관계가 깨지면 그래프 WIP 배지가 음수로 나온다
  return {
    changedFiles: paths.size,
    stagedFiles: wipStore.staged.length,
    untrackedFiles: wipStore.untracked.length,
    // 쓰기(writeSalt)와 내용 편집(contentEdits) 어느 쪽이든 바뀌면 달라진다
    contentToken: `mock-content-${writeSalt}-${contentEdits}-${flipped() ? 1 : 0}`,
  };
}

function mockWipDetails(): WipDetails {
  applyFlip();
  return {
    staged: [...wipStore.staged],
    unstaged: [...wipStore.unstaged],
    untracked: [...wipStore.untracked],
  };
}

/** area마다 다른 합성 diff. 헤더 배지와 내용이 짝이 맞는지 눈으로 확인할 수 있다 */
function mockWipDiff(file: string, area: string): string {
  if (area === "untracked") {
    const lines = [
      `diff --git a/dev/null b/${file}`,
      "new file mode 100644",
      "--- /dev/null",
      `+++ b/${file}`,
      "@@ -0,0 +1,6 @@",
      "+# WIP 뷰어",
      "+",
      "+워킹 트리에만 있는 새 파일이다.",
      "+아직 git이 추적하지 않는다.",
      "+",
      "+- staged / unstaged / untracked 세 영역",
    ];
    return lines.join("\n");
  }
  const marker = area === "staged" ? "인덱스에 올라간 변경" : "아직 스테이지하지 않은 변경";
  return [
    `diff --git a/${file} b/${file}`,
    "index 8ac31f2..b5d90e7 100644",
    `--- a/${file}`,
    `+++ b/${file}`,
    `@@ -18,7 +18,10 @@ // ${marker}`,
    " import { useCallback } from \"react\";",
    " ",
    "-const AREA = \"none\";",
    `+const AREA = \"${area}\";`,
    "+",
    "+/** 하네스 합성 diff */",
    // unstaged 쪽만 편집 횟수를 싣는다. __mockEdit() 뒤에 폴링이나 hunk 적용 직전 검사가
    // 이 줄의 차이를 잡아야 한다
    area === "unstaged" && contentEdits > 0
      ? `+export const WIP_MARKER = ${contentEdits};`
      : "+export const WIP_MARKER = true;",
    " ",
    " export function noop(): void {}",
  ].join("\n");
}

/** 이 파일을 열면 5,000줄짜리 diff가 와서 DiffView 가상 스크롤을 검증할 수 있다 */
const HUGE_DIFF_FILE = "src/generated/api-schema.ts";
/** get_file_content가 Err("binary")를 돌려주는 파일 (뷰어 오류 표시 검증용) */
const BINARY_FILE = "public/icon.png";

const REPO: RepoInfo = {
  path: MOCK_PATH,
  name: "awesome-project",
  headBranch: "main",
  headSha: "8f2c1a9d4e7b30c5a6f18d2e94b70cf3a15d6e82",
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

/** sha 문자열에서 결정적인 정수를 뽑는다 (합성 상세를 sha마다 다르게 만들기 위함) */
function hashOf(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

const graphCache = new Map<number, GraphData>();

function fakeSha(seed: string): string {
  let out = "";
  let h = hashOf(seed);
  while (out.length < 40) {
    h = (Math.imul(h, 0x01000193) ^ out.length) >>> 0;
    out += h.toString(16).padStart(8, "0");
  }
  return out.slice(0, 40);
}

function mockStashes(rows: GraphData["rows"]): StashInfo[] {
  const picks = [3, 12].filter((i) => i < rows.length);
  return picks.map((rowIndex, i) => {
    const sha = fakeSha(`stash-${i}`);
    return {
      sha,
      shortSha: sha.slice(0, 10),
      message: i === 0
        ? "WIP on main: 8f2c1a9 레인 색 재활용 실험"
        : "On feat/graph-canvas: 캔버스 DPR 스케일 임시 저장",
      baseSha: rows[rowIndex].sha,
      timestamp: rows[rowIndex].timestamp + 60,
    };
  });
}

/**
 * 하네스에서 만든 가짜 커밋. 최신순으로 base rows 앞에 붙는다.
 * Edge.childRow/parentRow는 전역 행 인덱스라 뒤쪽 행의 값을 전부 밀어줘야 한다.
 */
const extraRows: CommitRow[] = [];

function withExtras(rows: CommitRow[]): CommitRow[] {
  const shift = extraRows.length;
  if (shift === 0) {
    return rows;
  }
  const tail = rows.map((row, i) => ({
    ...row,
    // HEAD 표시와 브랜치 pill은 새로 만든 맨 위 커밋이 가져간다
    isHead: false,
    refs: i === 0 ? [] : row.refs,
    edges: row.edges.map((edge) => ({
      ...edge,
      childRow: edge.childRow + shift,
      parentRow: edge.parentRow < 0 ? -1 : edge.parentRow + shift,
    })),
  }));
  return [...extraRows, ...tail];
}

/** limit까지 레이아웃을 만들어 캐시하고, rows는 [skip, limit) 구간만 잘라 돌려준다 */
function mockGraph(limit: number, skip: number): GraphData {
  const count = Math.min(limit, TOTAL_COMMITS);
  let base = graphCache.get(count);
  if (base === undefined) {
    base = makeMockGraph(count);
    graphCache.set(count, base);
  }
  const rows = withExtras(base.rows);
  return {
    ...base,
    rows: rows.slice(Math.max(0, skip)),
    // totalLoaded/hasMore/laneCount/wip/graphToken/stashes는 전체 기준
    totalLoaded: rows.length,
    hasMore: count < TOTAL_COMMITS,
    // 워킹 디렉토리가 더러운 상태 — GraphView가 HEAD 위에 WIP 행을 그린다
    wip: currentWip(),
    graphToken: currentToken(),
    stashes: mockStashes(rows),
  };
}

/** 커밋 한 건을 그래프 맨 위에 만든다. 부모는 직전 맨 위 행 */
function pushCommit(message: string): void {
  // mockGraph가 이미 extraRows를 앞에 붙여 돌려준다
  const parent = mockGraph(1000, 0).rows[0];
  const sha = fakeSha(`commit-${extraRows.length}-${message}`);
  const subject = message.split("\n")[0] || "(no message)";
  extraRows.unshift({
    sha,
    shortSha: sha.slice(0, 10),
    subject,
    author: "Younghoon Lee",
    authorEmail: "younghoon.lee@example.com",
    timestamp: Math.floor(Date.now() / 1000),
    parents: [parent.sha],
    lane: parent.lane,
    color: parent.color,
    isHead: true,
    isMerge: false,
    refs: parent.refs.length > 0 ? parent.refs : [{ name: "main", kind: "localBranch", isHead: true }],
    // 이 행과 다음 행 사이를 잇는 수직 선분 하나
    edges: [
      { fromLane: parent.lane, toLane: parent.lane, color: parent.color, childRow: 0, parentRow: 1 },
    ],
  });
  writeSalt += 1;
}

/** 로컬 5 + origin 20 + 태그 5. makeMockGraph가 만든 refs를 먼저 흡수해 그래프 pill과 어긋나지 않게 한다. */
const LOCAL_NAMES = [
  "main",
  "feat/wip-sidebar-search",
  "feat/graph-canvas",
  "fix/lane-color-reuse",
  "chore/bump-tauri",
];

const REMOTE_NAMES = [
  "origin/main",
  "origin/develop",
  "origin/feat/wip-sidebar-search",
  "origin/feat/graph-canvas",
  "origin/feat/commit-details",
  "origin/feat/diff-viewer",
  "origin/feat/keyboard-nav",
  "origin/fix/lane-color-reuse",
  "origin/fix/scroll-jitter",
  "origin/fix/rename-diff",
  "origin/fix/toast-stacking",
  "origin/chore/bump-tauri",
  "origin/chore/ci-cache",
  "origin/chore/eslint",
  "origin/release/0.1",
  "origin/release/0.2",
  "origin/experiment/webgl-lanes",
  "origin/experiment/worker-layout",
  "origin/docs/contracts",
  "origin/revert/lane-pool",
];

const TAG_NAMES = ["v0.1.0", "v0.1.1", "v0.1.2", "v0.2.0-rc.1", "v0.2.0"];

let refsCache: RefEntry[] | null = null;

function mockRefs(): RefEntry[] {
  if (refsCache !== null) {
    return refsCache;
  }
  const rows = mockGraph(1000, 0).rows;
  const byName = new Map<string, RefEntry>();

  // 1) 그래프가 실제로 붙여둔 ref를 먼저 채운다
  for (const row of rows) {
    for (const ref of row.refs) {
      if (!byName.has(ref.name)) {
        byName.set(ref.name, {
          name: ref.name,
          kind: ref.kind,
          sha: row.sha,
          isHead: ref.isHead,
        });
      }
    }
  }

  // 2) 목표 개수까지 합성 ref로 채운다 (sha는 로드 범위 안의 행에서 고른다)
  const headSha = rows.find((row) => row.isHead)?.sha ?? rows[0].sha;
  let cursor = 0;
  const pickSha = (): string => {
    cursor += 1;
    return rows[(cursor * 37) % rows.length].sha;
  };
  const fill = (names: string[], kind: RefEntry["kind"], target: number) => {
    let have = [...byName.values()].filter((ref) => ref.kind === kind).length;
    for (const name of names) {
      if (have >= target) {
        break;
      }
      if (byName.has(name)) {
        continue;
      }
      byName.set(name, {
        name,
        kind,
        sha: name === "main" ? headSha : pickSha(),
        isHead: false,
      });
      have += 1;
    }
  };
  fill(LOCAL_NAMES, "localBranch", 5);
  fill(REMOTE_NAMES, "remoteBranch", 20);
  fill(TAG_NAMES, "tag", 5);

  const all = [...byName.values()];
  // HEAD 표시는 로컬 브랜치 하나에만
  if (!all.some((ref) => ref.kind === "localBranch" && ref.isHead)) {
    const main = all.find((ref) => ref.kind === "localBranch" && ref.name === "main");
    if (main !== undefined) {
      main.isHead = true;
      main.sha = headSha;
    }
  }

  refsCache = all;
  return all;
}

/** 전체 히스토리(12,340행) 대상 검색. 반환 index는 load_graph의 topo 인덱스와 같다 */
function mockSearch(query: string, limit: number): SearchMatch[] {
  const needle = query.trim().toLowerCase();
  if (needle === "") {
    return [];
  }
  // 화면이 이미 읽어 둔 가장 긴 그래프를 쓴다. 전체(1만여 행) 레이아웃을 새로 만들지 않는다
  const loaded = Math.max(0, ...graphCache.keys());
  const rows = mockGraph(loaded > 0 ? loaded : 500, 0).rows;
  const out: SearchMatch[] = [];
  for (let i = 0; i < rows.length && out.length < limit; i++) {
    const row = rows[i];
    if (
      row.subject.toLowerCase().includes(needle) ||
      row.author.toLowerCase().includes(needle) ||
      row.sha.toLowerCase().startsWith(needle)
    ) {
      out.push({ sha: row.sha, index: i });
    }
  }
  return out;
}

// ── v0.18 파일 히스토리, blame, 비교 ─────────────────────────
// 커밋은 전부 그래프의 실제 행에서 고른다. 화면에서 커밋을 누르면 그래프 점프까지 이어져야 해서다

/** 첫 페이지(COMMITS_PER_PAGE=5000) 밖 커밋. blame 점프가 search_commits 경로를 타는지 본다 */
const BEYOND_FIRST_PAGE = 5200;
const UNCOMMITTED_SHA = "0".repeat(40);
/** `?compareUnrelated=1`: 공통 조상이 없는 두 히스토리 비교 */
const COMPARE_UNRELATED =
  new URLSearchParams(window.location.search).get("compareUnrelated") === "1";
/**
 * `?compareLimit=<n>`: compare_refs의 limit을 n으로 줄인다. compareUnrelated(목록당 25~30개)와 같이 쓰면
 * 한쪽 목록만 잘리는 경우를 만들 수 있다 (목록별 "+more" 확인)
 */
const COMPARE_LIMIT_OVERRIDE = Number(
  new URLSearchParams(window.location.search).get("compareLimit") ?? "0",
);

function commitRows(): CommitRow[] {
  return mockGraph(1000, 0).rows.filter((row) => row.parents.length === 1);
}

function summaryOf(row: CommitRow): CommitSummary {
  return {
    sha: row.sha,
    shortSha: row.sha.slice(0, 7),
    subject: row.subject,
    author: row.author,
    timestamp: row.timestamp,
  };
}

/** "src/graph/lane-layout.ts" -> "src/graph/old-lane-layout.ts". rename 이전 경로를 흉내낸다 */
function renamedFrom(file: string): string {
  if (file === "src/graph/lane-layout.ts") {
    return "src/graph/layout.ts";
  }
  const cut = file.lastIndexOf("/");
  return `${file.slice(0, cut + 1)}old-${file.slice(cut + 1)}`;
}

/**
 * 14개 항목. 최신 5개는 지금 경로, 6번째에서 rename(R, oldPath 있음), 그 뒤는 옛 경로, 마지막은 추가(A).
 * rev가 있으면 그 커밋 위치부터 거슬러 올라간다
 */
function mockFileHistory(file: string, rev: string | null, limit: number): FileHistoryEntry[] {
  const rows = commitRows();
  const from = rev === null ? 0 : Math.max(0, rows.findIndex((row) => row.sha === rev));
  const oldPath = renamedFrom(file);
  const out: FileHistoryEntry[] = [];
  const step = 3 + (hashOf(file) % 5);
  for (let i = 0; i < 14 && out.length < limit; i++) {
    const row = rows[(from + i * step) % rows.length];
    const renamedHere = i === 5;
    const before = i > 5;
    out.push({
      ...summaryOf(row),
      authorEmail: row.authorEmail,
      path: before ? oldPath : file,
      oldPath: renamedHere ? oldPath : null,
      status: i === 13 ? "A" : renamedHere ? "R" : "M",
    });
  }
  return out;
}

/**
 * 구간 길이 1~12줄로 커밋을 번갈아 배치한다. 같은 커밋이 떨어진 두 구간에 다시 나오고,
 * 한 구간은 첫 페이지 밖 커밋이다. rev가 null(워킹트리)이면 두 구간이 커밋 안 된 줄이다
 */
function mockBlame(file: string, rev: string | null): BlameResult {
  if (file === BINARY_FILE) {
    throw "binary";
  }
  const lines = mockFileContent(file).split("\n");
  const rows = commitRows();
  const far = mockGraph(BEYOND_FIRST_PAGE + 200, 0).rows[BEYOND_FIRST_PAGE];
  const hunks: BlameHunk[] = [];
  let line = 1;
  let n = 0;
  const seed = hashOf(file);
  while (line <= lines.length) {
    const count = Math.min(1 + ((seed >>> (n % 24)) + n * 7) % 12, lines.length - line + 1);
    const uncommitted = rev === null && (n === 3 || n === 11);
    const row = n === 6 ? far : rows[((n % 9) * 11 + (seed % 17)) % rows.length];
    hunks.push(
      uncommitted
        ? {
            sha: UNCOMMITTED_SHA,
            shortSha: UNCOMMITTED_SHA.slice(0, 7),
            author: "Not Committed Yet",
            authorEmail: "not.committed.yet",
            timestamp: Math.floor(Date.now() / 1000),
            summary: "Uncommitted changes",
            startLine: line,
            lineCount: count,
            uncommitted: true,
          }
        : {
            sha: row.sha,
            shortSha: row.sha.slice(0, 7),
            author: row.author,
            authorEmail: row.authorEmail,
            timestamp: row.timestamp,
            summary: row.subject,
            startLine: line,
            lineCount: count,
            uncommitted: false,
          },
    );
    line += count;
    n += 1;
  }
  return { lines, hunks };
}

/** ref 이름이나 sha를 그래프 행 위치로 바꾼다. 모르는 이름은 이름에서 위치를 뽑는다 */
function compareAnchor(name: string): number {
  const rows = commitRows();
  const bySha = rows.findIndex((row) => row.sha === name);
  if (bySha >= 0) {
    return bySha;
  }
  const ref = mockRefs().find((entry) => entry.name === name);
  const byRef = ref === undefined ? -1 : rows.findIndex((row) => row.sha === ref.sha);
  return byRef >= 0 ? byRef : hashOf(name) % 200;
}

/**
 * 갈라진 두 브랜치. 각 쪽의 고유 커밋은 자기 위치부터 아래로 몇 개, 공통 조상은 둘보다 더 아래.
 * base와 head를 맞바꾸면 두 목록도 그대로 맞바뀐다(같은 쌍에서 결정적으로 만든다)
 */
function mockCompare(base: string, head: string, requested: number): CompareResult {
  const limit = COMPARE_LIMIT_OVERRIDE > 0 ? Math.min(requested, COMPARE_LIMIT_OVERRIDE) : requested;
  if (base === head) {
    return {
      base,
      head,
      mergeBase: null,
      onlyInHead: [],
      onlyInBase: [],
      onlyInHeadTruncated: false,
      onlyInBaseTruncated: false,
      files: [],
    };
  }
  const rows = commitRows();
  const side = (name: string, count: number): CommitSummary[] => {
    const at = compareAnchor(name);
    const out: CommitSummary[] = [];
    for (let i = 0; i < count; i++) {
      out.push(summaryOf(rows[(at + i * 2 + 1) % rows.length]));
    }
    return out;
  };
  // 개수는 이름에만 기댄다. 역할(base/head)에 기대면 맞바꿨을 때 목록 길이가 달라진다
  const count = (name: string) => (COMPARE_UNRELATED ? 25 : 1) + (hashOf(name) % 6);
  const headCount = count(head);
  const baseCount = count(base);
  const onlyInHead = side(head, headCount);
  const onlyInBase = side(base, baseCount);
  const lowest = Math.max(compareAnchor(base), compareAnchor(head));
  const files = COMPARE_UNRELATED
    ? mockFiles(hashOf(head)).map((file) => ({ ...file, status: "A" as const, oldPath: null, deletions: 0 }))
    : [
        ...mockFiles(hashOf([base, head].sort().join("\u0000"))).filter((_, i) => i !== 6),
        SUBMODULE_FILE,
      ];
  return {
    base,
    head,
    mergeBase: COMPARE_UNRELATED ? null : rows[(lowest + 30) % rows.length].sha,
    onlyInHead: onlyInHead.slice(0, limit),
    onlyInBase: onlyInBase.slice(0, limit),
    onlyInHeadTruncated: onlyInHead.length > limit,
    onlyInBaseTruncated: onlyInBase.length > limit,
    files,
  };
}

// ── v0.19 서브모듈 ──────────────────────────────────────────

/**
 * `?noSubmodules=1`: 서브모듈이 없는 레포. 저장소를 빈 채로 시작해 사이드바 구간이 빈 문구로 뜬다.
 * v0.20부터 git_submodule_add가 이 저장소에 넣으므로 추가한 서브모듈은 보인다
 */
const NO_SUBMODULES = new URLSearchParams(window.location.search).get("noSubmodules") === "1";

const SUB_PROTO_RECORDED = fakeSha("proto-recorded");
const SUB_PROTO_HEAD = fakeSha("proto-head");

/**
 * 서브모듈 셋: ok, moved+dirty, uninitialized. git_submodule_update가 실제로 고친다.
 * 서브모듈 경로를 탭으로 열면 그 레포(경로가 MOCK_PATH 아래)는 서브모듈이 없는 것으로 본다
 */
const submoduleStore: SubmoduleInfo[] = NO_SUBMODULES ? [] : [
  {
    name: "docs-theme",
    path: "docs/theme",
    url: "https://github.com/gitlanes/docs-theme.git",
    branch: null,
    recordedSha: fakeSha("theme-recorded"),
    headSha: null,
    state: "uninitialized",
    dirty: false,
  },
  {
    name: "proto",
    path: "third_party/proto",
    url: "git@github.com:gitlanes/proto.git",
    branch: "main",
    recordedSha: SUB_PROTO_RECORDED,
    headSha: SUB_PROTO_HEAD,
    state: "moved",
    dirty: true,
  },
  {
    name: "libgit-lite",
    path: "vendor/libgit-lite",
    url: "https://github.com/gitlanes/libgit-lite.git",
    branch: null,
    recordedSha: fakeSha("libgit-recorded"),
    headSha: fakeSha("libgit-recorded"),
    state: "ok",
    dirty: false,
  },
];

// 서브모듈이 없는 레포에는 unstaged gitlink도 없다
if (NO_SUBMODULES) {
  removeFiles(wipStore.unstaged, ["third_party/proto"]);
}

function mockSubmodules(path: string): SubmoduleInfo[] {
  if (path !== MOCK_PATH) {
    return [];
  }
  return submoduleStore.map((sub) => ({ ...sub }));
}

/** 서브모듈 저장소의 커밋 n개 (최신이 먼저) */
function subCommits(seed: string, count: number): CommitSummary[] {
  const now = Math.floor(Date.now() / 1000);
  const subjects = [
    "fix: 빈 메시지 필드 직렬화",
    "feat: stream 응답에 trailer 추가",
    "chore: buf lint 규칙 갱신",
    "refactor: 공용 타입을 common.proto로 분리",
    "docs: 필드 번호 예약 규칙",
  ];
  return Array.from({ length: count }, (_, i) => {
    const sha = fakeSha(`${seed}-${i}`);
    return {
      sha,
      shortSha: sha.slice(0, 7),
      subject: subjects[(hashOf(seed) + i) % subjects.length],
      author: i % 2 === 0 ? "Mina Park" : "Younghoon Lee",
      timestamp: now - (i + 1) * 5400 - (hashOf(seed) % 3600),
    };
  });
}

/**
 * get_submodule_change mock. unstaged는 기록 → 체크아웃 HEAD, 그 밖은 출처별로 합성한다.
 * uninitialized(docs/theme)는 서브모듈 저장소가 없어 available=false
 */
function mockSubmoduleChange(
  subPath: string,
  source: SubmoduleChangeSource,
  limit: number,
): SubmoduleChange {
  const sub = submoduleStore.find((entry) => entry.path === subPath);
  const unstaged = source.kind === "unstaged";
  const seed =
    source.kind === "commit"
      ? source.sha
      : source.kind === "compare"
        ? `${source.base}...${source.head}`
        : source.kind;
  const oldSha = unstaged ? (sub?.recordedSha ?? null) : fakeSha(`${subPath}-old-${seed}`);
  const newSha = unstaged ? (sub?.headSha ?? null) : fakeSha(`${subPath}-new-${seed}`);
  const available = sub !== undefined && sub.state !== "uninitialized" && oldSha !== null && newSha !== null;
  // 앞으로 6개, 되감기 2개. limit이 작으면 잘린다(truncated 확인)
  const ahead = available ? subCommits(`${subPath}-ahead-${seed}`, 6) : [];
  const behind = available ? subCommits(`${subPath}-behind-${seed}`, 2) : [];
  return {
    path: subPath,
    oldSha,
    newSha,
    dirty: unstaged && sub?.dirty === true,
    available,
    ahead: ahead.slice(0, limit),
    behind: behind.slice(0, limit),
    aheadTruncated: ahead.length > limit,
    behindTruncated: behind.length > limit,
  };
}

/** 커밋 하나(HEAD)와 비교 목록에 들어가는 gitlink 변경 */
const SUBMODULE_FILE: FileChange = {
  path: "third_party/proto",
  oldPath: null,
  status: "M",
  additions: 0,
  deletions: 0,
  submodule: true,
};

function mockFiles(seed: number): FileChange[] {
  return [
    { path: "src/shell/Toolbar.tsx", oldPath: null, status: "M", additions: 24 + (seed % 13), deletions: 6 },
    { path: "src/shell/CommitDetailPanel.tsx", oldPath: null, status: "M", additions: 118, deletions: 41 },
    { path: "src/shell/DiffView.tsx", oldPath: null, status: "A", additions: 63, deletions: 0 },
    { path: "src/graph/lane-layout.ts", oldPath: "src/graph/layout.ts", status: "R", additions: 9, deletions: 4 },
    { path: "src/legacy/OldGraph.tsx", oldPath: null, status: "D", additions: 0, deletions: 212 },
    { path: "docs/graph-rendering.md", oldPath: null, status: "A", additions: 47, deletions: 0 },
    { path: BINARY_FILE, oldPath: null, status: "M", additions: 0, deletions: 0 },
    // 가상 스크롤 검증용 대형 diff
    { path: HUGE_DIFF_FILE, oldPath: null, status: "M", additions: 2480, deletions: 2470 },
  ];
}

function mockDetails(sha: string): CommitDetails {
  const seed = hashOf(sha);
  const now = Math.floor(Date.now() / 1000) - (seed % 900000);
  return {
    sha,
    subject: "feat(graph): 레인 색 재활용과 통과선 계산을 분리",
    body:
      "레인이 종료될 때 색을 즉시 반납하지 않고 한 행 뒤에 반납하도록 바꿨다.\n" +
      "머지 직후 같은 색이 인접 레인에 다시 배정되면서 두 줄기가 한 줄기로\n" +
      "보이던 문제가 사라진다.\n" +
      "\n" +
      "- lane pool을 FIFO에서 LRU로 교체\n" +
      "- edges 계산을 layout.ts로 이동\n" +
      "- 5만 행 스크롤 프로파일: 58fps -> 60fps",
    author: {
      name: "Younghoon Lee",
      email: "younghoon.lee@example.com",
      timestamp: now,
    },
    committer: {
      name: "Younghoon Lee",
      email: "younghoon.lee@example.com",
      timestamp: now + 180,
    },
    parents: [
      "2b7d4e1c98a05f36e4d17b8c2a90f5e63d4817ba",
      "c41a90f27de6b3805c19a4f7e28d60b3947fa1cd",
    ],
    // v0.19: HEAD 커밋 하나만 서브모듈 포인터를 바꾼다
    files: sha === mockHeadSha() ? [...mockFiles(seed), SUBMODULE_FILE] : mockFiles(seed),
  };
}

/** 5,000줄짜리 합성 diff. 500줄마다 hunk 헤더가 들어간다 */
function hugeDiff(file: string): string {
  const out: string[] = [
    `diff --git a/${file} b/${file}`,
    "index 1c0ffee..0ddba11 100644",
    `--- a/${file}`,
    `+++ b/${file}`,
  ];
  for (let i = 0; i < 5000; i++) {
    if (i % 500 === 0) {
      const at = i + 12;
      out.push(`@@ -${at},500 +${at},500 @@ export interface ApiSchema {`);
      continue;
    }
    const kind = i % 7;
    if (kind === 1 || kind === 4) {
      out.push(`+  field${i}: string | null;`);
    } else if (kind === 2) {
      out.push(`-  field${i}: string;`);
    } else {
      out.push(`   readonly field${i}: number;`);
    }
  }
  return out.join("\n");
}

function mockDiff(file: string, oldFile: string | null): string {
  if (file === HUGE_DIFF_FILE) {
    return hugeDiff(file);
  }
  if (file === BINARY_FILE) {
    return `diff --git a/${file} b/${file}\nBinary files a/${file} and b/${file} differ\n`;
  }
  const header = oldFile === null
    ? `diff --git a/${file} b/${file}\nindex 3a91c04..7de2b18 100644\n--- a/${file}\n+++ b/${file}`
    : `diff --git a/${oldFile} b/${file}\nsimilarity index 86%\nrename from ${oldFile}\nrename to ${file}\nindex 3a91c04..7de2b18 100644\n--- a/${oldFile}\n+++ b/${file}`;

  return [
    header,
    "@@ -12,14 +12,18 @@ import type { GraphData } from \"../types\";",
    " const LANE_POOL_SIZE = 10;",
    " ",
    "-function allocLane(lanes: (number | null)[]): number {",
    "-  return lanes.indexOf(null);",
    "+function allocLane(lanes: (number | null)[], recent: number[]): number {",
    "+  const free = lanes.indexOf(null);",
    "+  if (free >= 0) {",
    "+    return free;",
    "+  }",
    "+  lanes.push(null);",
    "+  return lanes.length - 1;",
    " }",
    " ",
    " export function layout(rows: CommitRow[]) {",
    "   const lanes: (number | null)[] = [];",
    "-  let nextColor = 0;",
    "+  const recent: number[] = [];",
    "   for (const row of rows) {",
    "     const lane = allocLane(lanes, recent);",
    "@@ -78,9 +82,12 @@ export function layout(rows: CommitRow[]) {",
    "     row.lane = lane;",
    " ",
    "-    // 레인 종료 시 색을 즉시 반납",
    "-    lanes[lane] = null;",
    "+    // 한 행 뒤에 반납해야 인접 레인이 같은 색을 물려받지 않는다",
    "+    recent.push(lane);",
    "+    if (recent.length > 1) {",
    "+      lanes[recent.shift() as number] = null;",
    "+    }",
    "   }",
    "   return rows;",
    " }",
    "\\ No newline at end of file",
    "",
  ].join("\n");
}

/**
 * 커밋 시점 파일 전문. 기본 200줄이고, 대형 파일만 5,400줄을 돌려줘
 * DiffPanel의 "5,000줄 이상은 하이라이트 생략" 경로까지 확인할 수 있게 한다.
 */
function mockFileContent(file: string): string {
  const total = file === HUGE_DIFF_FILE ? 5400 : 200;
  const name = splitBase(file);
  const out: string[] = [
    `// ${file}`,
    `// 하네스 합성 파일 — ${total}줄`,
    'import type { GraphData } from "../types";',
    "",
    `export interface ${name}Options {`,
    "  limit: number;",
    "  skip: number;",
    "}",
    "",
  ];
  while (out.length < total) {
    const i = out.length;
    if (i % 20 === 0) {
      out.push(`export function step${i}(data: GraphData, options: ${name}Options): number {`);
      out.push(`  const rows = data.rows.slice(options.skip, options.skip + options.limit);`);
      out.push(`  return rows.length + ${i};`);
      out.push("}");
      out.push("");
      continue;
    }
    out.push(`  const value${i} = ${i} * 2; // 합성 라인 ${i}`);
  }
  return out.slice(0, total).join("\n");
}

/** "src/shell/App.tsx" -> "App" (합성 코드의 식별자로 쓴다) */
function splitBase(file: string): string {
  const base = file.split("/").pop() ?? file;
  const stem = base.split(".")[0];
  return stem.charAt(0).toUpperCase() + stem.slice(1).replace(/[^A-Za-z0-9]/g, "");
}

function readArg(payload: unknown, key: string): unknown {
  if (payload === null || typeof payload !== "object") {
    return undefined;
  }
  return (payload as Record<string, unknown>)[key];
}

/**
 * 하네스 전용: ?forceUpdate=1이면 GitHub 릴리스 API 응답을 가로채 v99.0.0을 돌려준다.
 * 업데이트 배너와 수동 확인 pill을 오프라인에서도 볼 수 있게 하는 개발용 분기다.
 * 앱 코드(version.ts)는 건드리지 않는다.
 */
function installForcedUpdate(): void {
  if (!new URLSearchParams(window.location.search).has("forceUpdate")) {
    return;
  }
  const original = window.fetch.bind(window);
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.includes("api.github.com/repos/") && url.endsWith("/releases/latest")) {
      // 확인 중 pill이 보이도록 약간 지연시킨다
      await sleep(700);
      const body = JSON.stringify({
        tag_name: "v99.0.0",
        html_url: "https://github.com/nobel6018/gitlanes/releases/tag/v99.0.0",
        body:
          "## What's new\n\n" +
          "- **레인 색 재활용**: 인접 레인과 같은 색이 붙지 않도록 후보를 고른다\n" +
          "- `파일 트리 뷰` 추가 (Path | Tree 토글)\n" +
          "- 스태시 행을 base 커밋 위에 점선 다이아몬드로 표시\n" +
          "- diff 5,000줄 이상에서도 스크롤이 끊기지 않도록 가상화\n",
      });
      return new Response(body, {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    return original(input, init);
  };
  console.log("[mock] forceUpdate 활성화 — 최신 릴리스를 v99.0.0으로 위조합니다");
}

// ════════════════════════════════════════════════════════════
// v0.18 쓰기 command mock
//
// URL 쿼리로 시나리오를 켠다 (dev-app.html?fail=push&auth=1):
//   ?fail=push,pull   해당 command를 ok:false로 만든다 ("git_" 접두는 생략)
//   ?fail=all         모든 쓰기를 실패시킨다
//   ?auth=1           위 실패에 needsAuth:true를 붙인다 (터미널 핸드오프 검증)
//   ?conflict=1       머지 충돌이 진행 중인 상태로 시작한다
//   ?conflict=am      git am이 충돌로 멈춘 상태로 시작한다 (Continue/Skip patch/Abort)
//   ?conflict=rebase  리베이스가 충돌로 멈춘 상태 (비교 화면의 ours/theirs 뒤집힘 안내 확인)
//   ?conflict=conflicts  이어갈 작업 없이 충돌만 남은 상태 (stash pop 충돌 등). 해결 UI만 보이고
//                     파일을 다 해결하면 pending이 null이 되어 패널이 사라진다
//   ?denied=<계정>    위 실패에 403 stderr와 deniedAccount를 붙인다 (계정 힌트 검증)
//   ?slow=1           쓰기마다 1.2초 지연 (스피너/중복 클릭 방지 검증)
//   ?slow=6000        숫자를 주면 그 밀리초만큼 지연 (5초 폴링 틱이 쓰기 도중에 걸리게 할 때)
//   ?rebaseErr=1      get_rebase_steps가 Err를 돌려준다 (리베이스 에디터가 열리지 않고 토스트만)
//   ?rebaseSlow=3000  get_rebase_steps만 그 밀리초만큼 늦춘다 (메뉴 로딩 상태 검증)
//   ?template=1       get_commit_template이 # 주석 줄이 섞인 템플릿을 돌려준다
//   ?template=1&commentChar=;  주석 접두를 ;로 바꾼 템플릿 (core.commentChar 확인). # 줄은 본문으로 남아야 한다
//   ?compareUnrelated=1&compareLimit=27  비교 목록 한쪽만 잘리게 한다 (목록별 +more 확인)
//   ?noSubmodules=1   서브모듈 없이 시작한다 (사이드바 SUBMODULES 구간이 빈 문구, Add만 있다)
//   ?fail=submodule_update&auth=1  서브모듈 update가 인증 실패로 끝난다 (터미널 핸드오프 확인)
//   ?fail=submodule_add&auth=1     서브모듈 add(clone)가 인증 실패로 끝난다
//   ?fail=submodule_remove         remove가 "확인 뒤 서브모듈 안에 변경이 생겼다"는 Rust 거절로 끝난다
//                                  (git 미실행이라 command가 비어 있다)
//   ?latin1=1         get_wip_file_diff가 encoding:"latin1"을 돌려준다 (git_apply_patch 로그로 전달 확인)
//   ?fail=undo        git_undo가 git 실패로 끝난다 (command 있음, 항목이 스택에 남는다)
//   ?undo=stale       git_undo가 상태 불일치로 거절한다 (command 빈 배열, 항목이 스택에서 빠진다)
//   ?fail=fetch&auth=1  자동 fetch가 인증 실패로 멈춘다 (Fetch 버튼의 ! 표시)
//   자동 fetch는 Preferences > General에서 1분으로 두면 15초 틱 안에 첫 fetch가 돈다
//
// 콘솔: __mockEdit()  파일 수는 그대로, 내용만 바꾼다 (contentToken + unstaged diff 변경)
//       __mockCalls, __mockCallsDuringWrite, __mockResetCalls()  command 호출 횟수
// ════════════════════════════════════════════════════════════

const PARAMS = new URLSearchParams(window.location.search);

const FAIL_SET = new Set(
  (PARAMS.get("fail") ?? "")
    .split(",")
    .map((name) => name.trim())
    .filter((name) => name !== ""),
);
const FAIL_ALL = FAIL_SET.has("all");
const FORCE_AUTH = PARAMS.get("auth") === "1";
/** ?denied=<계정>. 실패가 HTTPS 403으로 그 계정을 밝힌 것처럼 꾸민다 */
const DENIED_ACCOUNT = PARAMS.get("denied");
/** ?rebaseErr=1. get_rebase_steps를 거절시킨다 */
const REBASE_STEPS_ERR = PARAMS.get("rebaseErr") === "1";
/** ?rebaseSlow=<ms>. get_rebase_steps만 늦춘다 */
const REBASE_STEPS_DELAY_MS = Number(PARAMS.get("rebaseSlow") ?? "0");
/** ?commentChar=<접두>. core.commentChar(또는 commentString)가 설정된 레포처럼 군다. 없으면 "#" */
const COMMENT_PREFIX = PARAMS.get("commentChar") || "#";
/**
 * ?template=1. commit.template이 설정된 레포처럼 군다. 주석 줄은 COMMENT_PREFIX로 쓰고, 접두가 "#"가
 * 아니면 "# "로 시작하는 본문 줄을 하나 섞어 그 줄은 지워지지 않는지 본다
 */
const COMMIT_TEMPLATE: CommitTemplate | null =
  PARAMS.get("template") === "1"
    ? {
        text:
          COMMENT_PREFIX === "#"
            ? "\n\n# Why is this change needed?\n# Prevent the graph from flickering on refresh.\n#\n# Refs: #123\n"
            : `\n\n# Heading kept as body text\n${COMMENT_PREFIX} Why is this change needed?\n${COMMENT_PREFIX} Prevent the graph from flickering on refresh.\n${COMMENT_PREFIX}\n`,
        commentPrefix: COMMENT_PREFIX,
      }
    : null;
/** ?latin1=1. WIP diff가 UTF-8이 아닌 파일에서 나온 것처럼 군다 */
const WIP_DIFF_ENCODING: "utf8" | "latin1" = PARAMS.get("latin1") === "1" ? "latin1" : "utf8";
const SLOW_PARAM = Number(PARAMS.get("slow") ?? "0");
const SLOW_WRITES = SLOW_PARAM > 0;
/** ?slow=1은 기존대로 1.2초, 그보다 큰 숫자는 밀리초로 읽는다 */
const WRITE_DELAY_MS = SLOW_PARAM > 1 ? SLOW_PARAM : SLOW_WRITES ? 1200 : 140;

/**
 * 성공한 쓰기가 graphToken을 바꾸는가. 실제 rust는 ref(종류, 이름, sha, is_head), HEAD sha,
 * 스태시 목록을 섞는다. stage, unstage, discard, hunk 적용, clean, remote, 태그 push처럼
 * 이 셋을 안 건드리는 쓰기는 지문이 그대로다
 */
function changesRefs(cmd: string, payload: unknown): boolean {
  switch (cmd) {
    case "git_commit":
    case "git_undo_commit":
    case "git_checkout":
    case "git_create_branch":
    case "git_delete_branch":
    case "git_rename_branch":
    case "git_fetch":
    case "git_pull":
    case "git_push":
    case "git_merge":
    case "git_rebase":
    case "git_rebase_interactive":
    case "git_cherry_pick":
    case "git_revert":
    case "git_reset":
    case "git_pending_action":
    case "git_create_tag":
    case "git_delete_tag":
    case "git_stash_push":
    case "git_stash_drop":
    case "git_stash_branch":
    case "git_undo":
      return true;
    case "git_stash_apply":
      // pop만 스태시 목록을 줄인다
      return boolArg(payload, "drop");
    case "git_add_worktree":
      return boolArg(payload, "createBranch");
    default:
      return false;
  }
}

/** HEAD에서 첫 부모를 따라 base까지 내려가며 todo 순서(과거가 위)로 모은다 */
function mockRebaseSteps(base: string): RebaseStep[] {
  // 화면이 이미 읽어 둔 가장 긴 그래프를 쓴다. 전체(1만여 행) 레이아웃을 새로 만들지 않는다
  const loaded = Math.max(0, ...graphCache.keys());
  const rows = mockGraph(loaded > 0 ? loaded : 500, 0).rows;
  const bySha = new Map(rows.map((row) => [row.sha, row]));
  const head = rows.find((row) => row.isHead) ?? rows[0];
  const range: CommitRow[] = [];
  let cur: CommitRow | undefined = head;
  while (cur !== undefined && cur.sha !== base) {
    if (cur.isMerge) {
      throw `The range ${base.slice(0, 7)}..HEAD contains a merge commit (${cur.shortSha}). Interactive rebase can't keep merges.`;
    }
    range.push(cur);
    cur = bySha.get(cur.parents[0] ?? "");
  }
  if (cur === undefined) {
    throw `${base.slice(0, 7)} is not an ancestor of HEAD, so there is nothing to rebase onto it.`;
  }
  return range
    .reverse()
    .map((row) => ({ sha: row.sha, action: "pick", subject: row.subject, message: null }));
}

/** 진행 중인 작업. ?conflict=1|am|conflicts면 처음부터 켜져 있다 */
function initialPending(): PendingOp | null {
  switch (PARAMS.get("conflict")) {
    case "1":
      return { kind: "merge", progress: null, conflictCount: 3, detail: "origin/develop into main" };
    case "am":
      return { kind: "am", progress: "2/5", conflictCount: 3, detail: null };
    case "rebase":
      return { kind: "rebase", progress: "1/3", conflictCount: 3, detail: "origin/main" };
    case "conflicts":
      return { kind: "conflicts", progress: null, conflictCount: 3, detail: null };
    default:
      return null;
  }
}

let pendingOp: PendingOp | null = initialPending();

/** 스태시 command가 받은 sha. 콘솔에서 __mockStashShas로 배선을 확인한다 */
const stashShaLog: { cmd: string; ref: string; sha: unknown }[] = [];
(window as unknown as { __mockStashShas: typeof stashShaLog }).__mockStashShas = stashShaLog;

function logStashSha(cmd: string, payload: unknown): void {
  const entry = { cmd, ref: String(readArg(payload, "ref") ?? ""), sha: readArg(payload, "sha") };
  stashShaLog.push(entry);
  console.log("[mock] stash sha:", entry);
}

const CONFLICT_FILES: ConflictFile[] = [
  { path: "src/shell/RepoWorkspace.tsx", kind: "bothModified", hasMarkers: true },
  { path: "src/types.ts", kind: "bothModified", hasMarkers: true },
  { path: "src/legacy/OldGraph.tsx", kind: "deletedByUs", hasMarkers: false },
];

/** 해결 처리된 충돌 파일 경로. get_conflicts 결과에서 빠진다 */
const resolvedConflicts = new Set<string>();

/** 하네스에서 만든 스태시 개수. get_sync_state의 stashCount에 쓴다 */
let stashCount = 2;
let aheadCount = 3;
let behindCount = 1;

const remoteStore: RemoteInfo[] = [
  {
    name: "origin",
    fetchUrl: "git@github.com:gitlanes/awesome-project.git",
    pushUrl: "git@github.com:gitlanes/awesome-project.git",
  },
  {
    name: "upstream",
    fetchUrl: "https://github.com/upstream/awesome-project.git",
    pushUrl: "https://github.com/upstream/awesome-project.git",
  },
];

const worktreeStore: WorktreeInfo[] = [
  { path: MOCK_PATH, branch: "main", head: REPO.headSha, isMain: true, isPrunable: false },
  {
    path: "/mock/awesome-project-hotfix",
    branch: "fix/lane-color-reuse",
    head: fakeSha("wt-1"),
    isMain: false,
    isPrunable: false,
  },
];

/** command 이름에서 git_ 접두를 떼고 실패 목록과 맞춰 본다 */
function shouldFail(cmd: string): boolean {
  return FAIL_ALL || FAIL_SET.has(cmd.replace(/^git_/, ""));
}

function deniedStderr(account: string): string {
  return [
    `remote: Permission to gitlanes/awesome-project.git denied to ${account}.`,
    "fatal: unable to access 'https://github.com/gitlanes/awesome-project.git/': The requested URL returned error: 403",
  ].join("\n");
}

const AUTH_STDERR = [
  "git@github.com: Permission denied (publickey).",
  "fatal: Could not read from remote repository.",
  "",
  "Please make sure you have the correct access rights",
  "and the repository exists.",
].join("\n");

/** 맨 위 커밋 sha. 하네스 커밋(extraRows)이 있으면 그것이다 */
function mockHeadSha(): string {
  return mockGraph(1000, 0).rows[0]?.sha ?? "";
}

/**
 * get_ref_snapshot mock. 실제처럼 ref마다 sha를 다 들고 있지는 않고, 쓰기 횟수(refSalt)를 가짜 ref로
 * 넣어 ref를 바꾸는 쓰기의 전후 스냅샷이 서로 달라지게만 한다
 */
function mockRefSnapshot(): RefSnapshot {
  const head = mockHeadSha();
  return {
    headRef: "refs/heads/main",
    headSha: head,
    refs: { "refs/heads/main": head, "refs/mock/write-count": String(refSalt) },
    upstreams: { "refs/heads/main": { remote: "origin", merge: "refs/heads/main" } },
  };
}

function ok(command: string[], stdout = ""): OpResult {
  writeSalt += 1;
  return { ok: true, stdout, stderr: "", conflicts: [], command, needsAuth: false, deniedAccount: null };
}

function fail(command: string[], stderr: string, conflicts: string[] = []): OpResult {
  return {
    ok: false,
    stdout: "",
    stderr: DENIED_ACCOUNT !== null ? deniedStderr(DENIED_ACCOUNT) : FORCE_AUTH ? AUTH_STDERR : stderr,
    conflicts,
    command,
    needsAuth: FORCE_AUTH,
    deniedAccount: DENIED_ACCOUNT,
  };
}

function arg(payload: unknown, key: string): unknown {
  return readArg(payload, key);
}

function strArg(payload: unknown, key: string): string {
  const value = readArg(payload, key);
  return typeof value === "string" ? value : "";
}

function listArg(payload: unknown, key: string): string[] {
  const value = readArg(payload, key);
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

function boolArg(payload: unknown, key: string): boolean {
  return readArg(payload, key) === true;
}

/** 경로 목록을 한 영역에서 빼서 다른 영역에 넣는다 (중복 없이) */
function moveFiles(from: FileChange[], to: FileChange[], paths: string[]): void {
  const wanted = new Set(paths);
  for (let i = from.length - 1; i >= 0; i--) {
    const file = from[i];
    if (!wanted.has(file.path)) {
      continue;
    }
    from.splice(i, 1);
    if (!to.some((entry) => entry.path === file.path)) {
      to.unshift(file);
    }
  }
}

function removeFiles(area: FileChange[], paths: string[]): void {
  const wanted = new Set(paths);
  for (let i = area.length - 1; i >= 0; i--) {
    if (wanted.has(area[i].path)) {
      area.splice(i, 1);
    }
  }
}

/**
 * 쓰기 command를 처리한다. 모르는 command면 null을 돌려 기존 switch로 넘긴다.
 * 각 분기는 mock 상태를 실제로 고친다 (stage 하면 파일이 옮겨 가고, commit 하면 행이 생긴다).
 */
function handleWrite(cmd: string, payload: unknown): OpResult | null {
  const files = listArg(payload, "files");

  switch (cmd) {
    case "git_stage": {
      const command = ["add", "--", ...files];
      if (shouldFail(cmd)) {
        return fail(command, `error: pathspec '${files[0] ?? ""}' did not match any file`);
      }
      moveFiles(wipStore.unstaged, wipStore.staged, files);
      moveFiles(wipStore.untracked, wipStore.staged, files);
      return ok(command);
    }

    case "git_unstage": {
      const command = ["restore", "--staged", "--", ...files];
      if (shouldFail(cmd)) {
        return fail(command, "error: unable to unstage");
      }
      moveFiles(wipStore.staged, wipStore.unstaged, files);
      return ok(command);
    }

    case "git_discard": {
      // area="worktree"는 staged 변경을 살린다. "all"은 인덱스까지 되돌린다
      const area = strArg(payload, "area") === "worktree" ? "worktree" : "all";
      // argv는 rust ops/stage.rs와 같은 모양으로 둔다. 토스트와 터미널 핸드오프에
      // 그대로 보이는 값이라 어긋나면 QA가 잘못된 명령을 읽는다
      const command =
        area === "worktree"
          ? ["restore", "--worktree", "--", ...files]
          : ["restore", "--source=HEAD", "--staged", "--worktree", "--", ...files];
      if (shouldFail(cmd)) {
        return fail(command, "error: unable to discard");
      }
      removeFiles(wipStore.unstaged, files);
      removeFiles(wipStore.untracked, files);
      if (area === "all") {
        removeFiles(wipStore.staged, files);
      }
      return ok(command);
    }

    case "git_stage_all": {
      const command = ["add", "-A"];
      if (shouldFail(cmd)) {
        return fail(command, "error: unable to stage everything");
      }
      const all = [...wipStore.unstaged, ...wipStore.untracked].map((file) => file.path);
      moveFiles(wipStore.unstaged, wipStore.staged, all);
      moveFiles(wipStore.untracked, wipStore.staged, all);
      return ok(command);
    }

    case "git_unstage_all": {
      const command = ["reset"];
      if (shouldFail(cmd)) {
        return fail(command, "error: unable to unstage everything");
      }
      moveFiles(wipStore.staged, wipStore.unstaged, wipStore.staged.map((file) => file.path));
      return ok(command);
    }

    case "git_apply_patch": {
      const cached = boolArg(payload, "cached");
      const reverse = boolArg(payload, "reverse");
      const command = [
        "apply",
        "--unidiff-zero",
        "--whitespace=nowarn",
        ...(cached ? ["--cached"] : []),
        ...(reverse ? ["--reverse"] : []),
      ];
      if (shouldFail(cmd)) {
        return fail(command, "error: patch does not apply");
      }
      console.log("[mock] git_apply_patch", {
        cached,
        reverse,
        encoding: readArg(payload, "encoding"),
      });
      // hunk 단위 스테이징은 패치 내용까지 흉내내지 않는다. 첫 unstaged 파일만 옮겨
      // 화면이 실제로 바뀌는지 확인할 수 있게 한다
      const first = (reverse ? wipStore.staged : wipStore.unstaged)[0];
      if (first !== undefined && cached) {
        moveFiles(
          reverse ? wipStore.staged : wipStore.unstaged,
          reverse ? wipStore.unstaged : wipStore.staged,
          [first.path],
        );
      }
      return ok(command);
    }

    case "git_clean": {
      const paths = listArg(payload, "paths");
      const command = ["clean", "-fd", "--", ...paths];
      if (shouldFail(cmd)) {
        return fail(command, "error: clean refused");
      }
      removeFiles(wipStore.untracked, paths);
      return ok(command);
    }

    case "git_commit": {
      const options = arg(payload, "options") as { message?: string; amend?: boolean } | undefined;
      const message = options?.message ?? "";
      const command = ["commit", "-m", message, ...(options?.amend === true ? ["--amend"] : [])];
      if (shouldFail(cmd)) {
        return fail(command, "error: gpg failed to sign the data");
      }
      if (wipStore.staged.length === 0 && options?.amend !== true) {
        return fail(command, "nothing to commit, working tree clean");
      }
      wipStore.staged.length = 0;
      if (options?.amend !== true) {
        pushCommit(message);
        aheadCount += 1;
      }
      return ok(command, `[main ${fakeSha(message).slice(0, 7)}] ${message.split("\n")[0]}`);
    }

    case "git_undo_commit": {
      const command = ["reset", "--soft", "HEAD~1"];
      if (shouldFail(cmd)) {
        return fail(command, "fatal: ambiguous argument 'HEAD~1'");
      }
      if (extraRows.length > 0) {
        extraRows.shift();
        aheadCount = Math.max(0, aheadCount - 1);
        writeSalt += 1;
      }
      return ok(command);
    }

    case "git_checkout": {
      const target = strArg(payload, "target");
      const command = ["checkout", target];
      if (shouldFail(cmd)) {
        return fail(command, `error: pathspec '${target}' did not match any file(s) known to git`);
      }
      return ok(command, `Switched to branch '${target}'`);
    }

    case "git_create_branch": {
      const name = strArg(payload, "name");
      const command = ["branch", name];
      if (shouldFail(cmd)) {
        return fail(command, `fatal: a branch named '${name}' already exists`);
      }
      refsCache = null;
      return ok(command);
    }

    case "git_delete_branch": {
      const name = strArg(payload, "name");
      const remote = boolArg(payload, "remote");
      const command = remote
        ? ["push", "origin", "--delete", name.replace(/^[^/]+\//, "")]
        : ["branch", boolArg(payload, "force") ? "-D" : "-d", name];
      if (shouldFail(cmd)) {
        return fail(command, `error: the branch '${name}' is not fully merged`);
      }
      refsCache = null;
      return ok(command);
    }

    case "git_rename_branch": {
      const command = ["branch", "-m", strArg(payload, "from"), strArg(payload, "to")];
      if (shouldFail(cmd)) {
        return fail(command, "fatal: invalid branch name");
      }
      refsCache = null;
      return ok(command);
    }

    case "git_set_upstream": {
      const upstream = arg(payload, "upstream");
      const command =
        upstream === null
          ? ["branch", "--unset-upstream", strArg(payload, "branch")]
          : ["branch", "-u", String(upstream), strArg(payload, "branch")];
      if (shouldFail(cmd)) {
        return fail(command, "fatal: the requested upstream branch does not exist");
      }
      return ok(command);
    }

    case "git_submodule_update": {
      const paths = listArg(payload, "paths");
      const init = boolArg(payload, "init");
      const command = [
        "submodule",
        "update",
        ...(init ? ["--init"] : []),
        "--recursive",
        "--",
        ...paths,
      ];
      if (shouldFail(cmd)) {
        return fail(command, "fatal: clone of 'git@github.com:gitlanes/proto.git' into submodule path failed");
      }
      const targets =
        paths.length === 0 ? submoduleStore : submoduleStore.filter((sub) => paths.includes(sub.path));
      for (const sub of targets) {
        // --init 없이는 초기화 안 한 서브모듈을 건너뛴다(git과 같다)
        if (sub.state === "uninitialized" && !init) {
          continue;
        }
        sub.headSha = sub.recordedSha;
        sub.state = "ok";
        // 기록과 HEAD가 같아졌으니 상위 레포의 unstaged gitlink도 사라진다
        removeFiles(wipStore.unstaged, [sub.path]);
      }
      return ok(command, "Submodule path 'third_party/proto': checked out");
    }

    case "git_submodule_add": {
      const options = arg(payload, "options") as AddSubmoduleOptions | undefined;
      const url = options?.url ?? "";
      const subPath = options?.path ?? "";
      const branch = options?.branch ?? null;
      // Rust의 인자 검증과 같다. command 자체가 reject 된다
      if (url.startsWith("-")) {
        throw `The submodule URL cannot start with "-": ${url}`;
      }
      const command = ["submodule", "add", ...(branch !== null ? ["-b", branch] : []), "--", url, subPath];
      if (shouldFail(cmd)) {
        return fail(
          command,
          `Cloning into '${MOCK_PATH}/${subPath}'...\nfatal: repository '${url}' not found\nfatal: clone of '${url}' into submodule path '${MOCK_PATH}/${subPath}' failed`,
        );
      }
      if (submoduleStore.some((sub) => sub.path === subPath)) {
        return fail(command, `'${subPath}' already exists in the index`);
      }
      const head = fakeSha(`${subPath}-added-${url}`);
      submoduleStore.push({
        name: subPath,
        path: subPath,
        url,
        branch,
        recordedSha: head,
        headSha: head,
        state: "ok",
        dirty: false,
      });
      submoduleStore.sort((a, b) => a.path.localeCompare(b.path));
      // .gitmodules 항목과 gitlink가 스테이지된다. 커밋은 사용자가 한다
      const lines = branch === null ? 3 : 4;
      const gitmodules = wipStore.staged.find((file) => file.path === ".gitmodules");
      if (gitmodules !== undefined) {
        gitmodules.additions += lines;
      } else {
        wipStore.staged.unshift({
          path: ".gitmodules",
          oldPath: null,
          status: submoduleStore.length === 1 ? "A" : "M",
          additions: lines,
          deletions: 0,
        });
      }
      removeFiles(wipStore.staged, [subPath]);
      wipStore.staged.unshift({
        path: subPath,
        oldPath: null,
        status: "A",
        additions: 0,
        deletions: 0,
        submodule: true,
      });
      return ok(command, `Cloning into '${MOCK_PATH}/${subPath}'...\ndone.`);
    }

    case "git_submodule_remove": {
      const subPath = strArg(payload, "subPath");
      const force = boolArg(payload, "force");
      const command = ["rm", ...(force ? ["-f"] : []), "--", subPath];
      const sub = submoduleStore.find((entry) => entry.path === subPath);
      if (sub === undefined) {
        return fail(command, `error: pathspec '${subPath}' did not match any file(s) known to git`);
      }
      // Rust 거절(git 미실행): force=false인데 서브모듈 안에 커밋 안 한 변경이 있다
      const refusal = `${subPath} has uncommitted changes inside the submodule. Nothing was removed.`;
      if (shouldFail(cmd) || (!force && sub.dirty)) {
        return fail([], refusal);
      }
      submoduleStore.splice(submoduleStore.indexOf(sub), 1);
      removeFiles(wipStore.unstaged, [subPath]);
      // 이번 세션에 추가만 하고 커밋 안 한 서브모듈이면 스테이지 항목이 그냥 사라진다
      const stagedLink = wipStore.staged.find((file) => file.path === subPath);
      removeFiles(wipStore.staged, [subPath]);
      if (stagedLink?.status !== "A") {
        wipStore.staged.unshift({
          path: subPath,
          oldPath: null,
          status: "D",
          additions: 0,
          deletions: 0,
          submodule: true,
        });
      }
      const gitmodules = wipStore.staged.find((file) => file.path === ".gitmodules");
      if (gitmodules === undefined) {
        wipStore.staged.unshift({
          path: ".gitmodules",
          oldPath: null,
          status: submoduleStore.length === 0 ? "D" : "M",
          additions: 0,
          deletions: 3,
        });
      } else if (gitmodules.status === "A" && submoduleStore.length === 0) {
        removeFiles(wipStore.staged, [".gitmodules"]);
      } else {
        gitmodules.deletions += 3;
      }
      return ok(command, `Cleared directory '${subPath}'\nrm '${subPath}'`);
    }

    case "git_fetch": {
      const command = [
        "fetch",
        ...(boolArg(payload, "allRemotes") ? ["--all"] : []),
        ...(boolArg(payload, "prune") ? ["--prune"] : []),
        ...(boolArg(payload, "tags") ? ["--tags"] : []),
      ];
      if (shouldFail(cmd)) {
        return fail(command, "fatal: unable to access remote: Could not resolve host");
      }
      behindCount += 1;
      refsCache = null;
      return ok(command, "From github.com:gitlanes/awesome-project\n   8f2c1a9..b41d0e7  main -> origin/main");
    }

    case "git_pull": {
      const mode = strArg(payload, "mode");
      const command = [
        "pull",
        mode === "rebase" ? "--rebase" : mode === "ff-only" ? "--ff-only" : "--no-rebase",
      ];
      if (shouldFail(cmd)) {
        // 풀 충돌은 진행 중 상태를 남긴다. 충돌 패널 경로를 이걸로 검증한다
        resolvedConflicts.clear();
        pendingOp = {
          kind: mode === "rebase" ? "rebase" : "merge",
          progress: mode === "rebase" ? "2/5" : null,
          conflictCount: CONFLICT_FILES.length,
          detail: "origin/main into main",
        };
        writeSalt += 1;
        return fail(
          command,
          "CONFLICT (content): Merge conflict in src/types.ts\nAutomatic merge failed; fix conflicts and then commit the result.",
          CONFLICT_FILES.map((file) => file.path),
        );
      }
      behindCount = 0;
      refsCache = null;
      return ok(command, "Fast-forward\n 3 files changed, 41 insertions(+), 9 deletions(-)");
    }

    case "git_push": {
      const command = [
        "push",
        ...(boolArg(payload, "setUpstream") ? ["-u"] : []),
        ...(boolArg(payload, "forceWithLease") ? ["--force-with-lease"] : []),
        ...(boolArg(payload, "tags") ? ["--tags"] : []),
        "origin",
        "main",
      ];
      if (shouldFail(cmd)) {
        return fail(
          command,
          "! [rejected]        main -> main (non-fast-forward)\nerror: failed to push some refs",
        );
      }
      aheadCount = 0;
      return ok(command, "To github.com:gitlanes/awesome-project.git\n   8f2c1a9..b41d0e7  main -> main");
    }

    case "git_merge": {
      const source = strArg(payload, "source");
      const command = [
        "merge",
        ...(boolArg(payload, "noFf") ? ["--no-ff"] : []),
        ...(boolArg(payload, "squash") ? ["--squash"] : []),
        source,
      ];
      if (shouldFail(cmd)) {
        resolvedConflicts.clear();
        pendingOp = {
          kind: "merge",
          progress: null,
          conflictCount: CONFLICT_FILES.length,
          detail: `${source} into main`,
        };
        writeSalt += 1;
        return fail(
          command,
          `CONFLICT (content): Merge conflict in src/types.ts\nAutomatic merge failed; fix conflicts and then commit the result.`,
          CONFLICT_FILES.map((file) => file.path),
        );
      }
      pushCommit(`Merge branch '${source}'`);
      return ok(command, "Merge made by the 'ort' strategy.");
    }

    case "git_rebase": {
      const upstream = strArg(payload, "upstream");
      const command = ["rebase", "--autostash", upstream];
      if (shouldFail(cmd)) {
        resolvedConflicts.clear();
        pendingOp = {
          kind: "rebase",
          progress: "3/7",
          conflictCount: CONFLICT_FILES.length,
          detail: `onto ${upstream}`,
        };
        writeSalt += 1;
        return fail(command, "error: could not apply b41d0e7... tweak lanes", CONFLICT_FILES.map((f) => f.path));
      }
      writeSalt += 1;
      return ok(command, `Successfully rebased and updated refs/heads/main.`);
    }

    case "git_rebase_interactive": {
      const steps = arg(payload, "steps");
      const command = ["rebase", "-i", strArg(payload, "base")];
      console.log("[mock] git_rebase_interactive steps:", steps);
      if (shouldFail(cmd)) {
        return fail(command, "error: could not apply 1a2b3c4... reword me");
      }
      writeSalt += 1;
      return ok(command, "Successfully rebased and updated refs/heads/main.");
    }

    case "git_cherry_pick": {
      const shas = listArg(payload, "shas");
      const command = ["cherry-pick", ...shas];
      if (shouldFail(cmd)) {
        pendingOp = {
          kind: "cherryPick",
          progress: null,
          conflictCount: 1,
          detail: shas[0] ?? null,
        };
        writeSalt += 1;
        return fail(command, "error: could not apply " + (shas[0] ?? ""), [CONFLICT_FILES[0].path]);
      }
      for (const sha of shas) {
        pushCommit(`Cherry-picked ${sha.slice(0, 7)}`);
      }
      return ok(command);
    }

    case "git_revert": {
      const shas = listArg(payload, "shas");
      const command = ["revert", "--no-edit", ...shas];
      if (shouldFail(cmd)) {
        pendingOp = { kind: "revert", progress: null, conflictCount: 1, detail: shas[0] ?? null };
        writeSalt += 1;
        return fail(command, "error: could not revert " + (shas[0] ?? ""), [CONFLICT_FILES[0].path]);
      }
      for (const sha of shas) {
        pushCommit(`Revert "${sha.slice(0, 7)}"`);
      }
      return ok(command);
    }

    case "git_reset": {
      const mode = strArg(payload, "mode");
      const target = strArg(payload, "target");
      const command = ["reset", `--${mode}`, target];
      if (shouldFail(cmd)) {
        return fail(command, `fatal: ambiguous argument '${target}'`);
      }
      if (mode === "hard") {
        wipStore.staged.length = 0;
        wipStore.unstaged.length = 0;
      } else if (mode === "mixed") {
        moveFiles(wipStore.staged, wipStore.unstaged, wipStore.staged.map((file) => file.path));
      }
      writeSalt += 1;
      return ok(command);
    }

    case "git_pending_action": {
      const action = strArg(payload, "action");
      const kind = strArg(payload, "kind");
      if (kind === "conflicts") {
        // 프론트가 막아야 하는 호출이다. 오면 배선이 틀린 것이라 눈에 띄게 남긴다
        console.error("[mock] git_pending_action이 conflicts로 불렸다");
        return fail(["status"], "fatal: nothing to continue: only conflicts are left");
      }
      const flag =
        kind === "merge"
          ? "merge"
          : kind === "revert"
            ? "revert"
            : kind === "cherryPick"
              ? "cherry-pick"
              : kind === "am"
                ? "am"
                : "rebase";
      const command = [flag, `--${action}`];
      if (shouldFail(cmd)) {
        return fail(command, `fatal: no ${flag} in progress`);
      }
      if (action === "abort" || action === "continue") {
        pendingOp = null;
        resolvedConflicts.clear();
      }
      writeSalt += 1;
      return ok(command);
    }

    case "git_create_tag": {
      const name = strArg(payload, "name");
      const command = ["tag", name, strArg(payload, "target")];
      if (shouldFail(cmd)) {
        return fail(command, `fatal: tag '${name}' already exists`);
      }
      refsCache = null;
      return ok(command);
    }

    case "git_delete_tag": {
      const command = ["tag", "-d", strArg(payload, "name")];
      if (shouldFail(cmd)) {
        return fail(command, "error: tag not found");
      }
      refsCache = null;
      return ok(command);
    }

    case "git_push_tag": {
      const name = strArg(payload, "name");
      const remote = strArg(payload, "remote");
      const command = boolArg(payload, "delete")
        ? ["push", remote, "--delete", name]
        : ["push", remote, name];
      if (shouldFail(cmd)) {
        return fail(command, "remote: Permission to gitlanes/awesome-project.git denied");
      }
      return ok(command);
    }

    case "git_stash_push": {
      const command = [
        "stash",
        "push",
        ...(boolArg(payload, "includeUntracked") ? ["-u"] : []),
        ...(boolArg(payload, "keepIndex") ? ["--keep-index"] : []),
      ];
      if (shouldFail(cmd)) {
        return fail(command, "No local changes to save");
      }
      if (wipStore.staged.length + wipStore.unstaged.length === 0) {
        return fail(command, "No local changes to save");
      }
      wipStore.staged.length = 0;
      wipStore.unstaged.length = 0;
      if (boolArg(payload, "includeUntracked")) {
        wipStore.untracked.length = 0;
      }
      stashCount += 1;
      writeSalt += 1;
      return ok(command, "Saved working directory and index state");
    }

    case "git_stash_apply": {
      logStashSha(cmd, payload);
      const stashRef = strArg(payload, "ref");
      const drop = boolArg(payload, "drop");
      const command = ["stash", drop ? "pop" : "apply", stashRef];
      if (shouldFail(cmd)) {
        // 실제 git처럼 스태시 충돌은 이어갈 작업 없이 충돌만 남긴다 (v0.16 "conflicts")
        resolvedConflicts.clear();
        pendingOp = {
          kind: "conflicts",
          progress: null,
          conflictCount: CONFLICT_FILES.length,
          detail: null,
        };
        writeSalt += 1;
        return fail(
          command,
          "CONFLICT (content): Merge conflict in src/types.ts",
          [CONFLICT_FILES[1].path],
        );
      }
      if (stashCount === 0) {
        return fail(command, `fatal: ${stashRef} is not a valid reference`);
      }
      wipStore.unstaged.unshift({
        path: "src/graph/lane-layout.ts",
        oldPath: null,
        status: "M",
        additions: 12,
        deletions: 3,
      });
      if (drop) {
        stashCount -= 1;
      }
      writeSalt += 1;
      return ok(command);
    }

    case "git_stash_drop": {
      logStashSha(cmd, payload);
      const command = ["stash", "drop", strArg(payload, "ref")];
      if (shouldFail(cmd)) {
        return fail(command, "error: could not drop stash entry");
      }
      stashCount = Math.max(0, stashCount - 1);
      writeSalt += 1;
      return ok(command);
    }

    case "git_stash_branch": {
      logStashSha(cmd, payload);
      const command = ["stash", "branch", strArg(payload, "name"), strArg(payload, "ref")];
      if (shouldFail(cmd)) {
        return fail(command, "fatal: invalid branch name");
      }
      stashCount = Math.max(0, stashCount - 1);
      refsCache = null;
      return ok(command);
    }

    case "git_add_remote": {
      const name = strArg(payload, "name");
      const url = strArg(payload, "url");
      const command = ["remote", "add", name, url];
      if (shouldFail(cmd)) {
        return fail(command, `error: remote ${name} already exists.`);
      }
      remoteStore.push({ name, fetchUrl: url, pushUrl: url });
      return ok(command);
    }

    case "git_remove_remote": {
      const name = strArg(payload, "name");
      const command = ["remote", "remove", name];
      if (shouldFail(cmd)) {
        return fail(command, `error: No such remote: '${name}'`);
      }
      const index = remoteStore.findIndex((remote) => remote.name === name);
      if (index >= 0) {
        remoteStore.splice(index, 1);
      }
      return ok(command);
    }

    case "git_rename_remote": {
      const from = strArg(payload, "from");
      const to = strArg(payload, "to");
      const command = ["remote", "rename", from, to];
      if (shouldFail(cmd)) {
        return fail(command, `error: No such remote: '${from}'`);
      }
      const remote = remoteStore.find((entry) => entry.name === from);
      if (remote !== undefined) {
        remote.name = to;
      }
      return ok(command);
    }

    case "git_set_remote_url": {
      const name = strArg(payload, "name");
      const url = strArg(payload, "url");
      const command = ["remote", "set-url", name, url];
      if (shouldFail(cmd)) {
        return fail(command, `error: No such remote '${name}'`);
      }
      const remote = remoteStore.find((entry) => entry.name === name);
      if (remote !== undefined) {
        remote.fetchUrl = url;
        remote.pushUrl = url;
      }
      return ok(command);
    }

    case "git_add_worktree": {
      const dir = strArg(payload, "dir");
      const branch = strArg(payload, "branch");
      const command = ["worktree", "add", dir, branch];
      if (shouldFail(cmd)) {
        return fail(command, `fatal: '${dir}' already exists`);
      }
      worktreeStore.push({
        path: dir,
        branch,
        head: fakeSha(dir),
        isMain: false,
        isPrunable: false,
      });
      return ok(command);
    }

    case "git_remove_worktree": {
      const dir = strArg(payload, "dir");
      const command = ["worktree", "remove", ...(boolArg(payload, "force") ? ["--force"] : []), dir];
      if (shouldFail(cmd)) {
        return fail(command, `fatal: '${dir}' contains modified or untracked files`);
      }
      const index = worktreeStore.findIndex((tree) => tree.path === dir);
      if (index >= 0) {
        worktreeStore.splice(index, 1);
      }
      return ok(command);
    }

    case "git_resolve_with": {
      const file = strArg(payload, "file");
      const side = strArg(payload, "side");
      const command = ["checkout", `--${side}`, "--", file];
      if (shouldFail(cmd)) {
        return fail(command, `error: path '${file}' does not have our version`);
      }
      resolveConflict(file);
      return ok(command);
    }

    case "git_mark_resolved": {
      const command = ["add", "--", ...files];
      if (shouldFail(cmd)) {
        return fail(command, "error: unable to add files");
      }
      for (const file of files) {
        resolveConflict(file);
      }
      return ok(command);
    }

    case "git_undo": {
      const entry = arg(payload, "entry") as UndoEntry | undefined;
      if (entry === undefined) {
        return fail(["undo"], "error: missing undo entry");
      }
      const command =
        entry.kind === "commit" || entry.kind === "amend"
          ? ["reset", "--soft", entry.before.headSha]
          : entry.kind === "checkout"
            ? ["checkout", (entry.before.headRef ?? entry.before.headSha).replace(/^refs\/heads\//, "")]
            : entry.kind === "reset"
              ? ["reset", `--${entry.resetMode ?? "mixed"}`, entry.before.headSha]
              : ["update-ref", "--stdin"];
      // 실제 Rust처럼 이 작업이 바꾼 ref가 그 뒤 움직였으면 git을 실행하지 않고 거절한다(command 빈 배열).
      // mock은 HEAD만 본다
      const moved = (entry.kind === "commit" || entry.kind === "amend") && entry.after.headSha !== mockHeadSha();
      if (PARAMS.get("undo") === "stale" || moved) {
        return {
          ok: false,
          stdout: "",
          stderr: "The repository changed since this action. Undo is no longer safe.",
          conflicts: [],
          command: [],
          needsAuth: false,
          deniedAccount: null,
        };
      }
      if (shouldFail(cmd)) {
        return fail(command, "error: Your local changes to the following files would be overwritten by checkout:\n\tsrc/graph/canvas.ts");
      }
      if (entry.kind === "commit" && extraRows.length > 0) {
        extraRows.shift();
        aheadCount = Math.max(0, aheadCount - 1);
      }
      refsCache = null;
      return ok(command);
    }

    case "git_create_patch": {
      const shas = listArg(payload, "shas");
      const command = ["format-patch", "-o", strArg(payload, "outDir"), ...shas];
      if (shouldFail(cmd)) {
        return fail(command, "fatal: could not create patch files");
      }
      return ok(command, shas.map((sha, i) => `${String(i + 1).padStart(4, "0")}-${sha.slice(0, 7)}.patch`).join("\n"));
    }

    case "git_apply_patch_file": {
      const command = ["apply", strArg(payload, "file")];
      if (shouldFail(cmd)) {
        return fail(command, "error: patch does not apply");
      }
      return ok(command);
    }

    default:
      return null;
  }
}

/**
 * 충돌 파일 하나를 해결 처리한다.
 * git 기준으로 "해결"은 인덱스에서 unmerged가 사라지는 것이라, 해결한 파일은
 * get_conflicts 결과에서 빠져야 한다. hasMarkers만 내리면 ConflictPanel의
 * Continue 활성 조건(files.length === 0)이 영원히 안 채워진다
 */
function resolveConflict(file: string): void {
  resolvedConflicts.add(file);
  if (pendingOp !== null) {
    const left = remainingConflicts().length;
    // "conflicts"는 충돌 파일 자체가 상태라 다 풀리면 진행 중인 것이 없다. 실제 Rust도 null을 준다
    pendingOp =
      pendingOp.kind === "conflicts" && left === 0 ? null : { ...pendingOp, conflictCount: left };
  }
  writeSalt += 1;
}

/** 아직 해결되지 않은 충돌 파일 */
function remainingConflicts(): ConflictFile[] {
  return CONFLICT_FILES.filter((file) => !resolvedConflicts.has(file.path));
}

function currentSyncState(): SyncState {
  return {
    branch: "main",
    upstream: "origin/main",
    ahead: aheadCount,
    behind: behindCount,
    stashCount,
    pending: pendingOp,
  };
}

if (FAIL_SET.size > 0 || FORCE_AUTH || DENIED_ACCOUNT !== null || pendingOp !== null || SLOW_WRITES) {
  console.log("[mock] 쓰기 시나리오:", {
    fail: [...FAIL_SET],
    auth: FORCE_AUTH,
    denied: DENIED_ACCOUNT,
    conflict: pendingOp !== null,
    slow: SLOW_WRITES,
  });
}

installForcedUpdate();

mockIPC(async (cmd, payload) => {
  countCall(cmd);
  // 쓰기 command는 한곳에서 처리한다. 모르는 이름이면 null이 와서 아래 switch로 흐른다
  if (cmd.startsWith("git_")) {
    writesInFlight += 1;
    let result: OpResult | null;
    try {
      await sleep(WRITE_DELAY_MS);
      result = handleWrite(cmd, payload);
    } finally {
      writesInFlight -= 1;
    }
    if (result !== null) {
      if (result.ok && changesRefs(cmd, payload)) {
        refSalt += 1;
      }
      console.log(`[mock] ${cmd}`, result.ok ? "ok" : `failed: ${result.stderr.split("\n")[0]}`);
      return result;
    }
  }

  switch (cmd) {
    case "get_startup_repo":
      await sleep(60);
      return MOCK_PATH;

    case "open_repo": {
      await sleep(120);
      const path = String(readArg(payload, "path") ?? MOCK_PATH);
      // 탭마다 다른 레포처럼 보이도록 경로에 따라 이름/브랜치를 바꾼다
      const name = path.split("/").filter(Boolean).pop() ?? REPO.name;
      const branches = ["main", "develop", "release/0.7"];
      return {
        ...REPO,
        path,
        name,
        headBranch: branches[hashOf(path) % branches.length],
      };
    }

    case "get_remote_url":
      await sleep(40);
      return MOCK_REMOTE_URL;

    case "load_graph": {
      await sleep(220);
      const limit = Number(readArg(payload, "limit") ?? 0);
      const skip = Number(readArg(payload, "skip") ?? 0);
      return mockGraph(limit, skip);
    }

    case "search_commits": {
      await sleep(160);
      const query = String(readArg(payload, "query") ?? "");
      const limit = Math.min(Number(readArg(payload, "limit") ?? 500), 500);
      return mockSearch(query, limit);
    }

    case "get_repo_state": {
      await sleep(30);
      const state: RepoState = { graphToken: currentToken(), wip: currentWip() };
      return state;
    }

    case "list_refs":
      await sleep(80);
      return mockRefs();

    // ── v0.18 조회 command ──────────────────────────────
    case "get_sync_state":
      await sleep(25);
      return currentSyncState();

    case "get_conflicts":
      await sleep(40);
      return pendingOp === null ? [] : remainingConflicts().map((file) => ({ ...file }));

    case "get_conflict_side": {
      await sleep(50);
      const side = String(readArg(payload, "side") ?? "ours");
      const file = String(readArg(payload, "file") ?? "");
      const conflict = CONFLICT_FILES.find((entry) => entry.path === file);
      // 한쪽이 삭제된 충돌은 그 쪽 stage가 없어 빈 문자열이 온다
      if (
        (conflict?.kind === "deletedByUs" && side === "ours") ||
        (conflict?.kind === "deletedByThem" && side === "theirs") ||
        (conflict?.kind === "bothAdded" && side === "base")
      ) {
        return "";
      }
      // 세 쪽이 서로 다르게 보이도록 앞부분에 쪽 이름을 넣는다
      const body = mockFileContent(file).split("\n").slice(0, 60).join("\n");
      return `// ${side} version of ${file}\n${body}\n`;
    }

    case "get_ref_snapshot":
      await sleep(30);
      return mockRefSnapshot();

    case "list_remotes":
      await sleep(35);
      return remoteStore.map((remote) => ({ ...remote }));

    case "list_worktrees":
      await sleep(35);
      return worktreeStore.map((tree) => ({ ...tree }));

    case "get_rebase_steps": {
      // 실제 Rust는 `git rev-list --reverse --first-parent base..HEAD`에 가깝다. 목업은 이미 만든
      // 그래프에서 HEAD부터 첫 부모를 따라가며 base를 찾는다. 다른 브랜치 커밋은 섞이지 않는다
      await sleep(REBASE_STEPS_DELAY_MS > 0 ? REBASE_STEPS_DELAY_MS : SLOW_WRITES ? WRITE_DELAY_MS : 120);
      const base = String(readArg(payload, "base") ?? "");
      if (REBASE_STEPS_ERR) {
        throw `${base.slice(0, 7)} is not an ancestor of HEAD, so there is nothing to rebase onto it.`;
      }
      return mockRebaseSteps(base);
    }

    case "get_last_commit_message":
      await sleep(30);
      return "feat(graph): 레인 색 재활용과 통과선 계산을 분리\n\n레인이 종료될 때 색을 한 행 뒤에 반납한다.";

    case "get_commit_template":
      await sleep(20);
      return COMMIT_TEMPLATE;

    case "get_commit_details": {
      await sleep(90);
      return mockDetails(String(readArg(payload, "sha") ?? ""));
    }

    case "get_file_diff": {
      await sleep(90);
      const file = String(readArg(payload, "file") ?? "");
      const oldFileArg = readArg(payload, "oldFile");
      const oldFile = typeof oldFileArg === "string" ? oldFileArg : null;
      return mockDiff(file, oldFile);
    }

    // ── v0.18 파일 히스토리, blame, 비교 ──────────────────
    case "get_file_history": {
      await sleep(140);
      const file = String(readArg(payload, "file") ?? "");
      const revArg = readArg(payload, "rev");
      const limit = Number(readArg(payload, "limit") ?? 1000);
      return mockFileHistory(file, typeof revArg === "string" ? revArg : null, limit);
    }

    case "get_blame": {
      await sleep(180);
      const file = String(readArg(payload, "file") ?? "");
      const revArg = readArg(payload, "rev");
      return mockBlame(file, typeof revArg === "string" ? revArg : null);
    }

    case "compare_refs": {
      await sleep(160);
      const base = String(readArg(payload, "base") ?? "");
      const head = String(readArg(payload, "head") ?? "");
      const limit = Number(readArg(payload, "limit") ?? 1000);
      return mockCompare(base, head, limit);
    }

    case "get_compare_file_diff": {
      await sleep(90);
      const file = String(readArg(payload, "file") ?? "");
      const oldFileArg = readArg(payload, "oldFile");
      return mockDiff(file, typeof oldFileArg === "string" ? oldFileArg : null);
    }

    // ── v0.19 서브모듈 ──────────────────────────────────
    case "get_submodules":
      await sleep(60);
      return mockSubmodules(String(readArg(payload, "path") ?? ""));

    case "get_submodule_change": {
      await sleep(120);
      const subPath = String(readArg(payload, "subPath") ?? "");
      const source = readArg(payload, "source") as SubmoduleChangeSource;
      const limit = Number(readArg(payload, "limit") ?? 200);
      return mockSubmoduleChange(subPath, source, limit);
    }

    // plugin-dialog의 open()은 이 command로 내려온다
    case "plugin:dialog|open": {
      await sleep(150);
      const picked = MOCK_PICK_PATHS[pickCursor % MOCK_PICK_PATHS.length];
      pickCursor += 1;
      return picked;
    }

    case "get_wip_details":
      await sleep(70);
      return mockWipDetails();

    case "get_wip_file_diff": {
      await sleep(90);
      const file = String(readArg(payload, "file") ?? "");
      const area = String(readArg(payload, "area") ?? "unstaged");
      return { text: mockWipDiff(file, area), encoding: WIP_DIFF_ENCODING };
    }

    case "get_wip_file_content": {
      await sleep(100);
      const file = String(readArg(payload, "file") ?? "");
      if (file === BINARY_FILE) {
        throw new Error("binary");
      }
      return mockFileContent(file);
    }

    case "get_file_content": {
      await sleep(110);
      const file = String(readArg(payload, "file") ?? "");
      if (file === BINARY_FILE) {
        throw new Error("binary");
      }
      return mockFileContent(file);
    }

    // 내장 터미널(v0.16). 하네스에는 PTY가 없어 세션 id만 흉내낸다.
    // Terminal 컴포넌트는 term:data 이벤트가 오지 않으면 "앱에서만 동작"을 표시한다
    case "term_open":
      console.log("[mock] term_open:", readArg(payload, "path"));
      return "mock";

    case "term_write":
    case "term_resize":
    case "term_close":
      return null;

    // v0.11 새 command. 하네스에는 OS 연동이 없으므로 로그만 남긴다
    case "reveal_path":
      console.log("[mock] reveal_path:", readArg(payload, "path"));
      return null;

    case "open_in_terminal":
      console.log("[mock] open_in_terminal:", readArg(payload, "path"));
      return null;

    case "set_recent_repos":
      console.log("[mock] set_recent_repos:", readArg(payload, "paths"));
      return null;

    // 웹뷰 줌. 하네스에는 네이티브 웹뷰가 없어 값만 찍고 넘어간다
    case "plugin:webview|set_webview_zoom":
      console.log("[mock] setZoom:", readArg(payload, "value"));
      return null;

    // plugin-opener의 openUrl(). 하네스에서는 실제로 열지 않고 로그만 남긴다
    case "plugin:opener|open_url":
      console.log("[mock] openUrl:", readArg(payload, "url"));
      return null;

    // plugin:event|listen은 일부러 처리하지 않는다.
    // 하네스에는 네이티브 메뉴가 없으므로, 구독 실패를 신호로 App이 ⌘T/⌘R keydown 폴백을 켠다
    default:
      throw new Error(`mock IPC: 처리하지 않는 command "${cmd}"`);
  }
});

createRoot(document.getElementById("root") as HTMLElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
