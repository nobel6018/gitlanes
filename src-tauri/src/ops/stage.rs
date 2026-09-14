//! 인덱스를 만지는 작업. WIP 패널이 제일 많이 부르는 경로다.
//!
//! @see CONTRACTS.md

use crate::git;
use crate::model::OpResult;

use super::run::{lines_of, run_op, run_op_with_input, validate_paths, LOCAL_TIMEOUT};

/// 인덱스에 올린다. 추적되지 않는 파일도 `add`가 그대로 받는다.
#[tauri::command]
pub fn git_stage(path: String, files: Vec<String>) -> Result<OpResult, String> {
    let files = validate_paths(&files)?;
    let mut args: Vec<&str> = vec!["add", "--"];
    args.extend(files.iter().map(String::as_str));
    run_op(&path, &args, LOCAL_TIMEOUT)
}

/// 인덱스에서 내린다. 워킹 트리는 건드리지 않는다.
#[tauri::command]
pub fn git_unstage(path: String, files: Vec<String>) -> Result<OpResult, String> {
    let files = validate_paths(&files)?;
    let mut args: Vec<&str> = vec!["restore", "--staged", "--"];
    args.extend(files.iter().map(String::as_str));
    run_op(&path, &args, LOCAL_TIMEOUT)
}

/// 변경을 버린다. `area`가 무엇을 얼마나 버릴지 가른다.
///
/// | `area` | 추적 파일 | 기준 |
/// |---|---|---|
/// | `"worktree"` | `restore --worktree` | **인덱스**. 스테이지된 변경은 살아남는다 |
/// | `"all"` | `restore --source=HEAD --staged --worktree` | **HEAD**. 전부 사라진다 |
///
/// 두 모드를 나눈 이유는 WIP 패널이 Unstaged와 Staged를 눈에 보이게 갈라 놓기 때문이다.
/// Unstaged 행의 되돌리기 버튼이 스테이지된 변경까지 지우면 사용자가 읽은 화면과
/// 동작이 어긋난다. 그 간극은 확인 다이얼로그 문구로 덮을 수 있는 크기가 아니다.
///
/// 추적되지 않는 파일은 되돌릴 원본이 없어서 어느 모드에서나 삭제다.
/// 되돌릴 방법이 없는 작업이라 UI에서 확인 다이얼로그를 반드시 거친다.
///
/// 레퍼런스 앱(GitKraken, SourceGit)에는 이 구분이 없다. 왜 다르게 했는지와
/// 되돌리는 방법은 @see docs/decisions.md#discard-범위
#[tauri::command]
pub fn git_discard(path: String, files: Vec<String>, area: String) -> Result<OpResult, String> {
    // `--source` 없이 쓰면 git이 인덱스를 기준으로 삼는다. 그게 "worktree"의 정의다.
    let restore: &[&str] = match area.as_str() {
        "worktree" => &["restore", "--worktree", "--"],
        "all" => &["restore", "--source=HEAD", "--staged", "--worktree", "--"],
        other => return Err(format!("알 수 없는 discard 범위입니다: {other}")),
    };

    let files = validate_paths(&files)?;
    let untracked = untracked_set(&path);
    let (fresh, tracked): (Vec<&String>, Vec<&String>) =
        files.iter().partition(|file| untracked.contains(*file));

    let mut steps: Vec<Vec<&str>> = Vec::new();
    if !tracked.is_empty() {
        let mut args: Vec<&str> = restore.to_vec();
        args.extend(tracked.iter().map(|file| file.as_str()));
        steps.push(args);
    }
    if !fresh.is_empty() {
        let mut args: Vec<&str> = vec!["clean", "-q", "-fd", "--"];
        args.extend(fresh.iter().map(|file| file.as_str()));
        steps.push(args);
    }

    super::run::run_chain(&path, &steps, LOCAL_TIMEOUT)
}

/// 추적되지 않는 파일 경로 집합. `git_discard`가 되돌릴지 지울지 가르는 데 쓴다.
fn untracked_set(repo: &str) -> std::collections::HashSet<String> {
    git::run(repo, &["ls-files", "--others", "--exclude-standard"])
        .map(|out| lines_of(&out).into_iter().collect())
        .unwrap_or_default()
}

#[tauri::command]
pub fn git_stage_all(path: String) -> Result<OpResult, String> {
    run_op(&path, &["add", "-A"], LOCAL_TIMEOUT)
}

