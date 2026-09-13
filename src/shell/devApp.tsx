// 검증용 하네스 엔트리 — Tauri 런타임 없이 App 전체를 mock IPC 위에서 렌더링한다.
// 앱 코드는 건드리지 않고 IPC 경계만 가로챈다. 배포 번들과 무관(dev-app.html 전용).
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { mockIPC } from "@tauri-apps/api/mocks";
import App from "../App";
import { makeMockGraph } from "../graph";
import type {
  CommitDetails,
  CommitRow,
  ConflictFile,
  FileChange,
  GraphData,
  OpResult,
  PendingOp,
  RefEntry,
  RemoteInfo,
  RepoInfo,
  RepoState,
  SearchMatch,
  StashInfo,
  SyncState,
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
 * 쓰기가 일어날 때마다 오르는 값. 토큰에 섞어 그래프가 실제로 다시 로드되게 한다.
 * (폴링은 지문이 바뀌어야만 리로드한다)
 */
let writeSalt = 0;

/** refs 지문. 30초 전후로 한 번, 그리고 쓰기마다 바뀐다 */
function currentToken(): string {
  return `mock-graph-token-v${flipped() ? 2 : 1}-${writeSalt}`;
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
  return { changedFiles: paths.size, stagedFiles: wipStore.staged.length };
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
    "+export const WIP_MARKER = true;",
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
  const rows = mockGraph(TOTAL_COMMITS, 0).rows;
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
    files: mockFiles(seed),
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
//   ?slow=1           쓰기마다 1.2초 지연 (스피너/중복 클릭 방지 검증)
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
const SLOW_WRITES = PARAMS.get("slow") === "1";

/** 진행 중인 머지/리베이스. ?conflict=1이면 처음부터 켜져 있다 */
let pendingOp: PendingOp | null =
  PARAMS.get("conflict") === "1"
    ? {
        kind: "merge",
        progress: null,
        conflictCount: 3,
        detail: "origin/develop into main",
      }
    : null;

const CONFLICT_FILES: ConflictFile[] = [
  { path: "src/shell/RepoWorkspace.tsx", kind: "bothModified", hasMarkers: true },
  { path: "src/types.ts", kind: "bothModified", hasMarkers: true },
  { path: "src/legacy/OldGraph.tsx", kind: "deletedByUs", hasMarkers: false },
];

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

const AUTH_STDERR = [
  "git@github.com: Permission denied (publickey).",
  "fatal: Could not read from remote repository.",
  "",
  "Please make sure you have the correct access rights",
  "and the repository exists.",
].join("\n");

function ok(command: string[], stdout = ""): OpResult {
  writeSalt += 1;
  return { ok: true, stdout, stderr: "", conflicts: [], command, needsAuth: false };
}

function fail(command: string[], stderr: string, conflicts: string[] = []): OpResult {
  return {
    ok: false,
    stdout: "",
    stderr: FORCE_AUTH ? AUTH_STDERR : stderr,
    conflicts,
    command,
    needsAuth: FORCE_AUTH,
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
      const command = ["restore", "--", ...files];
      if (shouldFail(cmd)) {
        return fail(command, "error: unable to discard");
      }
      removeFiles(wipStore.unstaged, files);
      removeFiles(wipStore.untracked, files);
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
      console.log("[mock] git_apply_patch", { cached, reverse });
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
        // 풀 충돌은 진행 중 상태를 남긴다. 충돌 배너/패널 경로를 이걸로 검증한다
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
      const flag = kind === "merge" ? "merge" : kind === "revert" ? "revert" : kind === "cherryPick" ? "cherry-pick" : "rebase";
      const command = [flag, `--${action}`];
      if (shouldFail(cmd)) {
        return fail(command, `fatal: no ${flag} in progress`);
      }
      if (action === "abort" || action === "continue") {
        pendingOp = null;
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
      const stashRef = strArg(payload, "ref");
      const drop = boolArg(payload, "drop");
      const command = ["stash", drop ? "pop" : "apply", stashRef];
      if (shouldFail(cmd)) {
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
      const command = ["stash", "drop", strArg(payload, "ref")];
      if (shouldFail(cmd)) {
        return fail(command, "error: could not drop stash entry");
      }
      stashCount = Math.max(0, stashCount - 1);
      writeSalt += 1;
      return ok(command);
    }

    case "git_stash_branch": {
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

/** 충돌 파일 하나를 해결 처리한다. 전부 해결되면 continue를 누를 수 있는 상태가 된다 */
function resolveConflict(file: string): void {
  const entry = CONFLICT_FILES.find((conflict) => conflict.path === file);
  if (entry !== undefined) {
    entry.hasMarkers = false;
  }
  if (pendingOp !== null) {
    const left = CONFLICT_FILES.filter((conflict) => conflict.hasMarkers).length;
    pendingOp = { ...pendingOp, conflictCount: left };
  }
  writeSalt += 1;
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

if (FAIL_SET.size > 0 || FORCE_AUTH || pendingOp !== null || SLOW_WRITES) {
  console.log("[mock] 쓰기 시나리오:", {
    fail: [...FAIL_SET],
    auth: FORCE_AUTH,
    conflict: pendingOp !== null,
    slow: SLOW_WRITES,
  });
}

installForcedUpdate();

mockIPC(async (cmd, payload) => {
  // 쓰기 command는 한곳에서 처리한다. 모르는 이름이면 null이 와서 아래 switch로 흐른다
  if (cmd.startsWith("git_")) {
    await sleep(SLOW_WRITES ? 1200 : 140);
    const result = handleWrite(cmd, payload);
    if (result !== null) {
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
      return pendingOp === null ? [] : CONFLICT_FILES.map((file) => ({ ...file }));

    case "get_conflict_side": {
      await sleep(50);
      const side = String(readArg(payload, "side") ?? "ours");
      const file = String(readArg(payload, "file") ?? "");
      if (side === "base" && file === CONFLICT_FILES[2].path) {
        // 한쪽이 삭제된 충돌은 빈 문자열이 온다
        return "";
      }
      return mockFileContent(file).split("\n").slice(0, 60).join("\n") + `\n// --- ${side} ---\n`;
    }

    case "list_remotes":
      await sleep(35);
      return remoteStore.map((remote) => ({ ...remote }));

    case "list_worktrees":
      await sleep(35);
      return worktreeStore.map((tree) => ({ ...tree }));

    case "get_last_commit_message":
      await sleep(30);
      return "feat(graph): 레인 색 재활용과 통과선 계산을 분리\n\n레인이 종료될 때 색을 한 행 뒤에 반납한다.";

    case "get_commit_template":
      await sleep(20);
      return null;

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
      return mockWipDiff(file, area);
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
