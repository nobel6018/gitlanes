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
list_refs(path: string) -> RefEntry[]
    // 사이드바용 전체 refs. 로드된 커밋 범위와 무관하게 모든 브랜치/태그
```

## v0.3 확장 (skip 페이징, 스태시, diff 가상화)

- `load_graph(path, limit, skip)`: 레이아웃은 항상 처음부터 limit까지 계산하되 **rows는 [skip, limit) 구간만 직렬화**해 반환한다. totalLoaded/hasMore/laneCount/wip/graphToken/stashes는 전체 기준. skip=0이 전체 로드
- 프론트 페이징 흐름: 더 보기 시 `skip=현재 rows 길이, limit=skip+COMMITS_PER_PAGE`로 호출해 **append**. 응답의 graphToken이 보관값과 다르면 append하지 않고 skip=0 전체 리로드
- `GraphData.stashes`: rust-core가 `git stash list`에서 채움 (없으면 빈 배열)
- GraphView 스태시 렌더: baseSha 행 **바로 위**에 의사 행 삽입 (WIP와 같은 display-index 방식, 삽입이 여러 개일 수 있으니 일반화). GRAPH에는 base 레인 위치에 점선 다이아몬드(또는 대시 링) + base 점까지 점선 엣지, MESSAGE는 fg-2 이탤릭 `≡ <message>`, SHA/DATE 표시. **클릭 가능**: onSelect(stash.sha) → 상세 패널이 기존 get_commit_details로 동작. baseSha가 로드 범위 밖이면 그 스태시는 표시하지 않음. WIP와 같은 커밋 위에 겹치면 WIP가 더 위
- DiffView(ui-shell): 줄 수 1,000 초과 diff는 가상 스크롤로 렌더 (고정 줄 높이, 보이는 범위 ±30줄만 DOM)

## v0.5 확장 (전체 검색, 자동 새로고침, 컬럼 리사이즈)

```
search_commits(path: string, query: string, limit: number) -> SearchMatch[]
    // subject/author명/sha prefix 대소문자 무시 부분일치. topo 순서 index 포함, 최대 500개
get_repo_state(path: string) -> RepoState
    // refs 지문 + wip 요약만 계산하는 경량 폴링용 (log 파싱 없음)
```

- 검색 흐름(ui-shell): 로컬 rows 매치는 기존대로 즉시. Enter로 마지막 로컬 매치를 넘어가는데 hasMore면 `search_commits` 호출 → 다음 매치의 index를 받아 limit을 index+1 이상으로 append 확장 후 점프. 전체에도 없으면 카운터를 "N/N (전체)"로 표시
- 자동 새로고침(ui-shell): 창이 포커스/가시 상태일 때만 5초마다 `get_repo_state` 폴링. graphToken 또는 wip이 보관값과 다르면 load_graph(skip=0, 현재 깊이 유지) + list_refs 재로드. 로딩 중에는 폴링 스킵
- 컬럼 리사이즈(ui-graph): 헤더 경계 드래그로 BRANCH/AUTHOR/SHA/DATE 폭 조절(MESSAGE는 flex 유지), 최소 폭 60px, localStorage `gitlanes.columns`에 저장, 더블클릭으로 기본값 복원
- 색 배정(rust-core): 새 레인에 색을 줄 때 좌우 인접 활성 레인의 색과 겹치지 않는 후보를 우선 선택 (풀이 바닥나면 기존 규칙대로). Edge.color/CommitRow.color 의미는 불변
- `GraphViewProps`에 옵션 prop 추가: `onRowDoubleClick?: (sha: string) => void` — 커밋/스태시 행 더블클릭 시 호출 (의사 행 WIP 제외). ui-shell은 이걸로 sha 복사를 연결

## v0.7 확장 (레포 탭, 경로 강조, 컨텍스트 메뉴)

```
get_remote_url(path: string) -> string | null
    // origin remote의 웹 URL로 정규화: git@github.com:a/b.git → https://github.com/a/b
    // https URL은 .git 접미사만 제거. origin이 없으면 첫 remote, 그것도 없으면 null
