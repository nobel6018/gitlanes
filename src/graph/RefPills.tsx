// BRANCH / TAG 컬럼의 ref pill. GitKraken처럼 그래프 밖 왼쪽 컬럼에 놓는다.
import type { RefInfo } from "../types";
import { BRANCH_COL_WIDTH } from "./layout";

interface RefPillsProps {
  refs: RefInfo[];
  /** 이 행의 레인 색. localBranch/remoteBranch pill 테두리에 쓴다 */
  laneColor: string;
  showTags: boolean;
}

/** pill 정렬: HEAD → 로컬 → 원격 → 태그 */
const KIND_ORDER: Record<RefInfo["kind"], number> = {
  localBranch: 0,
  remoteBranch: 1,
  tag: 2,
};

const PILL_PADDING = 14;
const CHAR_WIDTH = 6.1;
const ICON_WIDTH = 12;
const HEAD_MARK_WIDTH = 11;
const OVERFLOW_BADGE_WIDTH = 26;
const AVAILABLE = BRANCH_COL_WIDTH - 16;

function estimateWidth(ref: RefInfo): number {
  const icon = ref.kind === "localBranch" ? 0 : ICON_WIDTH;
  const head = ref.isHead ? HEAD_MARK_WIDTH : 0;
  return PILL_PADDING + icon + head + ref.name.length * CHAR_WIDTH + 3;
}

function CloudIcon() {
  return (
    <svg className="gl-pill-icon" viewBox="0 0 16 16" aria-hidden="true">
      <path
        d="M4.2 12.5h7.3a2.8 2.8 0 0 0 .3-5.6A3.9 3.9 0 0 0 4.4 5.9 2.9 2.9 0 0 0 4.2 12.5Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function TagIcon() {
  return (
    <svg className="gl-pill-icon" viewBox="0 0 16 16" aria-hidden="true">
      <path
        d="M8.4 2H14v5.6L7.6 14 2 8.4 8.4 2Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinejoin="round"
      />
      <circle cx="11.2" cy="4.8" r="1.1" fill="currentColor" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg className="gl-pill-icon gl-pill-check" viewBox="0 0 16 16" aria-hidden="true">
      <path
        d="M3 8.6 6.2 12 13 4.6"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function RefPills({ refs, laneColor, showTags }: RefPillsProps) {
  const visible = showTags ? refs : refs.filter((r) => r.kind !== "tag");
  if (visible.length === 0) {
    return null;
  }

  const sorted = [...visible].sort((a, b) => {
    if (a.isHead !== b.isHead) {
      return a.isHead ? -1 : 1;
    }
    if (a.kind !== b.kind) {
      return KIND_ORDER[a.kind] - KIND_ORDER[b.kind];
    }
    return a.name.localeCompare(b.name);
  });

  // 폭 실측 대신 글자 수로 추정한다. 매 행 measureText를 부르면 5만 행 스크롤에서 비싸다
  const total = sorted.reduce((sum, r) => sum + estimateWidth(r) + 3, 0);
  const budget = total > AVAILABLE ? AVAILABLE - OVERFLOW_BADGE_WIDTH : AVAILABLE;

  const shown: RefInfo[] = [];
  let used = 0;
  for (const ref of sorted) {
    const width = estimateWidth(ref) + 3;
    if (shown.length > 0 && used + width > budget) {
      break;
    }
    shown.push(ref);
    used += width;
  }
  const hidden = sorted.length - shown.length;

  return (
    <>
      {shown.map((ref) => (
        <span
          key={`${ref.kind}:${ref.name}`}
          className={`gl-pill gl-pill-${ref.kind}${ref.isHead ? " gl-pill-head" : ""}`}
          style={ref.kind === "tag" ? undefined : { borderColor: laneColor }}
          title={ref.name}
        >
          {ref.kind === "remoteBranch" ? <CloudIcon /> : null}
          {ref.kind === "tag" ? <TagIcon /> : null}
          <span className="gl-pill-name">{ref.name}</span>
          {ref.isHead ? <CheckIcon /> : null}
        </span>
      ))}
      {hidden > 0 ? <span className="gl-pill gl-pill-more">{`+${hidden}`}</span> : null}
    </>
  );
}
