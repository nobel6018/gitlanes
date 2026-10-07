//! 인덱스를 만지는 작업. WIP 패널이 제일 많이 부르는 경로다.
//!
//! @see CONTRACTS.md

use crate::git;
use crate::model::OpResult;

use super::run::{run_op, run_op_with_input, validate_paths, LOCAL_TIMEOUT};

/// 인덱스에 올린다. 추적되지 않는 파일도 `add`가 그대로 받는다.
#[tauri::command(async)]
pub fn git_stage(path: String, files: Vec<String>) -> Result<OpResult, String> {
    let files = validate_paths(&files)?;
    let mut args: Vec<&str> = vec!["add", "--"];
    args.extend(files.iter().map(String::as_str));
    run_op(&path, &args, LOCAL_TIMEOUT)
}

/// 인덱스에서 내린다. 워킹 트리는 건드리지 않는다.
///
/// 스테이지된 rename은 새 경로만 와도 원 경로를 함께 내린다([`with_rename_sources`]).
/// 첫 커밋 전에는 `restore --staged`가 기준으로 삼을 HEAD가 없어 `rm --cached`로 내린다.
#[tauri::command(async)]
pub fn git_unstage(path: String, files: Vec<String>) -> Result<OpResult, String> {
    let files = with_rename_sources(&path, validate_paths(&files)?);
    let head: &[&str] = if head_exists(&path) {
        &["restore", "--staged", "--"]
    } else {
        &["rm", "--cached", "-q", "--"]
    };
    let mut args: Vec<&str> = head.to_vec();
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
#[tauri::command(async)]
pub fn git_discard(path: String, files: Vec<String>, area: String) -> Result<OpResult, String> {
    // `--source` 없이 쓰면 git이 인덱스를 기준으로 삼는다. 그게 "worktree"의 정의다.
    // 첫 커밋 전의 "all"은 기준인 HEAD가 비어 있다. 그때 추적 파일은 전부 새로 add한 파일이고,
    // HEAD가 있는 레포에서 새로 add한 파일을 "all"로 버리면 인덱스와 워킹 트리에서
    // 사라진다. `rm -f`가 같은 결과를 낸다. 스테이지한 내용이 blob으로 남아
    // `git fsck --lost-found`로 찾을 수 있는 것도 같다.
    let restore: &[&str] = match area.as_str() {
        "worktree" => &["restore", "--worktree", "--"],
        "all" if head_exists(&path) => {
            &["restore", "--source=HEAD", "--staged", "--worktree", "--"]
        }
        "all" => &["rm", "-q", "-f", "--"],
        other => return Err(format!("알 수 없는 discard 범위입니다: {other}")),
    };

    let files = validate_paths(&files)?;
    // rename의 원 경로는 "all"에서만 함께 되돌린다. "worktree"는 인덱스가 기준이라 스테이지된
    // rename 자체는 건드리지 않는 것이 맞다.
    let files = if area == "all" {
        with_rename_sources(&path, files)
    } else {
        files
    };
    let untracked = Untracked::of(&path);
    let (fresh, tracked): (Vec<&String>, Vec<&String>) =
        files.iter().partition(|file| untracked.contains(file));
    reject_submodules(&path, &tracked)?;

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

/// 추적되지 않는 경로. `git_discard`가 되돌릴지 지울지 가르는 데 쓴다.
///
/// `-z`로 받아 `\0`로만 나눈다. 줄 단위로 읽고 trim하면 ` a.txt`가 `a.txt`로 바뀌어
/// untracked 판정에서 빠지고, clean 대신 restore로 가서 아무것도 안 지운 채 성공한다.
/// 개행이나 따옴표가 든 파일 이름도 `-z`여야 C 인용 없이 그대로 온다.
///
/// `--directory`는 status가 `?? newdir/`로 접어 보여 주는 디렉토리를 같은 모양으로 받으려고
/// 붙인다. 그러면 펼친 경로(`newdir/x.txt`)는 목록에 없으니, 접힌 디렉토리 아래 경로도
/// untracked로 본다. WIP 목록(`get_wip_details`)은 펼친 경로를 넘기므로 두 모양을 다 받는다.
struct Untracked {
    entries: std::collections::HashSet<String>,
    dirs: Vec<String>,
}

impl Untracked {
    fn of(repo: &str) -> Self {
        let out = git::run(
            repo,
            &[
                "ls-files",
                "-z",
                "--others",
                "--exclude-standard",
                "--directory",
                "--no-empty-directory",
            ],
        )
        .unwrap_or_default();
        let entries: std::collections::HashSet<String> = out
            .split('\0')
            .filter(|path| !path.is_empty())
            .map(str::to_string)
            .collect();
        let dirs = entries
            .iter()
            .filter(|path| path.ends_with('/'))
            .cloned()
            .collect();
        Self { entries, dirs }
    }

    fn contains(&self, file: &str) -> bool {
        self.entries.contains(file)
            || self.entries.contains(&format!("{file}/"))
            || self.dirs.iter().any(|dir| file.starts_with(dir.as_str()))
    }
}

/// 첫 커밋 전(unborn HEAD)이면 false.
pub(crate) fn head_exists(repo: &str) -> bool {
    git::run(repo, &["rev-parse", "--verify", "-q", "HEAD"]).is_ok()
}

/// 스테이지된 rename 쌍 `(원 경로, 새 경로)`. WIP 목록과 같은 `diff --cached -M`으로 짝을 찾는다.
///
/// 인덱스 전체를 본다. pathspec으로 좁히면 짝의 한쪽이 빠져 rename으로 잡히지 않는다.
pub(crate) fn staged_renames(repo: &str) -> Vec<(String, String)> {
    let Ok(out) = git::run(
        repo,
        &[
            "diff",
            "--cached",
            "-M",
            "--name-status",
            "--no-ext-diff",
            "-z",
        ],
    ) else {
        return Vec::new();
    };
    let mut fields = out.split('\0');
    let mut pairs = Vec::new();
    while let Some(status) = fields.next() {
        if status.is_empty() {
            continue;
        }
        // R와 C 뒤에는 경로가 둘(원, 새), 나머지는 하나다
        if status.starts_with('R') || status.starts_with('C') {
            let (Some(old), Some(new)) = (fields.next(), fields.next()) else {
                break;
            };
            // copy는 원 경로가 그대로 살아 있어 함께 되돌릴 대상이 아니다
            if status.starts_with('R') {
                pairs.push((old.to_string(), new.to_string()));
            }
        } else {
            fields.next();
        }
    }
    pairs
}

/// rename의 한쪽만 와도 다른 쪽을 덧붙인다. 프론트는 rename 행에서 새 경로만 넘긴다.
///
/// 새 경로만 내리면 인덱스에 원 경로의 삭제(`D old.txt`)가 남는다. 사용자는 전부 내린 줄
/// 아는데 그 파일 삭제가 다음 커밋에 실린다.
fn with_rename_sources(repo: &str, files: Vec<String>) -> Vec<String> {
    let mut files = files;
    for (old, new) in staged_renames(repo) {
        let has_old = files.contains(&old);
        let has_new = files.contains(&new);
        if has_new && !has_old {
            files.push(old);
        } else if has_old && !has_new {
            files.push(new);
        }
    }
    files
}

/// 서브모듈 경로가 섞여 있으면 아무것도 하지 않고 거절한다.
///
/// `restore`는 상위 레포의 gitlink만 보고 서브모듈 안의 체크아웃은 건드리지 않는다.
/// 그래서 0으로 끝나는데 화면의 ` M sub`는 그대로라, 성공 토스트가 사실과 다르다.
/// 서브모듈 안을 되돌리는 일은 서브모듈의 HEAD와 브랜치를 움직이는 별개 작업이라
/// discard 확인 다이얼로그 하나로 맡기지 않는다.
fn reject_submodules(repo: &str, tracked: &[&String]) -> Result<(), String> {
    if tracked.is_empty() {
        return Ok(());
    }
    let mut args: Vec<&str> = vec!["ls-files", "-z", "--stage", "--"];
    args.extend(tracked.iter().map(|file| file.as_str()));
    let out = git::run(repo, &args).unwrap_or_default();
    // 한 항목은 "<mode> <sha> <stage>\t<path>"다. gitlink의 mode가 160000이다
    let submodule = out
        .split('\0')
        .filter(|entry| entry.starts_with("160000 "))
        .find_map(|entry| entry.split_once('\t').map(|(_, path)| path.to_string()));
    match submodule {
        Some(path) => Err(format!(
            "Discarding changes in a submodule is not supported: {path}. Run `git submodule update --init -- {path}` in the terminal to return it to the recorded commit."
        )),
        None => Ok(()),
    }
}

#[tauri::command(async)]
pub fn git_stage_all(path: String) -> Result<OpResult, String> {
    run_op(&path, &["add", "-A"], LOCAL_TIMEOUT)
}

/// 인덱스 전체를 HEAD로 되돌린다. 워킹 트리는 그대로다.
#[tauri::command(async)]
pub fn git_unstage_all(path: String) -> Result<OpResult, String> {
    run_op(&path, &["reset", "-q", "HEAD", "--"], LOCAL_TIMEOUT)
}

/// 추적되지 않는 파일을 지운다. 경로 지정을 강제해 "전부 삭제" 사고를 막는다.
#[tauri::command(async)]
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
/// `--unidiff-zero`는 쓰지 않는다. 그 옵션은 context 없는 패치를 받으려고 git의 위치
/// 검증("뒤쪽 context가 없는 hunk는 파일 끝에서만 맞는다")을 끈다. 그러면 낡은 diff로 같은
/// hunk를 두 번 stage할 때 파일 끝/앞 삽입이 거절되지 않고 줄이 중복된다. 원료 diff를
/// `-U3`으로 고정했으므로(commands.rs `PATCH_SOURCE_DIFF_ARGS`) 엔진이 만드는 패치에는
/// context가 남고, 이 옵션이 필요 없다.
/// `--whitespace=nowarn`은 원본에 이미 있던 공백 문제로 스테이징이 실패하지 않게 한다.
#[tauri::command(async)]
pub fn git_apply_patch(
    path: String,
    patch: String,
    cached: bool,
    reverse: bool,
) -> Result<OpResult, String> {
    if patch.trim().is_empty() {
        return Err("패치가 비어 있습니다".to_string());
    }

    let mut args: Vec<&str> = vec!["apply", "--whitespace=nowarn"];
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
#[tauri::command(async)]
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
#[tauri::command(async)]
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
    use crate::ops::run::lines_of;
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

    /// glob 문자가 든 이름의 추적 파일과, 그 glob에 걸리는 다른 추적 파일이 함께 있는 저장소.
    fn glob_names() -> TempRepo {
        let repo = TempRepo::init("gitlanes-literal");
        repo.write("data[1].csv", "base\n");
        repo.write("data1.csv", "base\n");
        repo.write("pages/[id].tsx", "base\n");
        repo.write("pages/i.tsx", "base\n");
        repo.git(&["add", "-A"]);
        repo.git(&["commit", "-qm", "base"]);
        for name in ["data[1].csv", "data1.csv", "pages/[id].tsx", "pages/i.tsx"] {
            repo.write(name, "changed\n");
        }
        repo
    }

    #[test]
    fn discard는_대괄호_이름을_glob으로_풀지_않는다() {
        let repo = glob_names();

        let result = git_discard(
            repo.path(),
            vec!["data[1].csv".to_string()],
            "worktree".to_string(),
        )
        .unwrap();
        assert!(result.ok, "{result:?}");
        assert_eq!(read(&repo, "data[1].csv"), "base\n");
        assert_eq!(
            read(&repo, "data1.csv"),
            "changed\n",
            "glob [1]에 걸린 data1.csv의 수정이 사라졌다"
        );
    }

    // Windows는 파일명에 `*`를 쓸 수 없어 이 파일을 만들 수조차 없다. 그러니 별표가 glob으로
    // 풀리는 사고도 Windows에서는 일어나지 않는다. 같은 수정(GIT_LITERAL_PATHSPECS)은 Windows에서도
    // 쓸 수 있는 `[` 이름 테스트(`data[1].csv`, `pages/[id].tsx`)가 지킨다.
    #[cfg(not(windows))]
    #[test]
    fn clean은_별표_이름을_glob으로_풀지_않는다() {
        let repo = TempRepo::init("gitlanes-literal-clean");
        repo.write("base.txt", "base\n");
        repo.git(&["add", "-A"]);
        repo.git(&["commit", "-qm", "base"]);
        repo.write("note*", "지울 파일\n");
        repo.write("note_draft.txt", "남겨야 할 초안\n");

        let result =
            git_discard(repo.path(), vec!["note*".to_string()], "all".to_string()).unwrap();
        assert!(result.ok, "{result:?}");
        assert!(!exists(&repo, "note*"));
        assert!(
            exists(&repo, "note_draft.txt"),
            "glob note*에 걸린 untracked 파일이 지워졌다(복구 불가)"
        );

        repo.write("note*", "다시\n");
        let cleaned = git_clean(repo.path(), vec!["note*".to_string()]).unwrap();
        assert!(cleaned.ok, "{cleaned:?}");
        assert!(exists(&repo, "note_draft.txt"));
    }

    #[test]
    fn stage는_대괄호_이름을_glob으로_풀지_않는다() {
        let repo = glob_names();

        let result = git_stage(repo.path(), vec!["pages/[id].tsx".to_string()]).unwrap();
        assert!(result.ok, "{result:?}");
        assert_eq!(staged_files(&repo), ["pages/[id].tsx"]);
    }

    #[test]
    fn 앞에_공백이_있는_경로는_공백_없는_파일과_다른_파일이다() {
        let repo = TempRepo::init("gitlanes-space");
        repo.write("a.txt", "a\n");
        repo.write(" a.txt", "a\n");
        repo.git(&["add", "-A"]);
        repo.git(&["commit", "-qm", "base"]);
        repo.write("a.txt", "중요한 수정\n");
        repo.write(" a.txt", "버릴 수정\n");
        repo.write(" fresh.txt", "버릴 새 파일\n");

        let result = git_discard(
            repo.path(),
            vec![" a.txt".to_string(), " fresh.txt".to_string()],
            "worktree".to_string(),
        )
        .unwrap();
        assert!(result.ok, "{result:?}");
        assert_eq!(read(&repo, " a.txt"), "a\n");
        assert_eq!(
            read(&repo, "a.txt"),
            "중요한 수정\n",
            "trim 때문에 다른 파일(a.txt)을 되돌렸다"
        );
        assert!(
            !exists(&repo, " fresh.txt"),
            "untracked 판정이 trim으로 어긋나 clean이 아니라 restore로 갔다"
        );
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

    /// 낡은 diff로 같은 hunk를 두 번 stage하는 상황. 파일 끝 삽입은 뒤쪽 context가 없어서
    /// `--unidiff-zero`가 "파일 끝에서만 맞는다" 검사를 끄면 두 번째도 성공해 줄이 중복된다.
    #[test]
    fn 파일_끝_삽입_패치를_두_번_적용하면_두_번째는_거절된다() {
        let repo = TempRepo::init("gitlanes-apply-twice");
        let base: String = (1..=10).map(|i| format!("l{i}\n")).collect();
        repo.write("f.txt", &base);
        repo.git(&["add", "-A"]);
        repo.git(&["commit", "-qm", "base"]);
        repo.write("f.txt", &format!("{base}NEW\n"));

        let patch = git::run(
            repo.path(),
            &[
                "diff",
                "-U3",
                "--src-prefix=a/",
                "--dst-prefix=b/",
                "--",
                "f.txt",
            ],
        )
        .unwrap();

        let first = git_apply_patch(repo.path(), patch.clone(), true, false).unwrap();
        assert!(first.ok, "{first:?}");
        let second = git_apply_patch(repo.path(), patch, true, false).unwrap();
        assert!(!second.ok, "이미 적용된 패치가 또 적용됐다: {second:?}");

        let index = git::run(repo.path(), &["show", ":f.txt"]).unwrap();
        assert_eq!(index, format!("{base}NEW\n"), "인덱스에 줄이 중복됐다");
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

    fn status_of(repo: &TempRepo) -> String {
        git::run(repo.path(), &["status", "--porcelain"]).unwrap()
    }

    /// R-M7. status는 안의 파일을 펼치지 않고 `?? newdir/`로 접어 준다. UI가 그 경로를 넘긴다.
    #[test]
    fn discard는_추적_안_된_디렉토리를_지운다() {
        let repo = dirty();
        repo.write("newdir/x.txt", "x\n");
        repo.write("newdir/deep/y.txt", "y\n");

        let result = git_discard(
            repo.path(),
            vec!["newdir/".to_string()],
            "worktree".to_string(),
        )
        .unwrap();
        assert!(result.ok, "{result:?}");
        assert!(!exists(&repo, "newdir"), "추적 안 된 디렉토리가 남았다");
        assert!(
            exists(&repo, "fresh.txt"),
            "고르지 않은 untracked까지 지웠다"
        );

        // 펼친 목록(`ls-files --others`)에서 고른 안쪽 파일도 untracked로 판정한다
        repo.write("newdir/x.txt", "x\n");
        repo.write("newdir/keep.txt", "keep\n");
        let inner = git_discard(
            repo.path(),
            vec!["newdir/x.txt".to_string()],
            "all".to_string(),
        )
        .unwrap();
        assert!(inner.ok, "{inner:?}");
        assert!(!exists(&repo, "newdir/x.txt"));
        assert!(exists(&repo, "newdir/keep.txt"));
    }

    /// R-M7의 두 번째 재현. `-z` 없이 읽으면 git이 `"say\"hi\".txt"`로 C 인용해 판정이 어긋난다.
    #[test]
    fn discard는_따옴표가_든_untracked_파일을_지운다() {
        let repo = dirty();
        repo.write("say\"hi\".txt", "q\n");

        let result = git_discard(
            repo.path(),
            vec!["say\"hi\".txt".to_string()],
            "all".to_string(),
        )
        .unwrap();
        assert!(result.ok, "{result:?}");
        assert!(!exists(&repo, "say\"hi\".txt"));
    }

    fn renamed() -> TempRepo {
        let repo = dirty();
        repo.git(&["checkout", "-q", "--", "a.txt"]);
        repo.git(&["mv", "b.txt", "renamed.txt"]);
        assert!(status_of(&repo).contains("R  b.txt -> renamed.txt"));
        repo
    }

    /// R-M8. 프론트는 rename 행에서 새 경로만 넘긴다. 원 경로의 삭제가 인덱스에 남으면 안 된다.
    #[test]
    fn rename을_unstage하면_원_경로도_인덱스로_돌아온다() {
        let repo = renamed();

        let result = git_unstage(repo.path(), vec!["renamed.txt".to_string()]).unwrap();
        assert!(result.ok, "{result:?}");
        assert!(
            staged_files(&repo).is_empty(),
            "원 경로의 삭제가 스테이지에 남았다: {}",
            status_of(&repo)
        );
        // 워킹 트리는 그대로다. 옮긴 파일은 untracked, 원 경로는 워킹 트리에서만 지워진 상태다
        assert!(exists(&repo, "renamed.txt"));
        assert!(!exists(&repo, "b.txt"));
    }

    #[test]
    fn rename을_discard_all하면_원_경로가_되살아난다() {
        let repo = renamed();

        let result = git_discard(
            repo.path(),
            vec!["renamed.txt".to_string()],
            "all".to_string(),
        )
        .unwrap();
        assert!(result.ok, "{result:?}");
        assert!(exists(&repo, "b.txt"), "원 경로가 되살아나지 않았다");
        assert_eq!(read(&repo, "b.txt"), "b\n");
        assert!(!exists(&repo, "renamed.txt"));
        assert_eq!(status_of(&repo), "?? fresh.txt\n");
    }

    fn unborn() -> TempRepo {
        let repo = TempRepo::init("gitlanes-unborn");
        repo.write("a.txt", "a\n");
        repo.write("b.txt", "b\n");
        repo.git(&["add", "-A"]);
        repo
    }

    /// R-M9. 새 레포를 만들고 add한 직후 파일 하나를 내리는 가장 흔한 동작이다.
    #[test]
    fn 첫_커밋_전에도_파일_단위로_unstage한다() {
        let repo = unborn();

        let result = git_unstage(repo.path(), vec!["b.txt".to_string()]).unwrap();
        assert!(result.ok, "{result:?}");
        assert_eq!(staged_files(&repo), ["a.txt"]);
        assert!(exists(&repo, "b.txt"), "unstage가 워킹 트리를 건드렸다");
    }

    /// 첫 커밋 전의 추적 파일은 전부 "새로 추가된 파일"이다. HEAD가 있는 레포에서 새로 add한
    /// 파일을 discard(all)하면 인덱스와 워킹 트리에서 사라진다. 같은 결과를 낸다.
    #[test]
    fn 첫_커밋_전에도_discard_all이_된다() {
        let repo = unborn();
        repo.write("c.txt", "untracked\n");

        let result = git_discard(
            repo.path(),
            vec!["b.txt".to_string(), "c.txt".to_string()],
            "all".to_string(),
        )
        .unwrap();
        assert!(result.ok, "{result:?}");
        assert_eq!(staged_files(&repo), ["a.txt"]);
        assert!(!exists(&repo, "b.txt"));
        assert!(!exists(&repo, "c.txt"));
        assert!(exists(&repo, "a.txt"));
    }

    /// R-L9. `restore`는 서브모듈 안을 건드리지 않고 0으로 끝난다. 성공 토스트가 사실과 다르다.
    #[test]
    fn 서브모듈_discard는_지원하지_않는다고_거절한다() {
        let inner = TempRepo::init("gitlanes-sub-inner");
        inner.write("s.txt", "1\n");
        inner.git(&["add", "-A"]);
        inner.git(&["commit", "-qm", "inner"]);

        let repo = dirty();
        repo.git(&[
            "-c",
            "protocol.file.allow=always",
            "submodule",
            "add",
            "-q",
            inner.path().as_str(),
            "sub",
        ]);
        repo.git(&["commit", "-qm", "sub"]);

        let sub_path = format!("{}/sub", repo.path());
        std::fs::write(format!("{sub_path}/s.txt"), "2\n").unwrap();
        let committed = std::process::Command::new("git")
            .current_dir(&sub_path)
            .args([
                "-c",
                "user.name=t",
                "-c",
                "user.email=t@t",
                "commit",
                "-qam",
                "moved",
            ])
            .status()
            .unwrap();
        assert!(committed.success());
        assert!(status_of(&repo).contains(" M sub"), "{}", status_of(&repo));

        for area in ["worktree", "all"] {
            let error = git_discard(
                repo.path(),
                vec!["a.txt".to_string(), "sub".to_string()],
                area.to_string(),
            )
            .unwrap_err();
            assert!(error.contains("submodule"), "{error}");
        }
        // 섞여 온 다른 경로도 건드리지 않는다
        assert_eq!(read(&repo, "a.txt"), "changed\n");
    }
}