```

- `GraphViewProps`에 옵션 prop 추가:
  ```ts
  /** 커밋/스태시 행 우클릭. 브라우저 기본 메뉴는 GraphView가 preventDefault */
  onRowContextMenu?: (sha: string, clientX: number, clientY: number) => void;
  ```
- 경로 강조(ui-graph 내부): selectedSha가 있으면 그 커밋의 조상 전체(부모 재귀)와 자손 전체(자식 역추적)를 계산해, 집합 밖의 행 텍스트/점/엣지를 35% 불투명도로 dim. 선택 해제 시 원상복구. 계산은 rows의 parents로 클라이언트에서 (로드 범위 내 한정)
- **Edge 링크 귀속(v0.7에서 추가)**: `Edge`에 `childRow`/`parentRow`(전역 topo 행 인덱스, 부모 미로드 시 -1)가 실린다. rust-core가 레인 상태에서 각 선분의 소속 링크를 기록해 채운다. 엣지 강조 판정은 `childRow ∈ 집합 && (parentRow === -1 ? childRow ∈ 집합 : parentRow ∈ 집합)` — band 양끝 행 기준 판정은 폐기
- 알려진 한계: append 확장 후 이전 페이지 행들의 `parentRow: -1`은 갱신되지 않는다 (경계를 넘는 링크의 강조가 자식 기준으로만 판정됨). 시각적 오차가 작고, 자동 새로고침의 skip=0 전체 리로드에서 자연히 해소된다
- 레포 탭(ui-shell): 툴바 위에 GitKraken식 탭 바. 탭마다 독립된 레포/그래프/선택/검색 상태, + 버튼으로 새 탭(웰컴 화면), 탭 close, 마지막 탭 close는 웰컴으로. 자동 새로고침 폴링은 활성 탭만. localStorage `gitlanes.tabs`에 열린 레포 경로와 활성 인덱스 저장, 시작 시 복원 (startup repo 인자가 있으면 그걸 새 탭으로)
- 컨텍스트 메뉴(ui-shell): 항목 = Copy sha, Copy message, Open on GitHub/Remote(get_remote_url 있을 때만, `<url>/commit/<sha>` 새 브라우저 — @tauri-apps/plugin-opener), 클릭 밖/Esc로 닫힘

## v0.10 확장 (네이티브 메뉴 단축키, Open Repository 버튼 제거)

- rust-core가 Tauri 네이티브 앱 메뉴를 커스터마이즈한다. File 메뉴에 다음 항목을 넣고, 각 항목은 웹뷰 전역 이벤트를 emit한다 (macOS는 Cmd, Windows/Linux는 Ctrl — `CmdOrCtrl` accelerator):
  | 메뉴 항목 | 단축키 | emit 이벤트 |
  |---|---|---|
  | New Tab | CmdOrCtrl+T | `menu:new-tab` |
  | Open Repository… | CmdOrCtrl+O | `menu:open-repo` |
  | Close Tab | CmdOrCtrl+W | `menu:close-tab` |
  | Refresh | CmdOrCtrl+R | `menu:refresh` |
  - macOS 기본 Close Window(⌘W 선점)는 ⇧⌘W로 옮기고, 나머지 기본 메뉴(App/Edit(복사·붙여넣기 유지)/Window)는 보존한다
  - payload 없음. 이벤트는 프론트가 `@tauri-apps/api/event`의 listen으로 수신
- ui-shell 동작: `menu:new-tab` → 새 탭(웰컴), `menu:open-repo` → 새 탭 생성 후 즉시 폴더 다이얼로그(이미 웰컴 탭이 활성인 경우 그 탭에서), `menu:close-tab` → 활성 탭 닫기(마지막 탭이면 웰컴 탭 하나 남김), `menu:refresh` → 활성 탭 새로고침
- 툴바의 Open Repository 버튼은 제거한다. 레포 열기는 + 새 탭/⌘O/웰컴 화면 경유로만 (활성 레포 탭을 덮어쓰는 경로 제거). 웰컴 화면의 Open 버튼과 최근 목록은 유지
- 하네스(브라우저)에서는 Tauri 이벤트가 없으므로 ⌘T/⌘R keydown 폴백을 __TAURI_INTERNALS__ 부재 시에만 등록 (⌘W는 브라우저가 선점하므로 폴백 없음)

## v0.2 확장 (WIP 행, 스크롤 타깃, 키보드)

- `GraphData.wip: WipInfo | null`: rust-core가 `git status --porcelain -z` 1회로 채운다. 깨끗하면 null
- GraphView는 wip이 있으면 **HEAD 커밋 행 바로 위에 WIP 의사 행을 삽입**해 렌더한다:
  - MESSAGE: `// WIP — N changed files (M staged)` 스타일, fg-2 이탤릭
  - GRAPH: HEAD 레인 위치에 점선 테두리 링(채움 없음), HEAD 점까지 같은 레인 색 점선 수직 엣지
  - WIP 삽입으로 그 지점 아래 행들의 y가 ROW_HEIGHT만큼 밀린다. 원래 band(headIdx-1, headIdx)의 엣지는 두 행 높이에 걸쳐 그린다
  - WIP 행은 클릭 불가(선택/상세 없음), 가상 스크롤 인덱스 계산에 포함
- `GraphViewProps`에 추가:
  ```ts
  /** nonce가 바뀔 때마다 해당 sha 행을 뷰포트 중앙으로 스크롤. 목록에 없으면 무시 */
  scrollTarget: { sha: string; nonce: number } | null;
  ```
- 키보드: GraphView 스크롤 컨테이너 포커스 시 ↑/↓로 선택을 이전/다음 행으로 이동(onSelect 호출)하고 해당 행이 보이도록 스크롤. WIP 행은 건너뜀

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

## v0.11 확장 (UX 라운드: 탭·창, 키보드, 탐색·검색, 큰 기능)

### 이번 라운드 소유권 (6개 에이전트 병렬)

| 에이전트 | 소유 | 비고 |
|---|---|---|
| rust-core | `src-tauri/**` | 메뉴, 플러그인, 새 command |
| ui-graph | `src/graph/**` | GraphView 키보드/하이라이트/날짜 모드 |
| ui-shell | `src/App.tsx`, `src/shell/RepoWorkspace.tsx`, `src/shell/Toolbar.tsx`, `src/shell/api.ts`, `src/shell/shell.css`, `src/shell/devApp.tsx`, `src/shell/SearchBox.tsx`, `src/shell/WelcomeScreen.tsx` | **통합 허브**. 다른 UI 에이전트의 컴포넌트를 import해 배선 |
| ui-tabs | `src/shell/TabBar.tsx`, `src/shell/TabContextMenu.tsx`(신규), `src/shell/tabs.css`(신규) | 탭 UI 전담 |
| ui-sidebar | `src/shell/BranchSidebar.tsx`, `src/shell/SidebarContextMenu.tsx`(신규), `src/shell/sidebar.css`(신규) | 사이드바 전담 |
| ui-panels | `src/shell/CommitDetailPanel.tsx`, `src/shell/FileRow.tsx`, `src/shell/FileTree.tsx`, `src/shell/DiffView.tsx`, `src/shell/ShortcutsOverlay.tsx`(신규), `src/shell/QuickSwitcher.tsx`(신규), `src/shell/FilterResults.tsx`(신규), `src/shell/useDropZone.ts`(신규), `src/shell/panels.css`(신규) | 자족적 컴포넌트. props만으로 동작, App 상태 직접 접근 금지 |

