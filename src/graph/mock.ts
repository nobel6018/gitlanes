// 개발/시연용 합성 그래프. rust-core의 load_graph 응답을 대체한다.
// 계약의 edges 의미("row i와 row i+1 사이 구간의 모든 선분")를 그대로 지킨다.
import { LANE_COLORS } from "../constants";
import type { CommitRow, Edge, GraphData, RefInfo } from "../types";

/** mulberry32. 렌더마다 같은 그래프가 나오도록 시드를 고정한다 */
function makeRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const AUTHORS = [
  ["Younghoon Lee", "younghoon.lee@ilevit.com"],
  ["Jimin Park", "jimin.park@example.com"],
  ["Sora Kim", "sora.kim@example.com"],
  ["Daniel Choi", "daniel.choi@example.com"],
  ["Haeun Jung", "haeun.jung@example.com"],
  ["dependabot[bot]", "bot@users.noreply.github.com"],
];

const VERBS = ["feat", "fix", "refactor", "chore", "docs", "test", "perf"];
const SCOPES = ["graph", "canvas", "shell", "core", "lane", "diff", "ui", "ipc", "repo"];
const OBJECTS = [
  "레인 색 재활용 로직 정리",
  "가상 스크롤 오버스캔 조정",
  "머지 커밋 링 렌더링 수정",
  "커밋 상세 패널 레이아웃",
  "topo-order 파싱 예외 처리",
  "unified diff 하이라이트",
  "ref pill 넘침 처리",
  "devicePixelRatio 대응",
  "load_graph limit 처리",
  "빈 레포 열기 실패 수정",
];

const BRANCH_NAMES = [
  "feature/lane-colors",
  "feature/commit-detail",
  "fix/scroll-jank",
  "chore/deps",
  "refactor/graph-core",
  "release/0.2",
  "hotfix/open-repo",
  "experiment/webgl",
];

function hex(rand: () => number, length: number): string {
  let out = "";
  while (out.length < length) {
    out += Math.floor(rand() * 0x100000000)
      .toString(16)
      .padStart(8, "0");
  }
  return out.slice(0, length);
}

function firstFreeLane(lanes: (number | null)[]): number {
  for (let i = 0; i < lanes.length; i++) {
    if (lanes[i] === null) {
      return i;
    }
  }
  lanes.push(null);
  return lanes.length - 1;
}

/**
 * 브랜치 분기/머지/refs/태그가 섞인 합성 GraphData를 만든다.
 * 레인 상태를 위에서 아래로(최신 → 과거) 시뮬레이션하며, 브랜치 합류는
 * 직전 row의 통과선을 곡선으로 바꿔치기해 표현한다.
 */
