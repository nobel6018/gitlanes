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