- 새 컴포넌트의 스타일은 각자 CSS 파일(tabs.css/sidebar.css/panels.css)에 두고 컴포넌트에서 import. `shell.css`는 ui-shell만 수정. TabBar/BranchSidebar의 기존 스타일이 shell.css에 있으면 각자 CSS로 **옮기지 말고** 추가분만 새 파일에 쓴다 (shell.css의 기존 규칙과 충돌하는 것은 클래스명을 새로 붙여 회피)
- ui-shell은 아래 인터페이스를 믿고 배선한다. 다른 에이전트는 인터페이스를 정확히 이 형태로 export한다

### rust-core 추가

```
reveal_path(path: string) -> ()          // Finder/Explorer/파일관리자에서 항목 표시 (macOS: open -R)
open_in_terminal(path: string) -> ()     // 기본 터미널을 해당 디렉토리로 (macOS: open -a Terminal, Win: wt/cmd, Linux: x-terminal-emulator)
set_recent_repos(paths: string[]) -> ()  // File > Open Recent 서브메뉴 재구성 (최대 10개, 파일명만 라벨, 마지막에 구분선 + Clear Menu)
```
- 새 메뉴 이벤트: `menu:open-recent` (payload: string 경로), `menu:clear-recent` (payload 없음), `menu:toggle-sidebar`, `menu:zoom-in`, `menu:zoom-out`, `menu:zoom-reset`, `menu:shortcuts`
- View 메뉴 신설: Toggle Sidebar(CmdOrCtrl+B), 구분선, Zoom In(CmdOrCtrl+=), Zoom Out(CmdOrCtrl+-), Actual Size(CmdOrCtrl+0). Help 메뉴: Keyboard Shortcuts(CmdOrCtrl+/)
- **Shift+알파벳 조합은 네이티브 메뉴에 넣지 않는다** (muda 버그). ⌘⇧T/⌘⇧H/⌘⇧C/⌘⇧F는 웹뷰 keydown 담당
- 플러그인: `tauri-plugin-window-state`(창 크기·위치 복원) 등록 + capability. 웹뷰 줌: capability에 `core:webview:allow-set-webview-zoom` 추가 (프론트가 `getCurrentWebview().setZoom()` 호출)
- 드래그&드롭: 창 `dragDropEnabled` 유지(기본 true). 프론트가 `getCurrentWebview().onDragDropEvent` 사용. 필요한 capability(`core:webview:allow-internal-on-drop` 등 실제 식별자는 확인) 추가

### GraphView props 추가 (ui-graph)

```ts
/** 검색어. 있으면 MESSAGE/AUTHOR/SHA 셀에서 대소문자 무시 매치 구간을 <mark>로 강조 */
highlightQuery?: string;
/** 날짜 표시 모드. 기본 "absolute" */
dateMode?: "absolute" | "relative";
/** DATE 헤더 클릭 시 호출 (ui-shell이 토글·저장) */
onToggleDateMode?: () => void;
```
- 키보드 확장(스크롤 컨테이너 포커스 시): Home/⌘↑ 첫 커밋 선택+스크롤, End/⌘↓ 마지막, PageUp/PageDown 한 화면(뷰포트 행 수 - 1)만큼 선택 이동. 기존 ↑↓ 유지
- 상대 시간 포맷: "just now", "5m ago", "3h ago", "2d ago", "3w ago", 그 이상은 절대 날짜. 1분 주기로 갱신 불필요(정적)

### TabBar props (ui-tabs)

기존 props 유지 + 추가:
```ts
onReorder: (fromIndex: number, toIndex: number) => void;   // 드래그 재정렬 결과
onCloseOthers: (id: number) => void;   // TabInfo.id는 number
onCloseToRight: (id: number) => void;
onCopyPath: (id: number) => void;
onRevealInFinder: (id: number) => void;
onNewTab: () => void;                                       // 빈 영역 더블클릭 (기존 + 버튼과 동일 콜백)
```
- 드래그: HTML5 DnD 대신 pointer 이벤트(pointer capture)로 구현, 드래그 중 고스트/삽입 위치 표시, 드롭 시 onReorder 1회 호출. 탭 클릭(활성화)과 드래그 시작을 이동 거리 4px로 구분
- 우클릭 메뉴(TabContextMenu): Close, Close Others, Close Tabs to the Right, 구분선, Copy Path, Reveal in Finder. 빈 탭(path 없음)이면 Copy Path/Reveal 비활성. 바깥 클릭/Esc 닫힘
- 가운데 클릭 닫기 유지

### BranchSidebar props (ui-sidebar)

기존 props 유지 + 추가:
```ts
onCopyRefName: (name: string) => void;
onOpenRefOnRemote?: (ref: RefEntry) => void;   // remoteUrl이 있을 때만 전달됨 (없으면 undefined → 메뉴 항목 숨김)
```
- 상단 필터 입력창: placeholder "Filter branches", 대소문자 무시 부분일치로 LOCAL/REMOTE/TAGS 모두 필터, 매치 없는 섹션은 접지 말고 "No matches" 한 줄. 입력 시 매치 문자열 <mark> 강조. Esc로 클리어. 외부에서 포커스할 수 있게 `filterInputRef?: RefObject<HTMLInputElement | null>` prop (ui-shell이 ⌘⇧F 대신 **⌘⌥F**로 포커스 — Shift 회피)
- 우클릭 메뉴(SidebarContextMenu): Copy Name, Open on Remote(있을 때), Jump to Commit(기존 클릭 동작과 동일)

