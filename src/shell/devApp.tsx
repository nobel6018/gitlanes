// 검증용 하네스 엔트리 — Tauri 런타임 없이 App 전체를 mock IPC 위에서 렌더링한다.
// 앱 코드는 건드리지 않고 IPC 경계만 가로챈다. 배포 번들과 무관(dev-app.html 전용).
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { mockIPC } from "@tauri-apps/api/mocks";
import App from "../App";
import { makeMockGraph } from "../graph";
import type { CommitDetails, FileChange, GraphData, RepoInfo } from "../types";
import "../theme.css";

const MOCK_PATH = "/mock/awesome-project";
const MOCK_PICK_PATH = "/mock/picked-from-dialog";
/** 전체 커밋 수. limit이 이 값보다 작으면 hasMore가 켜진다. */
const TOTAL_COMMITS = 12340;

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

function mockGraph(limit: number): GraphData {
  const cached = graphCache.get(limit);
  if (cached !== undefined) {
    return cached;
  }
  const count = Math.min(limit, TOTAL_COMMITS);
  const base = makeMockGraph(count);
  const data: GraphData = {
    ...base,
    totalLoaded: base.rows.length,
    hasMore: count < TOTAL_COMMITS,
  };
  graphCache.set(limit, data);
  return data;
}

function mockFiles(seed: number): FileChange[] {
  return [
    { path: "src/shell/Toolbar.tsx", oldPath: null, status: "M", additions: 24 + (seed % 13), deletions: 6 },
    { path: "src/shell/CommitDetailPanel.tsx", oldPath: null, status: "M", additions: 118, deletions: 41 },
    { path: "src/shell/DiffView.tsx", oldPath: null, status: "A", additions: 63, deletions: 0 },
    { path: "src/graph/lane-layout.ts", oldPath: "src/graph/layout.ts", status: "R", additions: 9, deletions: 4 },
    { path: "src/legacy/OldGraph.tsx", oldPath: null, status: "D", additions: 0, deletions: 212 },
    { path: "docs/graph-rendering.md", oldPath: null, status: "A", additions: 47, deletions: 0 },
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

function mockDiff(file: string, oldFile: string | null): string {
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

mockIPC(async (cmd, payload) => {
  switch (cmd) {
    case "get_startup_repo":
      await sleep(60);
      return MOCK_PATH;

    case "open_repo": {
      await sleep(120);
      const path = String(readArg(payload, "path") ?? MOCK_PATH);
      return { ...REPO, path, name: path.split("/").filter(Boolean).pop() ?? REPO.name };
    }

    case "load_graph": {
      await sleep(220);
      const limit = Number(readArg(payload, "limit") ?? 0);
      return mockGraph(limit);
    }

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
    case "plugin:dialog|open":
      await sleep(150);
      return MOCK_PICK_PATH;

    default:
      throw new Error(`mock IPC: 처리하지 않는 command "${cmd}"`);
  }
});

createRoot(document.getElementById("root") as HTMLElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
