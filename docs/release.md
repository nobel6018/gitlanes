# 릴리스

## 하는 법

```sh
scripts/release.sh 0.23.1
```

`release/v0.23.1` 브랜치에서 버전 5곳(`package.json`, `package-lock.json`, `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml`, `src-tauri/Cargo.lock`)을 올리고 PR을 만든 뒤 바로 머지합니다. 머지되면 `auto-release.yml`이 태그를 만들고 `release.yml`을 불러 macOS, Windows, Linux 빌드를 Release에 올립니다. 앱 안 업데이트용 `latest.json`도 이때 붙습니다(docs/update.md).

버전 형식이 틀렸거나, 작업 트리가 깨끗하지 않거나, 바뀐 파일이 5개가 아니면 PR을 만들기 전에 멈춥니다.

## 빨리 끝나게 한 것

릴리스에서 기다리는 시간은 대부분 macOS 러너 대기와 Rust 컴파일입니다. 아래 세 가지로 줄였습니다.

| 무엇 | 위치 | 이유 |
|---|---|---|
| 릴리스 PR과 그 머지 커밋에서 CI를 건너뜀 | `.github/workflows/ci.yml` `test`, `dev-build`의 `if` | 버전만 바뀐 커밋입니다. 같은 시각에 도는 릴리스 빌드와 macOS 러너를 다투지 않게 합니다 |
| 릴리스 빌드에서 테스트를 다시 돌리지 않음 | `.github/workflows/release.yml` `build` | `cargo test`는 debug 프로필이라 release 빌드와 캐시를 나누지 못해 OS마다 2~7분(v0.22.0 기준 macOS 4분, Windows 7분 30초)을 더 썼습니다. tsc는 `tauri build`의 `npm run build`가 돌립니다 |
| 같은 PR의 이전 CI 실행을 끊음 | `ci.yml` `concurrency` | 새 커밋을 올리면 낡은 실행이 러너를 잡고 있지 않게 합니다 |

검사는 PR CI가 맡습니다. 그래서 릴리스는 CI를 통과한 main에서만 만듭니다. `release.sh`가 항상 최신 main에서 브랜치를 따는 이유입니다.

## 태그를 직접 올릴 때

`v1.2.3-rc.1`처럼 하이픈이 붙은 태그를 직접 푸시하면 macOS universal만 프리릴리스로 만듭니다(`release.yml` `plan`). 태그와 매니페스트 버전이 어긋나면 `plan`에서 멈춥니다.