### ui-panels 컴포넌트

```ts
// ShortcutsOverlay: 단축키 치트시트. open=false면 null 렌더
export function ShortcutsOverlay(props: { open: boolean; onClose: () => void; platform: "mac" | "other" }): JSX.Element | null;
// 표시 목록은 컴포넌트 내부 상수 (이 계약의 최종 단축키 표 참고). ⌘/Ctrl 표기를 platform으로 분기

// QuickSwitcher (⌘P): refs를 퍼지 매치로 필터, ↑↓ 이동, Enter 선택, Esc 닫기
export function QuickSwitcher(props: { open: boolean; refs: RefEntry[]; onSelect: (ref: RefEntry) => void; onClose: () => void }): JSX.Element | null;
// 매치 점수: 접두 > 경로 세그먼트 시작 > 부분. 최근 선택 5개 상단 고정(localStorage gitlanes.quickswitch.recent)

// FilterResults (검색 필터 모드): 매치 커밋만 평면 목록. 그래프 없이 MESSAGE/AUTHOR/DATE, 클릭 시 onSelect
export function FilterResults(props: { rows: CommitRow[]; query: string; selectedSha: string | null; onSelect: (sha: string) => void; total: number; hasMore: boolean; onLoadMore: () => void }): JSX.Element;
// rows는 ui-shell이 이미 필터링해 전달. 가상 스크롤(행 30px). 매치 구간 <mark>

// useDropZone: 폴더 드래그&드롭. Tauri onDragDropEvent 구독, 브라우저(하네스)에서는 HTML5 dragover/drop 폴백
export function useDropZone(onDropPaths: (paths: string[]) => void): { isOver: boolean };
// 디렉토리가 아닌 파일이 떨어지면 부모 디렉토리로 정규화는 ui-shell(open_repo가 --show-toplevel로 해석)

// CommitDetailPanel 키보드: 파일 목록 포커스 시 ↑↓ 이동, Enter/→ diff 열기, ←/Backspace 목록 복귀. 포커스 가능 요소로 만들고 focus ring 표시
```

### ui-shell 배선과 단축키 (최종 표)

| 키 | 동작 | 처리 위치 |
|---|---|---|
| ⌘T / ⌘W / ⌘O / ⌘R | 새 탭 / 탭 닫기 / 레포 열기 / 새로고침 | 네이티브 메뉴 (기존) |
| ⌘1~8 / ⌘9 | 탭 이동 / 마지막 탭 | 네이티브 (기존) |
| ⌘⇧[ / ⌘⇧] , ⌥⌘← / → , Ctrl+Tab / Ctrl+⇧Tab | 탭 순환 | 웹뷰 keydown (Ctrl+Tab 추가) / 네이티브 |
| ⌘⇧T | 마지막으로 닫은 탭 복원 (스택, 세션 메모리, 최대 10) | 웹뷰 keydown |
| ⌘B | 사이드바 토글 | 네이티브 View 메뉴 → `menu:toggle-sidebar` |
| ⌘= / ⌘- / ⌘0 | 줌 인/아웃/초기화 (0.8~1.6, 0.1 단계, localStorage `gitlanes.zoom`, 시작 시 적용) | 네이티브 → `menu:zoom-*` → `getCurrentWebview().setZoom()` |
| ⌘/ | 단축키 치트시트 | 네이티브 Help → `menu:shortcuts` |
| ⌘⇧H | Go to HEAD (선택+중앙 스크롤). 툴바에도 버튼 | 웹뷰 keydown |
| ⌘P | 퀵 스위처 | 웹뷰 keydown |
| ⌘F / ⌘⇧F | 검색 포커스 / 검색 필터 모드 토글 (SearchBox에 토글 버튼도) | 웹뷰 (기존) / 웹뷰 |
| ⌘⌥F | 사이드바 브랜치 필터 포커스 | 웹뷰 keydown |
| ⌘C / ⌘⇧C | 선택 커밋 sha 복사 / 메시지 복사 (텍스트 선택 없고 입력창 포커스 아닐 때만) | 웹뷰 keydown |
| Esc | 열린 오버레이 닫기 → 검색 클리어 → 선택 해제(상세 패널 닫힘) 순서로 하나만 | 웹뷰 keydown |
| Home/End/PageUp/PageDown/⌘↑/⌘↓ | 그래프 이동 | GraphView |
| 폴더 드롭 | 새 탭에서 열기 (이미 열려 있으면 활성화) | useDropZone → ui-shell |
| 탭 바 빈 영역 더블클릭 | 새 탭 | TabBar |
| DATE 헤더 클릭 | 절대/상대 토글 (localStorage `gitlanes.dateMode`) | GraphView → ui-shell |

