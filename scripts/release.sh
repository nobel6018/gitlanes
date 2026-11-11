#!/usr/bin/env bash
# 릴리스 PR을 만들고 바로 머지한다. 머지하면 auto-release.yml이 태그와 Release를 만든다.
#   scripts/release.sh 0.23.1
# @see docs/release.md
set -euo pipefail

version="${1:?사용법: scripts/release.sh <x.y.z>}"
[[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?$ ]] || { echo "버전 형식이 아닙니다: $version" >&2; exit 1; }

cd "$(git rev-parse --show-toplevel)"
[ -z "$(git status --porcelain)" ] || { echo "작업 트리가 깨끗하지 않습니다" >&2; exit 1; }

git switch -q main
git pull -q --ff-only
current="$(node -p "require('./package.json').version")"
[ "$current" != "$version" ] || { echo "이미 $version 입니다" >&2; exit 1; }

branch="release/v${version}"
git switch -q -c "$branch"

npm version "$version" --no-git-tag-version --allow-same-version >/dev/null
sed -i.bak -E "s/^(  \"version\": )\"${current//./\\.}\"/\1\"${version}\"/" src-tauri/tauri.conf.json
sed -i.bak -E "s/^version = \"${current//./\\.}\"/version = \"${version}\"/" src-tauri/Cargo.toml
perl -0pi -e "s/(name = \"gitlanes\"\nversion = )\"\Q${current}\E\"/\${1}\"${version}\"/" src-tauri/Cargo.lock
rm -f src-tauri/tauri.conf.json.bak src-tauri/Cargo.toml.bak

# release.yml plan 작업과 같은 검사를 먼저 해서, 어긋난 채로 머지하지 않는다
for f in package.json src-tauri/tauri.conf.json; do
  grep -q "\"version\": \"${version}\"" "$f" || { echo "$f 버전을 못 바꿨습니다" >&2; exit 1; }
done
grep -q "^version = \"${version}\"" src-tauri/Cargo.toml || { echo "Cargo.toml 버전을 못 바꿨습니다" >&2; exit 1; }
[ "$(git diff --name-only | wc -l | tr -d ' ')" = "5" ] || { echo "바뀐 파일이 5개가 아닙니다" >&2; git diff --stat >&2; exit 1; }

git commit -qam "chore: ${version}"
git push -q -u origin "$branch"
gh pr create --base main --head "$branch" --title "chore: ${version}" \
  --body "릴리스 v${version}. 머지하면 auto-release가 태그와 Release를 만들고, tauri-action이 latest.json을 붙입니다."
gh pr merge "$branch" --merge --delete-branch
git switch -q main
git pull -q --ff-only

echo "머지했습니다. 진행 상황: gh run list -w 'Auto Release' -L 1"
