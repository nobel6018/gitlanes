// BRANCH / TAG 컬럼의 ref pill. GitKraken처럼 그래프 밖 왼쪽 컬럼에 놓는다.
import type { RefInfo } from "../types";
import { measureText } from "./text";

interface RefPillsProps {
  refs: RefInfo[];
  /** 이 행의 레인 색. localBranch/remoteBranch pill 테두리에 쓴다 */
  laneColor: string;
  showTags: boolean;
  /** BRANCH 컬럼의 현재 폭. 리사이즈되므로 상수가 아니다 */
  branchWidth: number;
}

/** pill 정렬: HEAD → 로컬 → 원격 → 태그 */
const KIND_ORDER: Record<RefInfo["kind"], number> = {
  localBranch: 0,
  remoteBranch: 1,
  tag: 2,
};

// graph.css의 .gl-pill과 맞춘 값들. 여기가 어긋나면 "+N" 판정이 틀어진다
const UI_FONT = '-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif';
const PILL_FONT = `400 11px ${UI_FONT}`;
const PILL_FONT_HEAD = `700 11px ${UI_FONT}`;
const MORE_FONT = `400 10px ${UI_FONT}`;
/** .gl-pill의 padding 5+5 + border 1+1 */
const PILL_CHROME = 12;
/** .gl-pill의 gap */
const PILL_GAP = 2;
/** .gl-pill-icon */
const ICON_WIDTH = 9;
/** .gl-pill-check */
const CHECK_WIDTH = 8;
/** .gl-cell-branch의 gap */
const CELL_GAP = 3;
/** .gl-cell의 좌우 padding 8+8 */
const CELL_PADDING = 16;

function pillWidth(ref: RefInfo): number {
  const font = ref.isHead ? PILL_FONT_HEAD : PILL_FONT;
  let width = PILL_CHROME + measureText(ref.name, font);
  // 모든 pill은 종류 아이콘(branch/cloud/tag)을 하나씩 앞에 단다
  width += ICON_WIDTH + PILL_GAP;
  if (ref.isHead) {
    // 현재 브랜치는 앞의 체크 + 뒤의 모니터(체크아웃) 아이콘까지
    width += CHECK_WIDTH + PILL_GAP + ICON_WIDTH + PILL_GAP;
  }
  return width;
}

/** 표시 순서대로 정렬하고 showTags에 따라 태그를 걸러낸다 */
export function sortedVisibleRefs(refs: RefInfo[], showTags: boolean): RefInfo[] {
  const visible = showTags ? refs : refs.filter((ref) => ref.kind !== "tag");
  return visible.slice().sort((a, b) => {
    if (a.isHead !== b.isHead) {
      return a.isHead ? -1 : 1;
    }
    if (a.kind !== b.kind) {
      return KIND_ORDER[a.kind] - KIND_ORDER[b.kind];
    }
    return a.name.localeCompare(b.name);
  });
}

/** BRANCH/TAG 셀 툴팁. "+N"으로 숨은 ref까지 한 줄에 하나씩 */
export function refsTitle(refs: RefInfo[], showTags: boolean): string | undefined {
  const visible = sortedVisibleRefs(refs, showTags);
  if (visible.length === 0) {
    return undefined;
  }
  return visible.map((ref) => ref.name).join("\n");
}

function BranchIcon() {
  return (
    <svg className="gl-pill-icon" viewBox="0 0 16 16" aria-hidden="true">
      <circle cx="4.5" cy="4" r="1.7" fill="none" stroke="currentColor" strokeWidth="1.4" />
      <circle cx="4.5" cy="12" r="1.7" fill="none" stroke="currentColor" strokeWidth="1.4" />
      <circle cx="11.5" cy="5.5" r="1.7" fill="none" stroke="currentColor" strokeWidth="1.4" />
      <path
        d="M4.5 5.7v4.6M4.5 10.3c0-3 7-1.4 7-3.1"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
    </svg>
  );
}

/** 현재 브랜치가 이 워킹트리에 체크아웃돼 있음을 나타내는 모니터 아이콘 */
function MonitorIcon() {
  return (
    <svg className="gl-pill-icon" viewBox="0 0 16 16" aria-hidden="true">
      <rect x="2" y="3" width="12" height="8" rx="1" fill="none" stroke="currentColor" strokeWidth="1.4" />
      <path d="M6 14h4M8 11v3" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
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

export function RefPills({ refs, laneColor, showTags, branchWidth }: RefPillsProps) {
  const sorted = sortedVisibleRefs(refs, showTags);
  if (sorted.length === 0) {
    return null;
  }

  const available = branchWidth - CELL_PADDING;
  const widths = sorted.map(pillWidth);
  const total = widths.reduce((sum, width) => sum + width + CELL_GAP, -CELL_GAP);

  const shown: RefInfo[] = [];
  if (total <= available) {
    shown.push(...sorted);
  } else {
    // "+N" 배지 자리를 먼저 뺀다. N은 담아봐야 알므로 최댓값 기준으로 폭을 잡는다
    const badge = PILL_CHROME + measureText(`+${sorted.length}`, MORE_FONT) + CELL_GAP;
    const budget = available - badge;
    let used = 0;
    for (let i = 0; i < sorted.length; i++) {
      const next = used + widths[i] + (shown.length > 0 ? CELL_GAP : 0);
      if (shown.length > 0 && next > budget) {
        break;
      }
      shown.push(sorted[i]);
      used = next;
    }
  }
  const hidden = sorted.length - shown.length;

  return (
    <>
      {shown.map((ref) => {
        // 현재 브랜치는 레인 색을 옅게 채워 다른 pill보다 도드라지게 한다
        const style =
          ref.kind === "tag"
            ? undefined
            : ref.isHead
              ? {
                  borderColor: laneColor,
                  background: `color-mix(in srgb, ${laneColor} 20%, var(--bg-panel))`,
                }
              : { borderColor: laneColor };
        return (
          <span
            key={`${ref.kind}:${ref.name}`}
            className={`gl-pill gl-pill-${ref.kind}${ref.isHead ? " gl-pill-head" : ""}`}
            style={style}
          >
            {ref.isHead ? <CheckIcon /> : null}
            {!ref.isHead && ref.kind === "localBranch" ? <BranchIcon /> : null}
            {ref.kind === "remoteBranch" ? <CloudIcon /> : null}
            {ref.kind === "tag" ? <TagIcon /> : null}
            <span className="gl-pill-name">{ref.name}</span>
            {ref.isHead ? <MonitorIcon /> : null}
          </span>
        );
      })}
      {hidden > 0 ? <span className="gl-pill gl-pill-more">{`+${hidden}`}</span> : null}
    </>
  );
}