- 검색 필터 모드: 켜면 GraphView 대신 FilterResults를 같은 자리에 렌더 (rows는 기존 로컬 매치 + 전체 검색 결과를 합쳐 ui-shell이 필터). 끄면 그래프 복귀, 선택은 유지
- 툴바 레포명 우클릭 메뉴: Copy Path, Reveal in Finder, Open in Terminal (ContextMenu 재사용). File 메뉴의 Open Recent는 `set_recent_repos`로 동기화(최근 목록 변경마다)
- 하네스(devApp): 새 command mock(reveal_path/open_in_terminal/set_recent_repos는 콘솔 로그), setZoom은 try/catch로 무시, 드롭은 HTML5 폴백 경로 사용
- 오버레이 공통 규약: 모달형 오버레이(ShortcutsOverlay, QuickSwitcher 등)의 백드롭 요소는 반드시 클래스 `ov-backdrop`을 가진다. 컨텍스트 메뉴 루트는 `role="menu"`. ui-shell의 Esc 단계 사전 판정이 이 두 선택자로 "열린 오버레이 있음"을 판정하므로 이름 변경 금지
- `CommitDetailPanel` 옵션 prop: `onDiffOpenChange?: (open: boolean) => void`, `closeDiffNonce?: number` (Esc 단계의 diff→목록 복귀용)

## v0.12 확장 (GitKraken 스타일 메인 영역 diff 뷰어)

### 구조 변경
- 파일 클릭 시 diff는 **오른쪽 상세 패널 안이 아니라 왼쪽 메인 영역(GraphView 자리)에 전체 폭으로** 렌더한다 (GitKraken 방식). 오른쪽 패널은 커밋 상세 + 파일 목록을 그대로 유지하고, 열린 파일 행을 accent로 강조한다
- 닫기(× 버튼, Esc, 다른 커밋 선택)면 그래프로 복귀. 다른 파일 클릭이면 뷰어 내용만 교체

### rust-core
```
get_file_content(path: string, sha: string, file: string) -> string   // git show <sha>:<file>, 바이너리면 Err("binary")
```

### ui-panels
- `CommitDetailPanel` props 추가: `onOpenFile?: (file: FileChange) => void`, `openFilePath?: string | null`. `onOpenFile`이 주어지면 인라인 diff를 열지 않고 콜백만 호출(기존 인라인 경로는 미제공 시 폴백으로 유지). `openFilePath`와 같은 경로의 행은 accent 배경 강조. 키보드 Enter/→도 onOpenFile 경유
- **파일 목록 크기 복원(GitKraken 수준)**: 행 28px, 파일명 13px, 디렉토리 fg-2 12.5px. status는 글자 뱃지 대신 아이콘: 수정 ✎(var(--modified)), 추가 +(var(--added)), 삭제 −(var(--deleted)), 이름변경 ⇢(fg-2). 상단 요약 "N modified · N added · N deleted" 한 줄(각 색상)
- 신규 `DiffPanel` (src/shell/DiffPanel.tsx, panels.css):
  ```ts
  export interface DiffPanelProps {
    file: FileChange;
    /** unified diff 원문 (get_file_diff). 로딩 중 null */
    diffText: string | null;
    /** 커밋 시점 파일 전문 (get_file_content). File View/split에서만 필요, 미로드 시 null */
    fileText: string | null;
    /** fileText가 필요할 때 셸에 요청 */
    onRequestFileText: () => void;
    loading: boolean;
    error: string | null;   // "binary" 등
    onClose: () => void;
  }
  export function DiffPanel(props: DiffPanelProps): JSX.Element;
  ```
  - 헤더: status 아이콘 + 디렉토리(fg-2)/파일명(fg-1) + 오른쬭 × (title withKbd("Close","Esc"))
  - 툴바(중앙): `File View | Diff View` 세그먼트, hunk 이전/다음 ↑↓ 버튼(현재 hunk n/N), `Unified | Split` 세그먼트, 줄바꿈 토글. 모드는 localStorage `gitlanes.diff`에 저장
  - Diff View(unified): 각 줄에 old/new 줄번호 두 열(fg-2, 고정폭), 접두 +/−, 추가/삭제 배경(var(--added)/var(--deleted) 15%, 행 전체 폭), hunk 헤더 `@@ -a,b +c,d @@` 행(var(--link) 계열, 상단 여백)
  - Split: 좌 old / 우 new 두 컬럼, 대응 줄 정렬, 빈 쪽은 해칭 배경
  - File View: 파일 전문(fileText) + diff hunk 정보로 추가/변경 줄을 배경 강조 (삭제 줄은 표시 안 함)
  - **문법 강조**: `highlight.js/lib/core`에 kotlin, java, typescript, javascript, rust, json, yaml, markdown, css, scss, xml(html), bash, python, go, sql, swift, ruby, php, c, cpp, csharp, toml(ini) 등록. 확장자→언어 매핑. 가상 스크롤 유지: 파일 전체를 1회 하이라이트해 줄 단위 HTML 배열로 나눈 뒤(열린 span은 줄 경계에서 닫고 다음 줄에서 다시 열기) 보이는 줄만 렌더. 5,000줄 이상은 하이라이트 생략(plain)
  - 가상 스크롤(기존 DiffView 패턴), 줄 높이 20px, 폰트 12.5px 모노스페이스
  - 기존 `DiffView.tsx`는 인라인 폴백용으로 유지

### ui-shell
- RepoWorkspace: `openFile: FileChange | null` 상태. 파일 열림이면 메인 영역에 `GraphView` 대신 `DiffPanel` 렌더(사이드바/상세 패널은 유지). diffText는 get_file_diff, fileText는 onRequestFileText 시 get_file_content 호출(캐시 sha+path). 커밋 변경 시 openFile=null. Esc 단계에 "diff 패널 열려 있으면 닫기"를 diff 복귀 단계로 대체
- CommitDetailPanel에 `onOpenFile`/`openFilePath` 전달. 검색 필터 모드와 diff 패널이 동시에 켜지면 diff 패널 우선
- 툴바 상태 표시: 파일 열림 중엔 그래프 관련 단축키(Home/End 등)가 diff 패널로 가므로 충돌 없음

