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

/// 변경을 버린다. **파일을 HEAD 상태로 되돌린다**(인덱스와 워킹 트리 양쪽).
///
/// 스테이지된 변경만 남은 파일을 버릴 때도 사용자가 기대하는 결과가 "HEAD로 복귀"라
/// 한쪽만 되돌리지 않는다. 추적되지 않는 파일은 되돌릴 원본이 없으니 지운다.
/// 되돌릴 방법이 없는 작업이라 UI에서 확인 다이얼로그를 반드시 거친다.
#[tauri::command]
pub fn git_discard(path: String, files: Vec<String>) -> Result<OpResult, String> {
    let files = validate_paths(&files)?;
    let untracked = untracked_set(&path);
    let (fresh, tracked): (Vec<&String>, Vec<&String>) =
        files.iter().partition(|file| untracked.contains(*file));

    let mut steps: Vec<Vec<&str>> = Vec::new();
    if !tracked.is_empty() {
        let mut args: Vec<&str> = vec!["restore", "--source=HEAD", "--staged", "--worktree", "--"];
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
        assert!(git_discard(repo.path(), vec![]).is_err());
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

    #[test]
    fn discard는_추적_파일을_head로_되돌리고_새_파일은_지운다() {
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
        )
        .unwrap();
        assert!(result.ok, "{result:?}");

        assert_eq!(
            std::fs::read_to_string(std::path::Path::new(&repo.path()).join("a.txt")).unwrap(),
            "1\n"
        );
        assert!(!exists(&repo, "fresh.txt"));
        assert!(staged_files(&repo).is_empty());
    }

    #[test]
    fn discard는_없는_파일에서_실패를_그대로_전한다() {
        let repo = dirty();
        let result = git_discard(repo.path(), vec!["nope.txt".to_string()]).unwrap();
        assert!(!result.ok, "{result:?}");
        assert!(!result.stderr.is_empty(), "{result:?}");
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
