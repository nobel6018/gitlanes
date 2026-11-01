# 앱 업데이트

GitLanes는 0.22.0부터 앱 안에서 새 버전을 받아 설치합니다. 0.21.x 이하에서는 한 번만 Release에서 직접 받아 설치합니다.

## 동작

1. 앱을 켜면(Preferences "Check for updates on launch") 또는 툴바 버전을 누르면 `releases/latest/download/latest.json`을 읽습니다
2. 새 버전이 있으면 배너에 "업데이트하고 다시 켜기" 버튼이 뜹니다. 저절로 설치하지 않습니다. 툴바의 `vX ↑` 배지는 닫아 둔 배너를 다시 띄웁니다
3. 버튼을 누르면 열린 터미널 수를 확인합니다. 하나라도 있으면 닫힌다고 묻고, 취소하면 아무것도 하지 않습니다
4. 받고, 앱에 박힌 공개 키로 서명을 확인한 뒤 터미널을 닫고 설치하고 다시 켭니다
5. 실패하면 배너에 이유와 릴리스 페이지 링크를 보여 줍니다. 다시 누르면 처음부터 받습니다(`install()`이 받은 바이트를 비우기 때문)

`latest.json`을 못 읽으면(updater 도입 전 릴리스, 이 플랫폼 파일 없음) GitHub API로 새 버전만 확인해 "릴리스 페이지 열기" 버튼을 보여 줍니다.

플랫폼별 설치. `latest.json`에는 설치 방식별 키(`windows-x86_64-nsis`, `linux-x86_64-deb` 등)가 함께 들어 있어, updater가 지금 설치된 방식에 맞는 파일을 고릅니다.

| 플랫폼 | 받는 파일 | 설치 |
|---|---|---|
| macOS | `GitLanes_universal.app.tar.gz` | `.app`을 통째로 바꾼다. 격리 표시가 붙지 않아 `xattr -cr`이 필요 없다 |
| Windows | 설치한 방식대로 `-setup.exe`(NSIS) 또는 `.msi` | 설치 파일을 passive 모드(진행 막대만)로 띄우고 앱은 바로 끝난다. 설치 파일이 앱을 다시 켠다 |
| Linux | 설치한 방식대로 `.AppImage`, `.deb`, `.rpm` | deb, rpm은 관리자 암호를 묻는다. 실기 확인 전 |

Windows는 `install()`이 앱을 바로 끝내서 `RunEvent::Exit` 정리가 돌지 않으므로, 설치 직전에 `term_close_all`로 셸을 먼저 닫습니다.

## 서명

Apple, Windows 코드 서명과 별개인 Tauri updater 서명(minisign)입니다.

| 항목 | 위치 |
|---|---|
| 공개 키 | `src-tauri/tauri.conf.json` `plugins.updater.pubkey` |
| 비밀 키 | `~/.tauri/gitlanes-updater.key`(비밀번호 없음), 저장소 secret `TAURI_SIGNING_PRIVATE_KEY` |

비밀 키를 잃으면 설치된 앱에 업데이트를 보낼 수 없습니다. 새 키로 만든 앱을 사용자가 손으로 다시 설치해야 하니 따로 백업합니다.

`createUpdaterArtifacts`가 켜져 있어 비밀 키 없이 `npm run tauri build`를 하면 실패합니다. 로컬 빌드는 아래처럼 합니다.

```sh
TAURI_SIGNING_PRIVATE_KEY="$(cat ~/.tauri/gitlanes-updater.key)" TAURI_SIGNING_PRIVATE_KEY_PASSWORD="" npm run tauri build
```

## 릴리스

`release.yml`의 `tauri-action`이 서명 키를 받아 OS별 빌드마다 업데이트 파일, `.sig`, `latest.json`을 Release에 올립니다. `latest.json`은 OS 작업이 끝날 때마다 자기 플랫폼을 더해 갱신됩니다. 한 OS 빌드가 실패하면 그 플랫폼만 `latest.json`에서 빠지고, 그 OS 앱은 릴리스 페이지 안내로 돌아갑니다.

## 코드 위치

| 위치 | 내용 |
|---|---|
| `src/shell/useUpdateChecker.ts` | `findUpdate`(latest.json, GitHub API), `install` |
| `src/shell/UpdateBanner.tsx` | 배너 버튼과 진행률 |
| `src-tauri/src/term.rs` | `term_count`, `term_close_all` |
| `src-tauri/src/lib.rs` | updater, process 플러그인 등록 |
| `src-tauri/capabilities/default.json` | `updater:default`, `process:allow-restart` |
| `.github/workflows/release.yml`, `ci.yml` | 서명 키 전달 |
