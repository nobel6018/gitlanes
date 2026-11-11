# 디자인 시스템

GitLanes의 색, 폰트, 상태 표현 규칙입니다. 2026-11 Hallmark restyle(Console 테마, graphite)로 정했습니다.
레이아웃은 그대로 두고 시스템만 바꿨습니다.

## 파일 위치

| 무엇 | 어디 |
|------|------|
| 토큰 (색, 폰트, 모션, 반경) | `src/tokens.css` |
| 계약 변수 별칭, 전역 규칙 | `src/theme.css` (CONTRACTS.md의 변수 이름 유지) |
| 번들 폰트 | `src/assets/fonts/*.woff2` |
| 폰트 로드 대기 | `src/fonts.ts` `whenFontsReady()` (`src/main.tsx`, `src/shell/devApp.tsx`에서 호출) |
| 레인 색 | `src/constants.ts` `LANE_COLORS` |
| xterm 색 변환 | `src/shell/Terminal.tsx` `toSrgbHex()`, `readTheme()` |
| SVG 아이콘 | `src/shell/icons.tsx` |

## 색의 의미

바탕은 흑연색 3단계입니다. 탭바(`--color-paper-3`)가 가장 어둡고, 그래프(`--color-paper`)가 그 위, 사이드바와 패널(`--color-paper-2`)이 한 단계 밝습니다. 그림자 대신 이 명도 차이로 층을 나눕니다.

앰버(`--color-accent`)는 사람이 지금 하는 일에만 씁니다.

- 주 버튼 (Commit, 다이얼로그 확인, Open)
- 포커스 링
- 선택된 행 (앰버를 바탕에 16% 섞은 `--color-select`, 글자는 `--color-ink`)
- 활성 탭의 윗선

차가운 파랑(`--color-cool`)은 git이 쓴 값에 씁니다. sha, 링크, 켜진 토글(Diff View, Unified, Path)이 여기에 해당합니다.

초록과 빨강, 노랑(`--color-ok`, `--color-bad`, `--color-changed`)은 diff와 파일 상태에만 씁니다.

### 하지 않는 것

- 앰버 바탕에 밝은 글자를 얹지 않습니다. 앰버 위의 글자는 항상 `--color-accent-ink`입니다
- 개수 배지(Pull/Push 개수 등)는 앰버가 아니라 중립색(`--color-rule-2` 바탕, `--color-ink` 글자)입니다
- 선택이나 포커스를 행 한쪽의 색 띠로 표시하지 않습니다. 행 전체 배경이나 전체 외곽선으로 표시합니다
- 메뉴 hover를 앰버로 칠하지 않습니다. `--color-rule` 바탕으로 한 단계만 올립니다
- 색 리터럴을 CSS에 쓰지 않습니다. 필요한 색은 `tokens.css`에 이름을 붙여 추가합니다

## 글자

| 역할 | 폰트 |
|------|------|
| UI, 커밋 메시지, 라벨 | Host Grotesk (한글은 Apple SD Gothic Neo, Noto Sans KR로 대체) |
| sha, 날짜, diff, 코드, 숫자 | Atkinson Hyperlegible Mono (`tabular-nums`, `slashed-zero`) |
| 터미널 | 시스템 monospace (프롬프트 글리프 호환) |

라벨, 컬럼 헤더, 섹션 제목은 대문자 변환이나 자간을 쓰지 않습니다. 본문보다 한 단계 작게, weight 500으로 씁니다. 기능 글자는 11px 아래로 내리지 않습니다.

예외가 하나 있습니다. ref pill(`.gl-pill`, `.gl-pill-more`)의 크기와 weight는 `src/graph/RefPills.tsx`의 canvas 측정 상수와 같아야 합니다. 한쪽만 바꾸면 "+N" 넘침 판정이 틀어집니다.

## 레인 색

`LANE_COLORS` 10개는 OKLCH 명도 76%, 채도 0.125로 맞춘 뒤 hex로 변환한 값입니다(파랑만 sRGB 범위 때문에 0.11). 색상 순서는 이전 팔레트와 같습니다. canvas와 `layout.ts`의 rgba 파싱이 hex를 전제하므로 hex로 둡니다.

## 상태

- 비활성: `opacity: 0.55`, `--color-muted` 글자, `cursor: not-allowed`, 그리고 네이티브 `disabled` 속성
- 포커스: `:focus-visible`에 2px `--color-focus` 외곽선, 바로 나타남. 입력창 테두리 색을 바꾸는 방식은 쓰지 않습니다
- 모션: `--dur-micro`, `--dur-short`만 씁니다. `prefers-reduced-motion`이면 전부 끕니다