## v0.13 (Check for Updates 메뉴)
- rust-core: macOS App 메뉴의 About 바로 아래(구분선 포함) "Check for Updates…" 항목, Windows/Linux는 Help 메뉴에 (Keyboard Shortcuts 아래 구분선 후). 클릭 시 `menu:check-updates` emit (payload 없음, accelerator 없음)
- ui-shell: `menu:check-updates` 구독 → 기존 수동 업데이트 확인(useUpdateChecker의 manual 경로, 상단 pill 피드백) 실행. 툴바 버전 라벨 클릭과 동일 동작

## v0.14 (WIP 변경 내용 보기 — GitKraken WIP 노드)

- 사용자 요구: 파일을 수정하고 있으면 그 내용을 볼 수 있어야 한다. GitKraken처럼 WIP 행 클릭 → 오른쪽에 Staged/Unstaged/Untracked 파일 목록 → 파일 클릭 → 메인 영역 DiffPanel에 워킹 트리 diff. 읽기 전용(스테이징 조작 없음)

### 공용
- `WIP_SHA = "__WIP__"` (constants.ts): WIP 행 선택 시 `selectedSha`에 들어가는 센티널. 실제 sha와 충돌 불가
- `WipDetails`, `WipArea` (types.ts)

### rust-core
```
get_wip_details(path) -> WipDetails
   staged: git diff --cached --raw --numstat -z (기존 raw+numstat 파서 재사용)
   unstaged: git diff --raw --numstat -z
   untracked: git ls-files --others --exclude-standard -z → 각 파일 줄 수를 additions로 (바이너리/대용량은 0), status "A"
get_wip_file_diff(path, file, area: WipArea) -> string
   staged → git diff --cached -- <file> / unstaged → git diff -- <file> / untracked → git diff --no-index -- /dev/null <file> (exit code 1이 정상)
get_wip_file_content(path, file) -> string
   워킹 트리 파일을 fs로 읽음(레포 루트 밖 경로 거부: canonicalize 후 prefix 검사). 바이너리/5MB 규칙은 get_file_content와 동일
```

### ui-graph
- `GraphViewProps.onSelectWip?: () => void`. WIP 의사 행을 클릭 가능하게(커서 pointer, hover 배경) 하고 클릭 시 호출. `selectedSha === WIP_SHA`면 WIP 행에 선택 하이라이트. 키보드 ↑로 첫 커밋 위로 올라가면 WIP 행 선택(onSelectWip), WIP에서 ↓는 첫 커밋. 경로 강조는 WIP 선택 시 HEAD 기준으로(HEAD 조상 밝게)

### ui-panels
- 신규 `WipDetailPanel` (src/shell/WipDetailPanel.tsx):
  ```ts
  export interface WipDetailPanelProps {
    details: WipDetails | null;   // 로딩 중 null
    loading: boolean;
    onOpenFile: (file: FileChange, area: WipArea) => void;
    openFile: { path: string; area: WipArea } | null;   // 강조용
  }
  ```
  - 헤더 "// WIP" + 요약 "N staged · N unstaged · N untracked". 섹션 3개(STAGED / UNSTAGED / UNTRACKED, 각 개수 뱃지, 비면 섹션 숨김). 파일 행은 기존 FileRow(아이콘·±·28px) 재사용, Path|Tree 토글 공유. 키보드 탐색은 CommitDetailPanel과 동일 규칙
  - DiffPanel은 변경 없음(diffText/fileText만 받음). 단 헤더에 area 배지("staged"/"unstaged"/"untracked")를 표시할 수 있게 옵션 prop `badge?: string` 추가

### ui-shell
- WIP 선택 흐름: `onSelectWip` → `selectedSha = WIP_SHA` → 오른쪽에 CommitDetailPanel 대신 WipDetailPanel (get_wip_details 로드). 파일 열기 → get_wip_file_diff(area) → DiffPanel(badge=area), File View는 get_wip_file_content
- 자동 새로고침 폴링에서 wip 요약이 바뀌면(이미 감지 중) WIP가 선택돼 있을 때 get_wip_details 재로드 + 열린 파일 diff 재요청 (파일이 사라졌으면 DiffPanel 닫기)
- WIP_SHA는 검색/퀵스위처/scrollTarget 대상이 아님. 컨텍스트 메뉴(copy sha)는 WIP에서 비활성
- Go to HEAD, Esc 선택 해제 등 기존 동작 유지. devApp mock에 3개 command 목(staged 2, unstaged 3, untracked 1)

## v0.15 쓰기 작업 (GitKraken 툴바: Fetch·Pull·Push·Branch·Stash·Pop·Terminal)

읽기 전용 원칙을 해제한다. 대신 안전장치가 계약이다: 확인 다이얼로그, 비대화식 실행, 충돌 안내, 작업 후 자동 새로고침. Undo/Redo(reflog 기반)는 다음 라운드.

