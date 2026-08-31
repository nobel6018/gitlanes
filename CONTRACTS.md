# GitLanes 접점 계약

> 병렬 개발 패키지 간 인터페이스 계약. 이 문서와 `src/types.ts`, `src/constants.ts`는 동결(frozen)이며 감독만 수정한다.

## 패키지와 소유권

| 패키지 | 소유 파일/디렉토리 | 완료 기준 |
|---|---|---|
| rust-core | `src-tauri/**` 전체 | `cargo test` + `cargo check` 통과 |
| ui-graph | `src/graph/**` | `npm run build` 통과 |
| ui-shell | `src/App.tsx`, `src/main.tsx`, `src/shell/**`, `src/theme.css`, `index.html` | `npm run build` 통과 |

- 동결 파일(누구도 수정 금지): `src/types.ts`, `src/constants.ts`, `package.json`, `package-lock.json`, `CONTRACTS.md`
- 새 npm 의존성이 필요하면 설치하지 말고 보고만 한다. 현재 설치된 것: react 19, @tauri-apps/api v2, @tauri-apps/plugin-opener, @tauri-apps/plugin-dialog, typescript, vite

## Tauri Commands (rust-core 구현, ui-shell 호출)

인자 이름은 JS에서 camelCase로 전달된다 (Tauri 2 기본 변환).

```
open_repo(path: string) -> RepoInfo            // 실패 시 Err(String): 사람이 읽을 한국어/영어 오류 메시지
load_graph(path: string, limit: number) -> GraphData
get_commit_details(path: string, sha: string) -> CommitDetails
get_file_diff(path: string, sha: string, file: string, oldFile: string | null) -> string
    // unified diff 원문. oldFile은 rename/copy일 때 FileChange.oldPath 전달
get_startup_repo() -> string | null
    // CLI 첫 위치 인자 또는 GITLANES_REPO 환경변수. ui-shell이 마운트 시 자동 오픈에 사용
```

- 모든 응답 타입은 `src/types.ts`와 1:1 일치 (`#[serde(rename_all = "camelCase")]`)
- `load_graph`는 `git log --branches --remotes --tags HEAD --topo-order` 기준. limit개 초과 시 잘라내고 `hasMore: true`
- 레인 배치와 색상 배정(레인 종료 시 색 재활용)은 rust-core 책임. `CommitRow.edges`는 "해당 row와 다음 row 사이 구간의 모든 선분(통과 수직선 포함)"으로 계산해 내려준다. 프론트는 계산 없이 그리기만 한다
- dialog 플러그인은 rust-core가 `tauri-plugin-dialog`를 등록하고 capabilities에 `dialog:default`를 추가한다. ui-shell은 `@tauri-apps/plugin-dialog`의 `open({ directory: true })`를 그냥 호출하면 된다

## GraphView 컴포넌트 (ui-graph 구현, ui-shell 사용)

`src/graph/index.ts`가 다음을 export 한다.

```tsx
export interface GraphViewProps {
  data: GraphData;
  selectedSha: string | null;
  onSelect: (sha: string) => void;
  /** hasMore이고 스크롤이 바닥 근처면 호출 */
  onLoadMore: () => void;
  loading: boolean;
  showTags: boolean;
}
export function GraphView(props: GraphViewProps): JSX.Element;
```

- GraphView는 커밋 테이블 전체를 렌더링한다. 컬럼 구성(GitKraken과 동일):
  `BRANCH / TAG` | `GRAPH` | `MESSAGE` | `AUTHOR` | `SHA(short)` | `DATE`
- BRANCH/TAG 컬럼: refs pill을 그래프 밖 별도 컬럼에 표시 (GitKraken 방식). `showTags=false`면 tag pill 숨김
- GRAPH 컬럼: canvas에 곡선 엣지 + 커밋 점. 색은 `LANE_COLORS[color]`
- 행 높이 `ROW_HEIGHT` 고정, 가상 스크롤 필수 (5만 행에서 60fps 목표)
- 선택 행 하이라이트 배경: `var(--accent)`에 50% 투명
- 텍스트/배경 색은 아래 CSS 변수만 사용

## CSS 변수 (ui-shell이 src/theme.css에 정의, 모두가 참조)

```css
:root {
  --bg-window: #282A31;
  --bg-titlebar: #212327;
  --bg-toolbar: #2B2D34;
  --bg-content: #1C1E23;   /* 그래프/리스트 영역 */
  --bg-panel: #26282F;     /* 상세 패널, 팝업 */
  --border-0: #17181C;
  --border-1: #3A3D46;
  --fg-1: #D0D3D9;         /* 본문 */
  --fg-2: #93979F;         /* 보조(날짜, sha) */
  --accent: #3D6DA8;       /* 선택, 포커스 */
  --link: #6FA8E8;
  --added: #54C08A;
  --deleted: #DE7373;
  --modified: #D4B455;
}
```

폰트: 시스템 UI 폰트, sha/diff는 `ui-monospace, SF Mono, monospace`. 기본 13px.

## 앱 레이아웃 (ui-shell)

- 상단 툴바: 레포 이름 + 현재 브랜치, "Open Repository" 버튼, tag 표시 토글
- 미오픈 상태: 웰컴 화면 (Open 버튼 + 최근 레포 목록, `RECENT_REPOS_KEY` localStorage)
- 오픈 상태: 좌측(넓게) GraphView, 우측 커밋 상세 패널 (GitKraken 배치). 커밋 미선택 시 패널 숨김/빈 상태
- 상세 패널: subject/body, author/committer, parents(short sha), 파일 변경 목록(status 뱃지 + additions/deletions), 파일 클릭 시 unified diff 표시(get_file_diff)
- 오류는 토스트 또는 인라인 메시지로 표시 (open 실패 등)
