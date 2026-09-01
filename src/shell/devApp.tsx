// 검증용 하네스 엔트리 — Tauri 런타임 없이 App 전체를 mock IPC 위에서 렌더링한다.
// 앱 코드는 건드리지 않고 IPC 경계만 가로챈다. 배포 번들과 무관(dev-app.html 전용).
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { mockIPC } from "@tauri-apps/api/mocks";
import App from "../App";
import { makeMockGraph } from "../graph";
import type {
  CommitDetails,
  FileChange,
  GraphData,
  RefEntry,
  RepoInfo,
  RepoState,
  SearchMatch,
  StashInfo,
  WipInfo,
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

/** refs 지문. 30초 전후로 한 번만 바뀌므로 자동 새로고침이 무한 반복하지 않는다 */
function currentToken(): string {
  return flipped() ? "mock-graph-token-v2" : "mock-graph-token-v1";
}

function currentWip(): WipInfo {
  return flipped() ? { changedFiles: 9, stagedFiles: 4 } : { changedFiles: 7, stagedFiles: 3 };
}
/** 이 파일을 열면 5,000줄짜리 diff가 와서 DiffView 가상 스크롤을 검증할 수 있다 */
const HUGE_DIFF_FILE = "src/generated/api-schema.ts";

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

/** limit까지 레이아웃을 만들어 캐시하고, rows는 [skip, limit) 구간만 잘라 돌려준다 */
function mockGraph(limit: number, skip: number): GraphData {
  const count = Math.min(limit, TOTAL_COMMITS);
  let base = graphCache.get(count);
  if (base === undefined) {
    base = makeMockGraph(count);
    graphCache.set(count, base);
  }
  return {
    ...base,
    rows: base.rows.slice(Math.max(0, skip)),
    // totalLoaded/hasMore/laneCount/wip/graphToken/stashes는 전체 기준
    totalLoaded: base.rows.length,
    hasMore: count < TOTAL_COMMITS,
    // 워킹 디렉토리가 더러운 상태 — GraphView가 HEAD 위에 WIP 행을 그린다
    wip: currentWip(),
    graphToken: currentToken(),
    stashes: mockStashes(base.rows),
  };
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

installForcedUpdate();

mockIPC(async (cmd, payload) => {
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

    // plugin-opener의 openUrl(). 하네스에서는 실제로 열지 않고 로그만 남긴다
    case "plugin:opener|open_url":
      console.log("[mock] openUrl:", readArg(payload, "url"));
      return null;

    default:
      throw new Error(`mock IPC: 처리하지 않는 command "${cmd}"`);
  }
});

createRoot(document.getElementById("root") as HTMLElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