### rust-core
모든 쓰기 command는 `Result<OpResult, String>`(Err는 인자 검증 실패 같은 호출 오류만). 공통 실행 규칙:
- 환경변수 `GIT_TERMINAL_PROMPT=0`, `GIT_SSH_COMMAND=ssh -oBatchMode=yes`, `GIT_ASKPASS=` (빈 값) 로 **어떤 경우에도 프롬프트를 띄우지 않고** 실패시킨다. LANG=C로 메시지 고정
- 타임아웃 120초(네트워크 작업), 60초(로컬 작업). 초과 시 kill + ok=false, stderr="timed out"
- 작업 후 `git diff --name-only --diff-filter=U`로 충돌 파일 수집
- 브랜치/리모트/ref 이름은 `git check-ref-format --branch`로 검증, `-` 시작 거부
```
get_sync_state(path) -> SyncState                         // rev-list --left-right --count @{u}...HEAD, stash list 개수
git_fetch(path, remote: string | null, prune: bool) -> OpResult     // remote null이면 --all
git_pull(path, mode: PullMode) -> OpResult                // ff-only | merge(--no-ff 아님, 기본) | rebase
git_push(path, set_upstream: bool, force_with_lease: bool) -> OpResult   // 현재 브랜치. upstream 없고 set_upstream이면 -u origin <branch>. 일반 --force 금지
git_checkout(path, target: string) -> OpResult             // 로컬 브랜치 이름 또는 원격 브랜치("origin/x" → 로컬 x 추적 생성 후 체크아웃)
git_create_branch(path, name: string, start_point: string | null, checkout: bool) -> OpResult
git_delete_branch(path, name: string, force: bool) -> OpResult       // 로컬만. 현재 브랜치 삭제는 Err
git_merge(path, source: string) -> OpResult                // 현재 브랜치로 source 머지 (--no-edit)
git_stash_push(path, message: string | null, include_untracked: bool) -> OpResult
git_stash_pop(path) -> OpResult                            // stash@{0}
```

### ui-panels
- `ConfirmDialog({ open, title, body, confirmLabel, danger?: boolean, onConfirm, onCancel })` — 모달, Enter=확인, Esc=취소, danger면 확인 버튼 var(--deleted)
- `PromptDialog({ open, title, label, placeholder, defaultValue?, validate?: (v)=>string|null, confirmLabel, onSubmit(value), onCancel })` — 브랜치 이름/스태시 메시지 입력. validate가 문자열을 돌려주면 그 오류 표시 + 확인 비활성
- `OpResultToast` 대신 기존 Toast 사용(ui-shell). 충돌은 `ConflictBanner({ files, onDismiss })` — 툴바 아래 배너: "N개 파일 충돌 — 편집기에서 해결 후 커밋하세요" + 파일 목록(클릭 시 WIP 패널 열기 콜백 `onOpenWip`)

### ui-sidebar
- 브랜치 항목 우클릭 메뉴 확장(콜백 옵션 props, undefined면 항목 숨김): `onCheckout(ref)`, `onCreateBranchFrom(ref)`, `onDeleteBranch(ref)`(로컬만, isHead면 비활성), `onMergeIntoCurrent(ref)`(isHead면 숨김), `onPushBranch(ref)`(로컬만)
- 로컬 브랜치 **더블클릭 = checkout** (GitKraken 관례). 원격 브랜치 더블클릭도 checkout(추적 생성)
- 현재 브랜치 옆 ↑N ↓M 배지: 새 prop `syncState?: SyncState`

### ui-shell
- **툴바(GitKraken 순서)**: `Fetch ▾` (드롭다운: Fetch / Fetch & Prune / Pull (fast-forward) / Pull (merge) / Pull (rebase)), `Push`, `Branch`(+ 새 브랜치: PromptDialog → git_create_branch(checkout=true)), `Stash`(PromptDialog 메시지 선택 입력, untracked 포함 체크), `Pop`(stashCount 0이면 비활성), `Terminal`(기존 open_in_terminal). 각 버튼은 실행 중 스피너 + 비활성, 툴팁에 단축키(withKbd)
- Push/Fetch 버튼에 ↑ahead / ↓behind 배지(get_sync_state, 폴링 주기마다 갱신). upstream 없으면 Push 클릭 시 "origin에 upstream 설정하며 푸시" ConfirmDialog
- 확인이 필요한 작업: Push(항상: "origin/main으로 N개 커밋 푸시"), 브랜치 삭제(danger), force-with-lease(danger), Pop(충돌 가능 안내). Fetch/Pull ff-only/Stash/Checkout은 확인 없이
- 작업 결과: ok면 info 토스트 한 줄(git stdout 요약), 실패면 error 토스트에 stderr 그대로(여러 줄 허용, 12초 유지, 복사 버튼). conflicts 있으면 ConflictBanner
- 작업 후 `reloadFromStart()` + list_refs + get_sync_state. 워킹 트리 dirty 상태에서 checkout 실패는 stderr가 그대로 안내됨
- 그래프 행 컨텍스트 메뉴에 추가: "Create branch here…", "Checkout <branch>"(행에 로컬 브랜치 pill이 있을 때, 여러 개면 각각), "Cherry-pick"은 다음 라운드
- 단축키: Fetch ⌘⇧L? → **없음**(GitKraken도 없음). Push/Stash도 단축키 없음. 실수 방지 우선
- README/릴리스 노트의 "읽기 전용" 문구는 감독이 수정

## v0.16 (쓰기 작업 롤백 + 하단 내장 터미널)

사용자 결정: 읽기 전용으로 되돌리고, 인증이 필요한 git 작업은 앱 하단 내장 터미널에서 사용자 환경 그대로 하게 한다. (v0.15 쓰기 작업 전체 롤백)

### 롤백 (감독 + 각 소유자)
- 툴바의 Fetch▾/Push/Branch/Stash/Pop 그룹 제거(Terminal은 하단 토글로 대체). 사이드바 브랜치 우클릭의 checkout/create/merge/delete/push 제거(Copy Name/Open on Remote/Jump만 남김), 더블클릭 checkout 제거(더블클릭=Jump로). 그래프 행 메뉴의 Create branch/Checkout 제거. ConfirmDialog/PromptDialog/ConflictBanner는 파일로 남겨도 되나 미사용(정리는 감독)
- rust-core: ops.rs의 쓰기 command 10개는 파일째 삭제하지 않고 `#[cfg(feature = "write-ops")]`로 봉인 + invoke_handler 등록 해제(테스트는 유지). get_sync_state도 봉인(ahead/behind 배지 제거)
- README/웰컴/릴리스 노트: "읽기 전용" 문구 복원 + "내장 터미널" 추가
- src/types.ts의 OpResult/SyncState/PullMode는 남겨두되 미사용 주석