export function makeMockGraph(rowCount: number): GraphData {
  const rand = makeRandom(0x9e3779b9);
  const rows: CommitRow[] = [];
  const lanes: (number | null)[] = [0];
  let nextColor = 1;
  let laneCount = 1;
  let timestamp = Math.floor(Date.now() / 1000);
  let lastCreatedLane = -1;
  let lastCreatedRow = -2;
  let tagMajor = 1;
  let tagMinor = 0;

  for (let i = 0; i < rowCount; i++) {
    const isLast = i === rowCount - 1;

    // 살아있는 레인 중 하나에 이번 커밋을 놓는다
    let occupied = lanes.reduce<number[]>((acc, color, index) => {
      if (color !== null) {
        acc.push(index);
      }
      return acc;
    }, []);
    if (occupied.length === 0) {
      lanes[0] = nextColor++ % LANE_COLORS.length;
      occupied = [0];
    }
    const pickSide = occupied.length > 1 && rand() < 0.35;
    const lane = pickSide
      ? occupied[1 + Math.floor(rand() * (occupied.length - 1))]
      : occupied[0];
    const color = lanes[lane] as number;

    // 합류: 다른 레인의 선이 이 커밋에서 끝난다. 직전 row의 해당 선분을 곡선으로 바꾼다.
    // 직전 row에서 갈라져 나온 레인은 제외한다(갈라졌다 바로 합쳐지는 지그재그 방지)
    const justCreated = lastCreatedRow === i - 1 ? lastCreatedLane : -1;
    const justForked = i > 0 && rows[i - 1].isMerge ? rows[i - 1].lane : -1;
    const mergeCandidates = occupied.filter(
      (k) => k !== lane && k !== justCreated && k !== justForked,
    );
    let absorbed: number | null = null;
    if (i > 0 && mergeCandidates.length > 0 && rand() < 0.22) {
      absorbed = mergeCandidates[mergeCandidates.length - 1];
      const prevEdges = rows[i - 1].edges;
      const incoming = prevEdges.find((e) => e.toLane === absorbed);
      if (incoming) {
        incoming.toLane = lane;
      } else {
        prevEdges.push({ fromLane: absorbed, toLane: lane, color: lanes[absorbed] as number });
      }
      lanes[absorbed] = null;
    }

    const edges: Edge[] = [];
    for (let k = 0; k < lanes.length; k++) {
      const laneColorIndex = lanes[k];
      if (k !== lane && laneColorIndex !== null) {
        edges.push({ fromLane: k, toLane: k, color: laneColorIndex });
      }
    }

    const parents: string[] = [];
    let isMerge = false;
    if (isLast) {
      // 마지막 row는 루트 커밋으로 닫는다. 남은 선들은 직전 구간에서 이 레인으로 모아줘야
      // 화면 아래로 잘려나가는 dangling 선이 생기지 않는다
      if (i > 0) {
        const seen = new Set<string>();
        rows[i - 1].edges = rows[i - 1].edges.filter((edge) => {
          edge.toLane = lane;
          const key = `${edge.fromLane}>${edge.toLane}`;
          if (seen.has(key)) {
            return false;
          }
          seen.add(key);
          return true;
        });
      }
      edges.length = 0;
      lanes.fill(null);
    } else {
      // 첫 번째 부모는 같은 레인을 계속 쓴다
      edges.push({ fromLane: lane, toLane: lane, color });
      parents.push(hex(rand, 40));
      // 머지 커밋: 두 번째 부모가 새 레인으로 갈라져 내려간다
      if (i < rowCount - 4 && rand() < 0.16) {
        const newLane = firstFreeLane(lanes);
        const newColor = nextColor++ % LANE_COLORS.length;
        lanes[newLane] = newColor;
        laneCount = Math.max(laneCount, newLane + 1);
        lastCreatedLane = newLane;
        lastCreatedRow = i;
        edges.push({ fromLane: lane, toLane: newLane, color: newColor });
        parents.push(hex(rand, 40));
        isMerge = true;
      }
    }

    const sha = hex(rand, 40);
    const author = AUTHORS[Math.floor(rand() * AUTHORS.length)];
    const subject = isMerge
      ? `Merge branch '${BRANCH_NAMES[Math.floor(rand() * BRANCH_NAMES.length)]}' into main`
      : `${VERBS[Math.floor(rand() * VERBS.length)]}(${SCOPES[Math.floor(rand() * SCOPES.length)]}): ${
          OBJECTS[Math.floor(rand() * OBJECTS.length)]
        }`;

    const refs: RefInfo[] = [];
    if (i === 0) {
      refs.push({ name: "main", kind: "localBranch", isHead: true });
      refs.push({ name: "origin/main", kind: "remoteBranch", isHead: false });
    } else if (i % 17 === 3) {
      const name = BRANCH_NAMES[Math.floor(rand() * BRANCH_NAMES.length)];
      refs.push({ name, kind: "localBranch", isHead: false });
      if (rand() < 0.7) {
        refs.push({ name: `origin/${name}`, kind: "remoteBranch", isHead: false });
      }
    } else if (i % 23 === 11) {
      refs.push({
        name: `origin/${BRANCH_NAMES[Math.floor(rand() * BRANCH_NAMES.length)]}`,
        kind: "remoteBranch",
        isHead: false,
      });
    }
    if (i > 0 && i % 40 === 0) {
      refs.push({ name: `v${tagMajor}.${tagMinor}.0`, kind: "tag", isHead: false });
      tagMinor += 1;
      if (tagMinor > 9) {
        tagMajor += 1;
        tagMinor = 0;
      }
    }

    rows.push({
      sha,
      shortSha: sha.slice(0, 10),
      subject,
      author: author[0],
      authorEmail: author[1],
      timestamp,
      parents,
      lane,
      color,
      isHead: i === 0,
      isMerge,
      refs,
      edges,
    });

    laneCount = Math.max(laneCount, lane + 1);
    timestamp -= 600 + Math.floor(rand() * 9000);
  }

  return {
    rows,
    totalLoaded: rows.length,
    hasMore: false,
    laneCount,
    // 결정적 규칙: 행 수가 홀수면 워킹 디렉토리가 더러운 상태로 본다
    wip:
      rowCount % 2 === 1
        ? { changedFiles: 3 + (rowCount % 7), stagedFiles: rowCount % 4 }
        : null,
  };
}