/// 인덱스 전체를 HEAD로 되돌린다. 워킹 트리는 그대로다.
#[tauri::command]
pub fn git_unstage_all(path: String) -> Result<OpResult, String> {
    run_op(&path, &["reset", "-q", "HEAD", "--"], LOCAL_TIMEOUT)
}

/// 추적되지 않는 파일을 지운다. 경로 지정을 강제해 "전부 삭제" 사고를 막는다.
#[tauri::command]
pub fn git_clean(path: String, paths: Vec<String>) -> Result<OpResult, String> {
    let paths = validate_paths(&paths)?;
    let mut args: Vec<&str> = vec!["clean", "-q", "-fd", "--"];
    args.extend(paths.iter().map(String::as_str));
    run_op(&path, &args, LOCAL_TIMEOUT)
}

/// hunk/line 단위 스테이징의 유일한 원시 연산.
///
/// | 하려는 것 | cached | reverse |
/// |---|---|---|
/// | 선택한 hunk를 스테이지 | true | false |
/// | 스테이지된 hunk를 내리기 | true | true |
/// | 워킹 트리에서 되돌리기 | false | true |
///
/// 패치는 **stdin으로** 넘긴다. 임시 파일을 쓰면 경로 인코딩, 권한, 정리 실패가 전부
/// 새로운 실패 지점이 된다.
///
/// `--unidiff-zero`는 프론트가 재구성한 패치에 문맥 줄이 0개일 수 있어서 필요하다.
/// git은 문맥 0인 패치를 기본적으로 거부한다(적용 위치를 추정할 수 없다고 본다).
/// `--whitespace=nowarn`은 원본에 이미 있던 공백 문제로 스테이징이 실패하지 않게 한다.
#[tauri::command]
pub fn git_apply_patch(
    path: String,
    patch: String,
    cached: bool,
    reverse: bool,
) -> Result<OpResult, String> {
    if patch.trim().is_empty() {
        return Err("패치가 비어 있습니다".to_string());
    }

    let mut args: Vec<&str> = vec!["apply", "--unidiff-zero", "--whitespace=nowarn"];
    if cached {
        args.push("--cached");
    }
    if reverse {
        args.push("--reverse");
    }
    // "-"는 stdin을 읽으라는 뜻이다. 생략해도 같지만 명시해 두면 command 배열을 그대로
    // 터미널에 넘겼을 때 무엇을 기다리는 명령인지 드러난다.
    args.push("-");

    // git apply는 마지막 줄에 개행이 없으면 "corrupt patch"로 끝난다
    let body = if patch.ends_with('\n') {
        patch
    } else {
        format!("{patch}\n")
    };

    run_op_with_input(&path, &args, LOCAL_TIMEOUT, body.into_bytes())
}

/// 패치 파일을 적용한다. `git_apply_patch`와 달리 디스크의 파일을 읽는다.
#[tauri::command]
pub fn git_apply_patch_file(
    path: String,
    file: String,
    three_way: bool,
) -> Result<OpResult, String> {
    let file = validate_paths(&[file])?.remove(0);
    let mut args: Vec<&str> = vec!["apply", "--whitespace=nowarn"];
    if three_way {
        args.push("--3way");
    }
    args.push("--");
    args.push(file.as_str());
    run_op(&path, &args, LOCAL_TIMEOUT)
}

