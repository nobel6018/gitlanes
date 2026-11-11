# 설계 결정 기록

레퍼런스 앱과 다르게 만든 것, 또는 나중에 "왜 이렇게 했지"가 나올 만한 판단을 남깁니다.
코드에서 `@see docs/decisions.md#<앵커>` 로 참조합니다.

---

## discard 범위

**결정**: `git_discard`는 `area: "worktree" | "all"` 을 받아 되돌릴 범위를 나눕니다.
GitKraken과 SourceGit은 이 구분이 없고 항상 `"all"` 에 해당하는 동작만 합니다.

**날짜**: 2026-09-14 (v0.15.0, PR #45)

### 문제 상황

한 파일을 두 번 고치고 앞의 변경만 스테이지한 경우입니다. 잘 된 부분을 `git add` 해두고
계속 작업하는 흔한 패턴입니다.

```
config.ts 수정  ->  git add config.ts    변경 A가 인덱스로
config.ts 수정                            변경 B는 워킹트리에만
```

WIP 패널에서 같은 파일이 두 영역에 동시에 나타나고, 각 행에 되돌리기 버튼이 붙습니다.

```
Unstaged
  M config.ts     <- 변경 B
Staged
  M config.ts     <- 변경 A
```

### 동작

| 누른 위치 | area | 실행 | 결과 |
|---|---|---|---|
| Unstaged 행 | `"worktree"` | `git restore -- <files>` | 변경 B만 사라지고 A는 인덱스에 남습니다 |
| Staged 행 | `"all"` | `git restore --source=HEAD --staged --worktree -- <files>` | A와 B가 모두 사라집니다 |
| 선택분 일괄 | 누른 영역을 따릅니다 | 위와 같습니다 | |

기술적 차이는 `--source` 플래그 하나입니다. `--source` 가 없으면 git은 **인덱스**를
기준으로 삼고, `--source=HEAD` 면 마지막 커밋을 기준으로 삼습니다.

추적되지 않는 파일은 되돌릴 원본이 없어서 어느 모드에서나 `git clean -fd` 로 삭제합니다.

### 왜 레퍼런스와 다르게 했는가

1. **화면이 영역을 나눠 그립니다.** GitKraken은 변경 파일 목록이 영역 구분 없이 하나라
   "이 파일을 되돌린다"는 의미가 애매하지 않습니다. 우리 패널은 Unstaged와 Staged를
   시각적으로 갈라 놓아서, Unstaged 섹션의 버튼이 staged 변경까지 지우면 화면이 말한
   것과 동작이 어긋납니다.
2. **커밋하지 않은 변경은 복구 수단이 없습니다.** reflog는 커밋된 것만 기억합니다.
   되돌릴 수 없는 동작에서 기대와 동작이 어긋나면 그 대가가 영구적입니다.

### 검토했지만 택하지 않은 대안

- **확인 다이얼로그 문구로만 해결.** 문구는 실제로 area별로 다르게 넣었지만
  (`actions.ts`의 `discard`), 그것만으로 덮기에는 기대와 동작의 간극이 크다고 봤습니다.
  다이얼로그는 반복되면 습관적으로 넘기게 됩니다.
버튼 이름을 영역별로 다르게 하는 것은 대안이 아니라 함께 넣었습니다. `WipDetailPanel.tsx`
에서 Unstaged 행은 `Discard working tree changes in <path>`, Staged 행은
`Discard staged and unstaged changes in <path>` 입니다. 동작을 가르는 것과 이름을 가르는
것은 서로를 대체하지 않습니다.

### 알려진 반론

이 결정이 무조건 옳다고 보지는 않습니다. 뒤집을 때 다시 읽으라고 남깁니다.

1. **레퍼런스와 다르면 그것대로 사고가 납니다.** GitKraken을 쓰던 사람이 Unstaged 행을
   discard하고 전부 지워졌다고 여겼는데 staged가 남아 있으면, 모른 채 커밋할 수 있습니다.
   방향이 반대일 뿐 사고는 사고입니다.
2. **"Discard"라는 단어가 부분 되돌리기를 뜻하지 않습니다.** 버린다는 말은 전부를
   함의합니다. 부분만 되돌린다면 다른 이름이 맞을 수도 있습니다.

### 되돌리는 방법

레퍼런스대로 통일하려면 세 곳을 고칩니다.

1. `src-tauri/src/ops/stage.rs` 의 `git_discard` 에서 `"worktree"` 분기를 `"all"` 과 같게
2. `discard_worktree는_스테이지된_변경을_남긴다` 와
   `discard_worktree는_인덱스를_기준으로_되돌린다` 테스트 제거
3. `src/shell/WipDetailPanel.tsx` 에서 area를 구분해 넘기는 부분을 `"all"` 고정으로

`src/types.ts` 의 `DiscardArea` 와 `actions.ts` 의 선택 인자는 남겨둬도 무해합니다.

### 이 결정을 지키는 것

`discard_worktree는_스테이지된_변경을_남긴다` (`src-tauri/src/ops/stage.rs`) 입니다.

구현 차이가 `--source` 플래그 하나라서, 코드만 보면 "왜 한쪽만 `--source` 가 없지,
일관성이 없네" 로 읽히기 쉽습니다. 정리하는 김에 붙이면 스테이지된 변경이 조용히
사라지기 시작하고 원인을 찾기 어렵습니다. 주석은 지워질 수 있지만 실패하는 테스트는
지나치기 어렵습니다.

이 테스트는 `git diff --cached` 와 `git diff` 를 따로 읽어 양쪽을 각각 단언하고,
호출 전에 파일이 정말 두 영역에 다 있는지도 확인합니다. `"worktree"` 분기에 일부러
`--source=HEAD --staged` 를 주입하면 실제로 실패하는 것을 확인했습니다.

## discard 되돌리기

**결정**: v0.24부터 discard(파일, hunk, 줄)와 untracked 삭제를 Undo(⌘Z)로 되돌립니다. 버리기 직전과 직후의 파일 내용을 git tree로 찍어 두고, 되돌릴 때 직전 내용을 다시 씁니다. 확인창은 그대로 둡니다.

| 단계 | 하는 일 | 코드 |
|---|---|---|
| 찍기 | 인덱스 `write-tree`, 인덱스 사본에 대상 경로 `add -A` 후 `write-tree` | `src-tauri/src/ops/discard_undo.rs` `get_work_snapshot` |
| 기록 | discard 전후 스냅샷을 `UndoEntry.discard`에 담아 스택에 쌓기 | `src/shell/actions.ts` `run`의 `undo.discard` |
| 되돌리기 | 대상 경로가 직후 스냅샷과 같을 때만 직전 내용으로 `restore` | `discard_undo.rs` `undo_discard` |

### 왜 `git stash create`가 아닌가

`stash create`는 워킹 트리를 건드리지 않고 커밋을 만들어 주지만 untracked 파일을 담지 못합니다. `-u`를 붙일 수 있는 `stash push`는 워킹 트리를 바꿉니다. untracked 삭제가 되돌릴 수 없는 작업 중 가장 아픈 것이라, 인덱스 사본에 `add -A`하는 방식을 골랐습니다. 실제 인덱스는 움직이지 않습니다.

### 그 사이 파일을 고쳤으면 되돌리지 않는다

discard한 뒤 같은 파일을 다시 고쳤다면, 되살리는 순간 그 수정이 사라집니다. 그래서 대상 경로의 지금 내용이 discard 직후와 다르면 아무것도 하지 않고 이유를 알립니다. 다른 파일을 고친 것은 상관없습니다. ref 되돌리기가 "이 작업이 바꾼 ref만 본다"는 규칙과 같습니다.

### 한계

- 레포를 바꾸면 스택을 비웁니다. 앱을 다시 켜도 사라집니다
- tree 객체는 어느 ref에도 걸리지 않습니다. `git gc --prune=now`를 직접 돌리면 되살릴 내용이 지워집니다. 기본 `gc`는 2주를 기다립니다
- 아주 큰 untracked 파일을 지울 때는 찍는 동안 그 파일을 한 번 해시합니다
- 충돌 중(unmerged 인덱스)에는 `write-tree`가 실패해 되돌리기를 남기지 않습니다. discard는 그대로 합니다

### 이 결정을 지키는 것

`src-tauri/src/ops/discard_undo.rs` 테스트 10개입니다. 특히 `discard_뒤에_파일을_고쳤으면_되돌리지_않는다`와 `스냅샷은_실제_인덱스를_건드리지_않는다`가 위 두 규칙을 지킵니다.

