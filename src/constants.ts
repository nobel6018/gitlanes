// ============================================================
// FROZEN CONTRACT — 이 파일은 감독(main session)만 수정한다.
// ============================================================

/** 레인(브랜치 줄기) 색상. CommitRow.color / Edge.color가 이 배열의 인덱스.
 *  OKLCH 명도 76%, 채도 0.125(파랑만 0.11, sRGB 범위 안)로 맞춘 뒤 hex로 변환했다.
 *  canvas와 rgba 파싱(layout.ts)이 hex를 전제하므로 hex로 둔다.
 *  색상 순서(hue)는 이전 팔레트와 같다. @see docs/design-system.md */
export const LANE_COLORS = [
  "#47C0EF",
  "#F09866",
  "#69C88E",
  "#EF8EB5",
  "#99ADF7",
  "#CAB049",
  "#C49CF1",
  "#34CBB7",
  "#F6908D",
  "#9AC066",
] as const;

/** 커밋 행 높이(px). 그래프 캔버스와 텍스트 행이 공유한다.
 *  GitKraken과 나란히 비교해 26 → 30 (곡선이 급하게 꺾이지 않을 여유) */
export const ROW_HEIGHT = 30;

/** 레인 하나의 가로 폭(px) */
export const LANE_WIDTH = 18;

/** 커밋 점 반지름(px). ROW_HEIGHT 30 / LANE_WIDTH 18 기준으로 이전 비율(행 30%, 레인 간격 50%) 유지 */
export const DOT_RADIUS = 4.5;

/** 그래프 엣지 선 굵기(px) */
export const EDGE_WIDTH = 2;

/** 최초 로드 커밋 수. "더 보기"마다 이만큼 추가 요청 */
export const COMMITS_PER_PAGE = 5000;

/** localStorage key: 최근 연 레포 경로 배열(JSON string[]) */
export const RECENT_REPOS_KEY = "gitlanes.recents";

/** WIP(미커밋 변경) 의사 행을 선택했을 때 selectedSha에 들어가는 센티널 값 */
export const WIP_SHA = "__WIP__";