/// 선택한 커밋들을 `.patch` 파일로 뽑는다.
///
/// `format-patch`는 여러 sha를 한 번에 받으면 "이 커밋들로부터 도달 가능한 범위"로
/// 해석해서 원하는 것과 달라진다. 커밋 하나씩 `-1`로 뽑고 `--start-number`로 번호만
/// 이어 붙인다.
#[tauri::command]
pub fn git_create_patch(
    path: String,
    shas: Vec<String>,
    out_dir: String,
) -> Result<OpResult, String> {
    if shas.is_empty() {
        return Err("대상 커밋이 없습니다".to_string());
    }
    let out_dir = validate_paths(&[out_dir])?.remove(0);
    let shas: Vec<String> = shas
        .iter()
        .map(|sha| super::run::validate_commitish(&path, sha))
        .collect::<Result<_, _>>()?;

    let numbers: Vec<String> = (1..=shas.len()).map(|n| n.to_string()).collect();
    let steps: Vec<Vec<&str>> = shas
        .iter()
        .zip(numbers.iter())
        .map(|(sha, number)| {
            vec![
                "format-patch",
                "-o",
                out_dir.as_str(),
                "-1",
                "--start-number",
                number.as_str(),
                sha.as_str(),
            ]
        })
        .collect();

    super::run::run_chain(&path, &steps, LOCAL_TIMEOUT)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testrepo::TempRepo;

    /// 커밋 하나와 그 위의 변경 하나를 가진 저장소.
    fn dirty() -> TempRepo {
        let repo = TempRepo::init("gitlanes-stage");
        repo.write("a.txt", "1\n");
        repo.write("b.txt", "b\n");
        repo.git(&["add", "-A"]);
        repo.git(&["commit", "-qm", "base"]);
        repo.write("a.txt", "changed\n");
        repo.write("fresh.txt", "new\n");
        repo
    }

    fn staged_files(repo: &TempRepo) -> Vec<String> {
        lines_of(&git::run(repo.path(), &["diff", "--cached", "--name-only"]).unwrap())
    }

    /// 인덱스에 올라가지 않은 추적 파일 변경. `git diff`와 같다.
    fn unstaged_files(repo: &TempRepo) -> Vec<String> {
        lines_of(&git::run(repo.path(), &["diff", "--name-only"]).unwrap())
    }

    fn exists(repo: &TempRepo, name: &str) -> bool {
        std::path::Path::new(&repo.path()).join(name).exists()
    }

    #[test]
    fn stage와_unstage가_왕복한다() {
        let repo = dirty();

        let staged = git_stage(repo.path(), vec!["a.txt".to_string()]).unwrap();
        assert!(staged.ok, "{staged:?}");
        assert_eq!(staged.command, ["add", "--", "a.txt"]);
        assert_eq!(staged_files(&repo), ["a.txt"]);

        let unstaged = git_unstage(repo.path(), vec!["a.txt".to_string()]).unwrap();
        assert!(unstaged.ok, "{unstaged:?}");
        assert!(staged_files(&repo).is_empty());
    }

    #[test]
    fn 빈_파일_목록은_호출_오류다() {
        let repo = dirty();
        assert!(git_stage(repo.path(), vec![]).is_err());
        assert!(git_unstage(repo.path(), vec![]).is_err());
        assert!(git_discard(repo.path(), vec![], "all".to_string()).is_err());
        assert!(git_clean(repo.path(), vec![]).is_err());
        // 옵션처럼 보이는 경로도 막는다
        assert!(git_stage(repo.path(), vec!["--all".to_string()]).is_err());
    }

    #[test]
    fn stage_all과_unstage_all이_전체를_옮긴다() {
        let repo = dirty();

        assert!(git_stage_all(repo.path()).unwrap().ok);
        let mut staged = staged_files(&repo);
        staged.sort();
        assert_eq!(staged, ["a.txt", "fresh.txt"]);

        assert!(git_unstage_all(repo.path()).unwrap().ok);
        assert!(staged_files(&repo).is_empty());
        // 워킹 트리는 그대로다
        assert!(exists(&repo, "fresh.txt"));
    }

    fn read(repo: &TempRepo, name: &str) -> String {
        std::fs::read_to_string(std::path::Path::new(&repo.path()).join(name)).unwrap()
    }

    #[test]
    fn discard_all은_추적_파일을_head로_되돌리고_새_파일은_지운다() {
        let repo = dirty();
        // 스테이지까지 해 둔 변경도 함께 사라져야 한다
        assert!(
            git_stage(repo.path(), vec!["a.txt".to_string()])
                .unwrap()
                .ok
        );

        let result = git_discard(
            repo.path(),
            vec!["a.txt".to_string(), "fresh.txt".to_string()],
            "all".to_string(),
        )
        .unwrap();
        assert!(result.ok, "{result:?}");

        assert_eq!(read(&repo, "a.txt"), "1\n");
        assert!(!exists(&repo, "fresh.txt"));
        assert!(staged_files(&repo).is_empty());
    }

    #[test]
    fn discard_worktree는_인덱스를_기준으로_되돌린다() {
        let repo = dirty();

        // 추적 파일만 넘겨 restore 인자를 그대로 확인한다. 새 파일이 섞이면 clean이
        // 뒤에 붙고, run_chain은 마지막으로 실행한 명령을 command에 담는다.
        let tracked = git_discard(
            repo.path(),
            vec!["a.txt".to_string()],
            "worktree".to_string(),
        )
        .unwrap();
        assert!(tracked.ok, "{tracked:?}");
        assert_eq!(tracked.command, ["restore", "--worktree", "--", "a.txt"]);

        // 인덱스가 비어 있으면 인덱스 = HEAD라 결과는 HEAD 복귀와 같다
        assert_eq!(read(&repo, "a.txt"), "1\n");

        // untracked는 어느 모드에서나 삭제다
        let fresh = git_discard(
            repo.path(),
            vec!["fresh.txt".to_string()],
            "worktree".to_string(),
        )
        .unwrap();
        assert!(fresh.ok, "{fresh:?}");
        assert_eq!(fresh.command[0], "clean");
        assert!(!exists(&repo, "fresh.txt"));
    }

    /// 이 테스트가 `area` 인자를 나눈 이유 전부다.
    ///
    /// 한 파일에 스테이지된 변경과 그 위의 추가 변경이 함께 있을 때, WIP 패널의
    /// Unstaged 행에서 되돌리기를 누르면 스테이지된 쪽은 살아 있어야 한다.
    #[test]
    fn discard_worktree는_스테이지된_변경을_남긴다() {
        let repo = dirty();

        // 1 -> 2를 스테이지하고, 그 위에 3을 워킹 트리에만 얹는다
        repo.write("a.txt", "2\n");
        assert!(
            git_stage(repo.path(), vec!["a.txt".to_string()])
                .unwrap()
                .ok
        );
        repo.write("a.txt", "3\n");

        // 시작 상태 확인: 같은 파일이 staged와 unstaged 양쪽에 있다
        assert_eq!(staged_files(&repo), ["a.txt"]);
        assert_eq!(unstaged_files(&repo), ["a.txt"]);

        let result = git_discard(
            repo.path(),
            vec!["a.txt".to_string()],
            "worktree".to_string(),
        )
        .unwrap();
        assert!(result.ok, "{result:?}");

        // 인덱스는 그대로다. 여기가 --source=HEAD를 붙이면 깨지는 지점이다.
        assert_eq!(
            staged_files(&repo),
            ["a.txt"],
            "worktree 모드가 스테이지된 변경을 지웠다"
        );
        // 워킹 트리 쪽 변경만 사라졌다
        assert!(
            unstaged_files(&repo).is_empty(),
            "unstaged 변경이 남았다: {:?}",
            unstaged_files(&repo)
        );
        // 파일은 HEAD의 "1"이 아니라 스테이지한 "2"다
        assert_eq!(read(&repo, "a.txt"), "2\n");

        // 같은 상황에 all을 걸면 양쪽이 모두 사라진다
        repo.write("a.txt", "3\n");
        assert_eq!(
            unstaged_files(&repo),
            ["a.txt"],
            "다시 양쪽에 변경을 만든다"
        );

        let all = git_discard(repo.path(), vec!["a.txt".to_string()], "all".to_string()).unwrap();
        assert!(all.ok, "{all:?}");
        assert!(staged_files(&repo).is_empty(), "all인데 인덱스가 남았다");
        assert!(
            unstaged_files(&repo).is_empty(),
            "all인데 워킹 트리가 남았다"
        );
        assert_eq!(read(&repo, "a.txt"), "1\n");
    }

    #[test]
    fn discard는_없는_파일과_모르는_범위에서_실패한다() {
        let repo = dirty();

        let result =
            git_discard(repo.path(), vec!["nope.txt".to_string()], "all".to_string()).unwrap();
        assert!(!result.ok, "{result:?}");
        assert!(!result.stderr.is_empty(), "{result:?}");

        // 범위 오타는 파일을 건드리기 전에 막는다
        assert!(git_discard(repo.path(), vec!["a.txt".to_string()], "index".to_string()).is_err());
        assert!(git_discard(repo.path(), vec!["a.txt".to_string()], String::new()).is_err());
        assert_eq!(
            read(&repo, "a.txt"),
            "changed\n",
            "거부된 호출이 파일을 건드렸다"
        );
    }

    #[test]
    fn clean은_지정한_경로의_untracked만_지운다() {
        let repo = dirty();
        repo.write("keep.txt", "keep\n");

        let result = git_clean(repo.path(), vec!["fresh.txt".to_string()]).unwrap();
        assert!(result.ok, "{result:?}");
        assert!(!exists(&repo, "fresh.txt"));
        assert!(exists(&repo, "keep.txt"));
    }

    /// 파일 두 군데를 고친 뒤 한 hunk만 스테이지한다. hunk 단위 스테이징의 핵심 시나리오다.
    #[test]
    fn apply_patch는_고른_hunk만_인덱스에_올린다() {
        let repo = TempRepo::init("gitlanes-hunk");
        let original: String = (1..=20).map(|i| format!("line {i}\n")).collect();
        repo.write("f.txt", &original);
        repo.git(&["add", "-A"]);
        repo.git(&["commit", "-qm", "base"]);

        // 위쪽과 아래쪽을 각각 고쳐 hunk 두 개를 만든다
        let changed = original
            .replace("line 2\n", "line 2 위쪽 수정\n")
            .replace("line 18\n", "line 18 아래쪽 수정\n");
        repo.write("f.txt", &changed);

        let diff = git::run(repo.path(), &["diff", "--", "f.txt"]).unwrap();
        let hunks: Vec<&str> = diff.split("\n@@").collect();
        assert_eq!(hunks.len(), 3, "hunk 두 개를 기대했다:\n{diff}");

        // 헤더 + 첫 hunk만 남긴 패치를 재구성한다
        let patch = format!("{}\n@@{}", hunks[0], hunks[1]);

        let result = git_apply_patch(repo.path(), patch, true, false).unwrap();
        assert!(result.ok, "{result:?}");
        assert!(result.command.contains(&"--cached".to_string()));

        let cached = git::run(repo.path(), &["diff", "--cached"]).unwrap();
        assert!(cached.contains("line 2 위쪽 수정"), "{cached}");
        assert!(
            !cached.contains("line 18 아래쪽 수정"),
            "고르지 않은 hunk가 딸려 들어왔다:\n{cached}"
        );

        // 워킹 트리에는 두 변경이 모두 남아 있다
        let unstaged = git::run(repo.path(), &["diff"]).unwrap();
        assert!(unstaged.contains("line 18 아래쪽 수정"), "{unstaged}");
    }

    #[test]
    fn apply_patch는_reverse로_인덱스에서_내린다() {
        let repo = TempRepo::init("gitlanes-hunk-reverse");
        repo.write("f.txt", "a\n");
        repo.git(&["add", "-A"]);
        repo.git(&["commit", "-qm", "base"]);
        repo.write("f.txt", "b\n");
        repo.git(&["add", "-A"]);

        let staged_diff = git::run(repo.path(), &["diff", "--cached"]).unwrap();
        let result = git_apply_patch(repo.path(), staged_diff, true, true).unwrap();
        assert!(result.ok, "{result:?}");
        assert!(result.command.contains(&"--reverse".to_string()));
        assert!(git::run(repo.path(), &["diff", "--cached"])
            .unwrap()
            .is_empty());
    }

    #[test]
    fn 깨진_패치는_ok_false로_돌아온다() {
        let repo = dirty();
        let result =
            git_apply_patch(repo.path(), "이건 패치가 아니다\n".to_string(), true, false).unwrap();
        assert!(!result.ok, "{result:?}");
        assert!(!result.stderr.is_empty(), "{result:?}");
        assert!(!result.needs_auth);

        assert!(git_apply_patch(repo.path(), "   ".to_string(), true, false).is_err());
    }

    #[test]
    fn create_patch와_apply_patch_file이_이어진다() {
        let repo = TempRepo::init("gitlanes-format-patch");
        repo.write("f.txt", "a\n");
        repo.git(&["add", "-A"]);
        repo.git(&["commit", "-qm", "base"]);
        repo.write("f.txt", "b\n");
        repo.git(&["add", "-A"]);
        repo.git(&["commit", "-qm", "두 번째"]);

        let out_dir = format!("{}/patches", repo.path());
        let head = repo.rev("HEAD");
        let made = git_create_patch(repo.path(), vec![head], out_dir.clone()).unwrap();
        assert!(made.ok, "{made:?}");

        let files: Vec<_> = std::fs::read_dir(&out_dir).unwrap().flatten().collect();
        assert_eq!(files.len(), 1, "패치 파일 하나가 나와야 한다");
        let patch_file = files[0].path().to_string_lossy().into_owned();

        // 커밋을 되돌린 뒤 패치로 다시 올린다
        repo.git(&["reset", "-q", "--hard", "HEAD~1"]);
        let applied = git_apply_patch_file(repo.path(), patch_file, false).unwrap();
        assert!(applied.ok, "{applied:?}");
        assert_eq!(
            std::fs::read_to_string(std::path::Path::new(&repo.path()).join("f.txt")).unwrap(),
            "b\n"
        );
    }

    #[test]
    fn create_patch는_빈_목록과_없는_커밋을_거부한다() {
        let repo = dirty();
        let out = format!("{}/out", repo.path());
        assert!(git_create_patch(repo.path(), vec![], out.clone()).is_err());
        assert!(git_create_patch(repo.path(), vec!["없는커밋".to_string()], out).is_err());
    }
}
