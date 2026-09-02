#!/usr/bin/env bash
# 릴리스 노트 생성: 직전 태그 이후 커밋을 유형별로 묶고, 버전/커밋/시간, 받을 파일, 첫 실행 안내를 붙인다.
# 사용: release-notes.sh <tag> [repo(owner/name)]  → stdout에 마크다운
set -euo pipefail

TAG="${1:?tag required}"
REPO="${2:-${GITHUB_REPOSITORY:-nobel6018/gitlanes}}"
VERSION="${TAG#v}"
SHA_FULL="$(git rev-parse HEAD)"
SHA="${SHA_FULL:0:7}"
WHEN="$(TZ=Asia/Seoul date '+%Y-%m-%d %H:%M KST')"
PREV="$(git describe --tags --abbrev=0 "${TAG}^" 2>/dev/null || true)"
RANGE="${PREV:+${PREV}..}${TAG}"

declare -a FEAT FIX PERF OTHER
while IFS='|' read -r h s; do
  [ -z "$h" ] && continue
  # PR 번호: 커밋에 연결된 PR을 조회 (없으면 생략)
  pr="$(gh api "repos/${REPO}/commits/${h}/pulls" --jq '.[0].number' 2>/dev/null || true)"
  prpart=""; [ -n "$pr" ] && prpart=" (#${pr})"
  subject="${s#*: }"           # 타입 접두 제거
  subject="${subject%%;*}"     # "; v0.x.y" 같은 꼬리 제거
  line="- ${subject}${prpart} ([${h}](https://github.com/${REPO}/commit/${h}))"
  case "$s" in
    feat*) FEAT+=("$line") ;;
    fix*) FIX+=("$line") ;;
    perf*) PERF+=("$line") ;;
    *) OTHER+=("$line") ;;
  esac
done < <(git log "$RANGE" --no-merges --pretty='%h|%s' | grep -v '|docs' || true)

section() { local title="$1"; shift; [ "$#" -eq 0 ] && return; printf '## %s\n\n' "$title"; printf '%s\n' "$@"; printf '\n'; }

# bash 3.2(macOS)는 set -u에서 빈 배열을 unset으로 보므로 ${arr[@]+...} 가드로 개수를 센다
count() { local -a a=("${@}"); echo "${#a[@]}"; }
n_feat=$(count ${FEAT[@]+"${FEAT[@]}"}); n_fix=$(count ${FIX[@]+"${FIX[@]}"})
n_perf=$(count ${PERF[@]+"${PERF[@]}"}); n_other=$(count ${OTHER[@]+"${OTHER[@]}"})
summary=""
[ "$n_feat" -gt 0 ] && summary+="기능 ${n_feat}"
[ "$n_fix" -gt 0 ] && summary+="${summary:+ · }수정 ${n_fix}"
[ "$n_perf" -gt 0 ] && summary+="${summary:+ · }성능 ${n_perf}"
[ "$n_other" -gt 0 ] && summary+="${summary:+ · }기타 ${n_other}"
[ -n "$summary" ] && printf '**이번 릴리스** %s\n\n' "$summary"

section "기능" "${FEAT[@]+"${FEAT[@]}"}"
section "수정" "${FIX[@]+"${FIX[@]}"}"
section "성능" "${PERF[@]+"${PERF[@]}"}"
section "기타" "${OTHER[@]+"${OTHER[@]}"}"

cat <<MD
---

버전 \`${VERSION}\` · 커밋 \`${SHA}\` · ${WHEN}${PREV:+ · 이전 릴리스 [${PREV}](https://github.com/${REPO}/releases/tag/${PREV})}

## 어느 파일을 받나

- macOS (애플실리콘, 인텔 공통): \`GitLanes_${VERSION}_universal.dmg\`
- Windows: \`GitLanes_${VERSION}_x64-setup.exe\` (또는 \`.msi\`)
- Linux: \`.deb\` / \`.rpm\` / \`.AppImage\` 중 배포판에 맞는 것

## macOS 첫 실행 경고 해제

코드 서명 없이 빌드된 앱이라 Gatekeeper가 첫 실행을 막습니다.
dmg에서 앱을 응용 프로그램 폴더로 옮긴 뒤 터미널에서 한 줄 실행하세요.

\`\`\`
xattr -cr /Applications/GitLanes.app
\`\`\`

## Windows SmartScreen

"Windows의 PC 보호" 창이 뜨면 추가 정보 → 실행을 누르세요.

## 이미 설치했다면

앱을 켜두면 상단에 새 버전 배너가 뜹니다. 배너의 "릴리스 페이지 열기"로 여기 와서 받거나, 메뉴 GitLanes > Check for Updates… 로 직접 확인할 수 있습니다. 새 dmg의 앱을 응용 프로그램 폴더에 덮어쓰면 끝입니다(설정과 최근 레포는 유지).

## 실행 방법

앱을 열고 \`⌘O\`(Windows/Linux는 \`Ctrl+O\`)로 로컬 git 레포 폴더를 선택하거나, Finder에서 폴더를 창으로 드래그하세요.
터미널에서는 \`open -a GitLanes <레포경로>\`로 바로 열 수 있습니다. 툴바에서 fetch·pull·push·브랜치·스태시를 쓸 수 있고, push나 브랜치 삭제 같은 작업은 확인 창을 거칩니다.
${PREV:+
**Full Changelog**: [${PREV}...${TAG}](https://github.com/${REPO}/compare/${PREV}...${TAG})}
MD