### 내장 터미널 (신규)
xterm.js 6(@xterm/xterm, @xterm/addon-fit, @xterm/addon-web-links 설치됨) + portable-pty 0.9(설치됨).

rust-core:
```
term_open(path: string, cols: number, rows: number) -> string   // PTY 생성, 세션 id 반환. 셸은 $SHELL(없으면 /bin/zsh→/bin/bash), cwd=path, 로그인 셸(-l)
term_write(id: string, data: string) -> ()                       // 키 입력을 PTY stdin에 씀
term_resize(id: string, cols: number, rows: number) -> ()
term_close(id: string) -> ()                                     // PTY kill + reader 정리
```
- PTY 출력은 Tauri 이벤트 `term:data:{id}` payload=string(UTF-8, lossy)로 프론트에 스트리밍. 종료는 `term:exit:{id}` payload=exitCode. 세션은 앱 상태(Mutex<HashMap>)로 관리, 앱 종료 시 전부 kill
- capability: 새 이벤트 listen은 core:event:default로 커버됨. 별도 권한 불필요

ui-panels: 신규 `Terminal.tsx`
```ts
export interface TerminalProps { repoPath: string; visible: boolean; onClose: () => void; }
export function Terminal(props: TerminalProps): JSX.Element;
```
- @xterm/xterm Terminal + FitAddon + WebLinksAddon. 다크 테마 색을 우리 팔레트로(bg var(--bg-content), fg var(--fg-1), 커서 var(--accent), 16색은 LANE_COLORS 근사). visible이 true가 될 때 term_open(아직 없으면), onData→term_write, term:data 이벤트→write, resize observer→fit+term_resize. term:exit면 "[프로세스 종료: N] — 클릭해서 재시작" 표시. 폰트는 ui-monospace 12.5px
- 세션은 repoPath당 1개 유지(탭 전환해도 살아있게 — 컴포넌트는 hidden으로 숨기고 언마운트 안 함). visible=false면 display:none(PTY는 유지)

ui-shell:
- 하단 터미널 패널: RepoWorkspace 하단에 접히는 영역(기본 접힘, 높이 기억 localStorage `gitlanes.termHeight`, 상단 경계 드래그로 높이 조절 — SplitHandle 가로 버전 또는 수평 스플리터). 툴바에 Terminal 토글 버튼(아이콘, active 상태 표시), 단축키 `⌃\`` (Ctrl+백틱, 웹뷰 keydown, 네이티브 메뉴 View에도 "Toggle Terminal" 항목은 rust-core가 추가 → menu:toggle-terminal). 열릴 때 자동 포커스, 패널 헤더에 레포 경로 + × 닫기
- 기존 툴바 open_in_terminal(외부 터미널)은 제거 (내장으로 대체). ContextMenu의 "Open in Terminal"도 제거
- rust-core에 `menu:toggle-terminal`(View 메뉴, ⌃` accelerator — 백틱은 Shift 아니라 muda 문제 없음) 요청

## v0.17 (hover 부모/자식 강조 + 설정)

- 사용자 요청: 커밋 선택이 없을 때 그래프 행에 hover하면 그 커밋의 조상/자손 경로를 강조(기존 클릭 강조와 동일 로직). 선택된 커밋이 있으면 선택이 우선하고 hover 강조는 무시. 취향차라 옵션으로, 기본값 on.
- `GraphViewProps`에 옵션 prop 추가:
  ```ts
  /** hover 시 부모/자식 경로 강조 (selectedSha가 null일 때만 동작). 기본 렌더에서 undefined면 false 취급 */
  hoverHighlight?: boolean;
  ```
- ui-graph: hoverHighlight가 true이고 selectedSha가 null이면, 마우스가 올라간 커밋 행 기준으로 기존 강조 집합(buildHighlight, 조상+자손)을 계산해 dim 적용. selectedSha가 있으면 그게 우선(hover 무시). 성능: hover 행이 바뀔 때만 재계산(sha→row Map + 이미 있는 자식 맵 재사용), 캔버스는 기존 강조 렌더 경로 그대로. WIP/스태시 의사 행 hover는 앵커 커밋 기준. 마우스가 그래프 밖으로 나가면 강조 해제. rAF/throttle로 마우스 이동당 과도한 재계산 방지(같은 행이면 skip)
- ui-shell: 설정 상태 `hoverHighlight`(localStorage `gitlanes.hoverHighlight`, 기본 true). GraphView에 전달. View 메뉴에 "Highlight on Hover" 체크 항목(rust-core가 `menu:toggle-hover-highlight` 요청) + 툴바나 설정에서 토글 가능하면 좋으나 최소 메뉴 하나. 상태 변경 시 저장.
- rust-core: View 메뉴에 "Highlight on Hover" 체크 가능 항목(CheckMenuItem, 단축키 없음) → emit `menu:toggle-hover-highlight`. 초기 체크 상태는 프론트가 관리하므로 rust는 토글 이벤트만 보냄(체크 표시는 프론트 상태와 별개로 rust가 자체 토글하거나, 단순 MenuItem으로 두고 체크는 안 해도 됨 — 판단은 rust-core)
