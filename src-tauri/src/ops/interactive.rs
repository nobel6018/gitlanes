//! 인터랙티브 리베이스. todo 파일을 만들어 `GIT_SEQUENCE_EDITOR`로 주입한다.
//!
//! # 왜 reword를 `exec`로 처리하는가
//!
//! 순진한 방법은 todo에 `reword`를 적고 `GIT_EDITOR`로 메시지를 순서대로 넣는 것이다.
//! 그런데 git은 squash 그룹이 끝날 때도 같은 편집기를 부른다. 편집기 호출 횟수와 reword
//! 개수가 어긋나서, 카운터로 파일을 고르면 squash가 섞인 순간 엉뚱한 커밋에 엉뚱한
//! 메시지가 들어간다. 그래서 reword는 `pick` + `exec git commit --amend -F <파일>`로
//! 편다. 편집기 호출 순서에 기대지 않으니 어떤 조합에서도 어긋나지 않는다.
//! 메시지를 파일로 넘기는 것은 todo 한 줄에 개행을 넣을 수 없기 때문이다.
//!
//! squash로 합쳐진 메시지는 git 기본값(합친 메시지 전부)을 그대로 쓴다. `GIT_EDITOR=true`가
//! 편집기를 무동작으로 만들어서 멈추지 않는다.
//!
//! Windows는 `sh`를 가정할 수 없어 지원하지 않는다.
//!
//! @see CONTRACTS.md

use crate::model::{OpResult, RebaseStep};

#[cfg(not(target_os = "windows"))]
use crate::git;

#[cfg(not(target_os = "windows"))]
use super::run::{git_dir, run_op_with_env, validate_commitish, LOCAL_TIMEOUT};

/// todo에 쓸 수 있는 동작.
#[cfg(not(target_os = "windows"))]
const ACTIONS: [&str; 6] = ["pick", "reword", "edit", "squash", "fixup", "drop"];

/// todo와 reword 메시지 파일을 두는 `<git 디렉토리>` 아래 이름.
///
/// 임시 디렉토리에 두고 함수가 끝날 때 지우면, edit이나 충돌로 멈춘 뒤 Continue할 때
/// todo의 `exec git commit --amend -F <파일>`이 파일을 못 찾아 reword가 사라진다.
/// 그래서 리베이스보다 오래 살아야 하고, 리베이스가 끝난 것을 확인한 뒤에만 지운다.
#[cfg(not(target_os = "windows"))]
const WORKSPACE_DIR: &str = "gitlanes-rebase";

#[cfg(not(target_os = "windows"))]
#[tauri::command(async)]
pub fn git_rebase_interactive(
    path: String,
    base: String,
    steps: Vec<RebaseStep>,
) -> Result<OpResult, String> {
    let base = validate_commitish(&path, &base)?;
    let steps = validate_steps(&path, &base, &steps)?;

    let dir = git_dir(&path).ok_or_else(|| "git 디렉토리를 찾지 못했습니다".to_string())?;
    // 진행 중인 리베이스가 있으면 git이 어차피 거절한다. 그 전에 아래에서 작업 디렉토리를
    // 비우면 진행 중인 리베이스의 reword 메시지가 사라지므로 먼저 막는다.
    if dir.join("rebase-merge").is_dir() || dir.join("rebase-apply").is_dir() {
        return Err("이미 진행 중인 리베이스가 있습니다".to_string());
    }

    let workspace = Workspace::create(&dir)?;
    let todo = workspace.write_todo(&steps)?;
    let script = workspace.write_sequence_script()?;

    // git이 이 명령 뒤에 todo 파일 경로를 덧붙여 셸로 실행한다.
    // 결과적으로 `sh <script> <우리 todo> <git todo>`가 된다.
    let sequence_editor = format!("sh {} {}", quote(&script), quote(&todo));

    // 설정을 `-c`가 아니라 `GIT_CONFIG_*` 환경변수로 넘긴다. 우선순위는 같지만 `-c`로 넘기면
    // 인자 첫 단어가 `-c`가 되어 `op_command`가 이 명령을 훅을 돌리는 명령으로 알아보지 못하고
    // `GIT_LITERAL_PATHSPECS`를 건다. 그러면 post-rewrite 훅, autostash 복원, todo의 exec까지
    // 리터럴 pathspec을 물려받는다.
    //
    // missingCommitsCheck: 커밋을 통째로 빼는 todo(drop, 또는 목록에서 제거)를 git이 실수로
    // 보고 되묻지 않게 한다. 되물으면 편집기가 다시 떠서 비대화식 실행이 깨진다.
    let envs = [
        ("GIT_SEQUENCE_EDITOR", sequence_editor),
        ("GIT_CONFIG_COUNT", "2".to_string()),
        ("GIT_CONFIG_KEY_0", "rebase.missingCommitsCheck".to_string()),
        ("GIT_CONFIG_VALUE_0", "ignore".to_string()),
        ("GIT_CONFIG_KEY_1", "rebase.autoSquash".to_string()),
        ("GIT_CONFIG_VALUE_1", "false".to_string()),
    ];

    // 일반 리베이스처럼 autostash를 켠다. 없으면 워킹트리가 조금만 더러워도 시작부터
    // 거절된다. 스태시는 리베이스가 끝날 때(abort 포함) git이 되돌려 놓는다.
    let result = run_op_with_env(
        &path,
        &["rebase", "-i", "--autostash", base.as_str()],
        LOCAL_TIMEOUT,
        &envs,
    );

    // 멈추지 않고 끝났거나 시작하지 못했으면 바로 치운다. 멈췄으면 continue/abort가 치운다
    clear_finished_workspace(&path);
    result
}

/// Windows에서는 `sh` 기반 주입을 쓸 수 없다. 프론트가 이 오류를 보고 메뉴를 감춘다.
#[cfg(target_os = "windows")]
#[tauri::command(async)]
pub fn git_rebase_interactive(
    path: String,
    base: String,
    steps: Vec<RebaseStep>,
) -> Result<OpResult, String> {
    let _ = (path, base, steps);
    Err("unsupported on Windows".to_string())
}

/// 리베이스가 끝났으면 todo와 메시지 파일을 지운다. 진행 중이면 아무것도 하지 않는다.
///
/// `git_pending_action`이 rebase continue/abort/skip 뒤에 부른다. 터미널에서 리베이스를
/// 마친 경우에는 다음 인터랙티브 리베이스까지 파일이 남지만, 진행 중이 아니면 git이
/// 읽지 않는 파일이라 해가 없다.
#[cfg(not(target_os = "windows"))]
pub fn clear_finished_workspace(repo: &str) {
    let Some(dir) = git_dir(repo) else {
        return;
    };
    if dir.join("rebase-merge").is_dir() {
        return;
    }
    let _ = std::fs::remove_dir_all(dir.join(WORKSPACE_DIR));
}

#[cfg(target_os = "windows")]
pub fn clear_finished_workspace(repo: &str) {
    let _ = repo;
}

/// 검증을 통과한 한 줄. sha는 전체 sha로 풀어 둔 값이다.
#[cfg(not(target_os = "windows"))]
struct Planned {
    action: String,
    sha: String,
    subject: String,
    /// reword일 때만 채워진다
    message: Option<String>,
}

#[cfg(not(target_os = "windows"))]
fn validate_steps(repo: &str, base: &str, steps: &[RebaseStep]) -> Result<Vec<Planned>, String> {
    if steps.is_empty() {
        return Err("리베이스할 커밋이 없습니다".to_string());
    }

    let mut planned = Vec::with_capacity(steps.len());
    for step in steps {
        let action = step.action.trim().to_string();
        if !ACTIONS.contains(&action.as_str()) {
            return Err(format!("알 수 없는 리베이스 동작입니다: {action}"));
        }
        let sha = validate_commitish(repo, &step.sha)?;
        let message = step
            .message
            .as_deref()
            .map(str::trim)
            .filter(|message| !message.is_empty())
            .map(str::to_string);

        if action == "reword" && message.is_none() {
            return Err(format!("reword에는 새 메시지가 필요합니다: {sha}"));
        }
        planned.push(Planned {
            action,
            sha,
            // todo 주석으로만 쓴다. 개행이 들어가면 todo가 깨진다.
            subject: step.subject.replace(['\n', '\r'], " "),
            message,
        });
    }

    check_in_range(repo, base, &mut planned)?;

    // squash/fixup은 앞선 커밋이 있어야 한다. git도 거절하지만 그때는 이미 리베이스가
    // 시작된 뒤라 사용자가 중단된 상태를 치워야 한다. 시작 전에 막는 편이 낫다.
    let first = planned
        .iter()
        .find(|step| step.action != "drop")
        .map(|step| step.action.as_str());
    if matches!(first, Some("squash") | Some("fixup")) {
        return Err("첫 커밋을 squash하거나 fixup할 수 없습니다".to_string());
    }

    Ok(planned)
}

/// 모든 step이 `base..HEAD`의 비머지 커밋인지 확인하고 sha를 전체 sha로 바꾼다.
///
/// 범위 밖 sha를 받으면 다른 브랜치의 커밋이 현재 브랜치에 조용히 섞인다. 머지 커밋은
/// `--rebase-merges` 없이는 pick할 수 없어 git이 todo 오류로 멈추고, 앱에서 고칠 수 없는
/// `--edit-todo` 상태가 남는다. 둘 다 리베이스를 시작하기 전에 거절한다.
#[cfg(not(target_os = "windows"))]
fn check_in_range(repo: &str, base: &str, planned: &mut [Planned]) -> Result<(), String> {
    // 짧은 sha, 태그 등을 한 번의 호출로 전체 sha로 푼다. 출력은 인자 순서를 따른다
    let specs: Vec<String> = planned
        .iter()
        .map(|step| format!("{}^{{commit}}", step.sha))
        .collect();
    let mut args = vec!["rev-parse".to_string()];
    args.extend(specs);
    let resolved = git::run(repo, &args)?;
    let full: Vec<&str> = resolved.lines().map(str::trim).collect();
    if full.len() != planned.len() {
        return Err("커밋을 확인하지 못했습니다".to_string());
    }

    // 에디터 초기 목록(get_rebase_steps)과 같은 함수로 범위를 구한다. 기준이 다르면
    // 에디터가 보여 준 목록을 그대로 실행해도 여기서 거절된다.
    let range = rebase_range(repo, base)?;
    let in_range: std::collections::HashMap<&str, bool> = range
        .iter()
        .map(|commit| (commit.sha.as_str(), commit.is_merge))
        .collect();

    for (step, sha) in planned.iter_mut().zip(full) {
        match in_range.get(sha) {
            None => {
                return Err(format!(
                    "현재 브랜치의 {base} 이후 커밋이 아닙니다: {}",
                    step.sha
                ))
            }
            Some(true) => return Err(format!("머지 커밋은 리베이스할 수 없습니다: {}", step.sha)),
            Some(false) => step.sha = sha.to_string(),
        }
    }
    Ok(())
}

/// `base..HEAD`에 들어가는 커밋 한 개.
#[cfg(not(target_os = "windows"))]
struct RangeCommit {
    sha: String,
    is_merge: bool,
    subject: String,
}

/// 인터랙티브 리베이스가 다시 쌓을 커밋을 todo 순서(오래된 것이 먼저)로 돌려준다.
///
/// [`get_rebase_steps`]의 목록과 [`check_in_range`]의 검증이 둘 다 이 함수를 쓴다.
/// base가 HEAD의 조상이 아니면 `base..HEAD`에 다른 갈래의 커밋까지 섞이므로 거절한다.
#[cfg(not(target_os = "windows"))]
fn rebase_range(repo: &str, base: &str) -> Result<Vec<RangeCommit>, String> {
    // HEAD에 없는 커밋이 base 쪽에 하나라도 있으면 조상이 아니다
    let outside = format!("HEAD..{base}");
    let ahead = git::run(repo, &["rev-list", "--max-count=1", outside.as_str(), "--"])?;
    if !ahead.trim().is_empty() {
        return Err("This commit is not an ancestor of the current branch.".to_string());
    }

    // `--format`을 주면 커밋마다 "commit <sha>" 머리 줄이 따로 붙는다. 우리 줄은 NUL로
    // 시작하게 해서 머리 줄과 구분한다. subject가 비어도 줄이 남는다.
    // 날짜가 뒤틀린 커밋이 있어도 부모가 먼저 나오게 topo-order를 건다.
    let range = format!("{base}..HEAD");
    let listed = git::run(
        repo,
        &[
            "rev-list",
            "--reverse",
            "--topo-order",
            "--format=%x00%H %P%x00%s",
            range.as_str(),
            "--",
        ],
    )?;

    let commits = listed
        .lines()
        .filter_map(|line| line.strip_prefix('\0'))
        .filter_map(|line| {
            let (shas, subject) = line.split_once('\0')?;
            let mut parts = shas.split_whitespace();
            let sha = parts.next()?.to_string();
            Some(RangeCommit {
                sha,
                // 부모가 둘 이상이면 머지 커밋이다
                is_merge: parts.count() > 1,
                subject: subject.to_string(),
            })
        })
        .collect();
    Ok(commits)
}

/// 인터랙티브 리베이스 에디터의 초기 목록. 모두 pick이다.
///
/// 그래프 행으로 목록을 만들면 다른 브랜치 커밋이 섞이고 페이징 때문에 범위를 다 알 수도
/// 없어서 git에게 직접 묻는다.
#[cfg(not(target_os = "windows"))]
#[tauri::command(async)]
pub fn get_rebase_steps(path: String, base: String) -> Result<Vec<RebaseStep>, String> {
    let base = validate_commitish(&path, &base)?;
    let range = rebase_range(&path, &base)?;
    // 머지 커밋은 --rebase-merges 없이 pick할 수 없다. 에디터를 열기 전에 알린다
    if range.iter().any(|commit| commit.is_merge) {
        return Err("Interactive rebase over merge commits is not supported.".to_string());
    }
    Ok(range
        .into_iter()
        .map(|commit| RebaseStep {
            sha: commit.sha,
            action: "pick".to_string(),
            subject: commit.subject,
            message: None,
        })
        .collect())
}

#[cfg(target_os = "windows")]
#[tauri::command(async)]
pub fn get_rebase_steps(path: String, base: String) -> Result<Vec<RebaseStep>, String> {
    let _ = (path, base);
    Err("unsupported on Windows".to_string())
}

/// todo와 메시지 파일을 담는 `<git 디렉토리>/gitlanes-rebase`. 지우는 것은
/// [`clear_finished_workspace`]의 몫이다.
#[cfg(not(target_os = "windows"))]
struct Workspace {
    root: std::path::PathBuf,
}

#[cfg(not(target_os = "windows"))]
impl Workspace {
    fn create(git_dir: &std::path::Path) -> Result<Self, String> {
        let root = git_dir.join(WORKSPACE_DIR);
        // 이전 리베이스가 남긴 파일이 섞이지 않게 비우고 시작한다. 진행 중인 리베이스가
        // 없다는 것은 호출자가 확인했다.
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root)
            .map_err(|error| format!("작업 디렉토리를 만들지 못했습니다: {error}"))?;
        Ok(Self { root })
    }

    /// todo 파일을 쓰고 경로를 돌려준다.
    fn write_todo(&self, steps: &[Planned]) -> Result<String, String> {
        let mut body = String::new();
        for (index, step) in steps.iter().enumerate() {
            if step.action == "reword" {
                let message_path = self.root.join(format!("msg-{index}"));
                let message = step.message.as_deref().unwrap_or_default();
                write(&message_path, &format!("{}\n", message.trim_end()))?;
                body.push_str(&format!("pick {} {}\n", step.sha, step.subject));
                body.push_str(&format!(
                    "exec git commit --amend -F {}\n",
                    quote(&message_path.to_string_lossy())
                ));
                continue;
            }
            body.push_str(&format!("{} {} {}\n", step.action, step.sha, step.subject));
        }

        let todo = self.root.join("todo");
        write(&todo, &body)?;
        Ok(todo.to_string_lossy().into_owned())
    }

    /// git이 연 todo 파일을 우리 것으로 덮어쓰는 한 줄짜리 스크립트.
    fn write_sequence_script(&self) -> Result<String, String> {
        let script = self.root.join("sequence-editor.sh");
        // $1은 우리가 미리 넘긴 todo, $2는 git이 붙여 준 편집 대상이다.
        write(&script, "#!/bin/sh\ncat \"$1\" > \"$2\"\n")?;
        Ok(script.to_string_lossy().into_owned())
    }
}

#[cfg(not(target_os = "windows"))]
fn write(path: &std::path::Path, body: &str) -> Result<(), String> {
    std::fs::write(path, body)
        .map_err(|error| format!("{}를 쓰지 못했습니다: {error}", path.display()))
}

/// 셸에 넘길 경로를 작은따옴표로 감싼다. 임시 경로에 공백이 있어도 한 인자로 간다.
#[cfg(not(target_os = "windows"))]
fn quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', r"'\''"))
}

#[cfg(all(test, not(target_os = "windows")))]
mod tests {
    use super::*;
    use crate::git;
    use crate::testrepo::TempRepo;

    /// base 위에 커밋 세 개가 쌓인 저장소. 각 커밋은 자기 파일만 건드려 충돌하지 않는다.
    fn stacked(prefix: &str) -> TempRepo {
        let repo = TempRepo::init(prefix);
        repo.write("base.txt", "base\n");
        repo.git(&["add", "-A"]);
        repo.git(&["commit", "-qm", "base"]);
        // 테스트가 "base"를 리베이스 바닥으로 부를 수 있게 ref로 박아 둔다
        repo.git(&["branch", "base"]);
        for name in ["one", "two", "three"] {
            repo.write(&format!("{name}.txt"), name);
            repo.git(&["add", "-A"]);
            repo.git(&["commit", "-qm", name]);
        }
        repo
    }

    fn step(sha: &str, action: &str, message: Option<&str>) -> RebaseStep {
        RebaseStep {
            sha: sha.to_string(),
            action: action.to_string(),
            subject: "제목".to_string(),
            message: message.map(str::to_string),
        }
    }

    fn subjects(repo: &TempRepo) -> Vec<String> {
        git::run(repo.path(), &["log", "--format=%s", "base..HEAD"])
            .unwrap()
            .lines()
            .map(str::to_string)
            .collect()
    }

    #[test]
    fn 순서를_바꾸면_그_순서로_쌓인다() {
        let repo = stacked("gitlanes-irebase-order");
        let (one, two, three) = (repo.rev("HEAD~2"), repo.rev("HEAD~1"), repo.rev("HEAD"));

        let result = git_rebase_interactive(
            repo.path(),
            "base".to_string(),
            vec![
                step(&three, "pick", None),
                step(&one, "pick", None),
                step(&two, "pick", None),
            ],
        )
        .unwrap();
        assert!(result.ok, "{result:?}");

        // log는 최신부터라 todo 순서의 역순이다
        assert_eq!(subjects(&repo), ["two", "one", "three"]);
    }

    #[test]
    fn drop이_커밋을_뺀다() {
        let repo = stacked("gitlanes-irebase-drop");
        let (one, two, three) = (repo.rev("HEAD~2"), repo.rev("HEAD~1"), repo.rev("HEAD"));

        let result = git_rebase_interactive(
            repo.path(),
            "base".to_string(),
            vec![
                step(&one, "pick", None),
                step(&two, "drop", None),
                step(&three, "pick", None),
            ],
        )
        .unwrap();
        assert!(result.ok, "{result:?}");
        assert_eq!(subjects(&repo), ["three", "one"]);
        assert!(!std::path::Path::new(&repo.path()).join("two.txt").exists());
    }

    #[test]
    fn reword가_지정한_메시지로_바뀐다() {
        let repo = stacked("gitlanes-irebase-reword");
        let (one, two, three) = (repo.rev("HEAD~2"), repo.rev("HEAD~1"), repo.rev("HEAD"));

        let result = git_rebase_interactive(
            repo.path(),
            "base".to_string(),
            vec![
                step(&one, "pick", None),
                step(
                    &two,
                    "reword",
                    Some("고쳐 쓴 제목\n\n본문도 여러 줄\n남는다"),
                ),
                step(&three, "pick", None),
            ],
        )
        .unwrap();
        assert!(result.ok, "{result:?}");
        assert_eq!(subjects(&repo), ["three", "고쳐 쓴 제목", "one"]);

        let body = git::run(repo.path(), &["log", "-1", "--format=%B", "HEAD~1"]).unwrap();
        assert!(body.contains("본문도 여러 줄"), "{body}");
    }

    #[test]
    fn squash와_reword가_섞여도_메시지가_어긋나지_않는다() {
        // 편집기 호출 횟수로 메시지를 고르는 구현이라면 여기서 어긋난다
        let repo = stacked("gitlanes-irebase-mixed");
        let (one, two, three) = (repo.rev("HEAD~2"), repo.rev("HEAD~1"), repo.rev("HEAD"));

        let result = git_rebase_interactive(
            repo.path(),
            "base".to_string(),
            vec![
                step(&one, "pick", None),
                step(&two, "squash", None),
                step(&three, "reword", Some("마지막만 고친다")),
            ],
        )
        .unwrap();
        assert!(result.ok, "{result:?}");

        let all = subjects(&repo);
        assert_eq!(all.len(), 2, "squash로 하나가 합쳐진다: {all:?}");
        assert_eq!(all[0], "마지막만 고친다");
    }

    #[test]
    fn fixup이_앞_커밋에_흡수된다() {
        let repo = stacked("gitlanes-irebase-fixup");
        let (one, two, three) = (repo.rev("HEAD~2"), repo.rev("HEAD~1"), repo.rev("HEAD"));

        let result = git_rebase_interactive(
            repo.path(),
            "base".to_string(),
            vec![
                step(&one, "pick", None),
                step(&two, "fixup", None),
                step(&three, "pick", None),
            ],
        )
        .unwrap();
        assert!(result.ok, "{result:?}");
        assert_eq!(subjects(&repo), ["three", "one"]);
        // fixup은 내용을 남기고 메시지만 버린다
        assert!(std::path::Path::new(&repo.path()).join("two.txt").exists());
    }

    #[test]
    fn 잘못된_step은_리베이스를_시작하기_전에_막는다() {
        let repo = stacked("gitlanes-irebase-bad");
        let one = repo.rev("HEAD~2");

        assert!(git_rebase_interactive(repo.path(), "base".to_string(), vec![]).is_err());
        assert!(git_rebase_interactive(
            repo.path(),
            "base".to_string(),
            vec![step(&one, "explode", None)]
        )
        .is_err());
        assert!(git_rebase_interactive(
            repo.path(),
            "base".to_string(),
            vec![step("없는커밋", "pick", None)]
        )
        .is_err());
        // 첫 줄 squash는 git이 거절하는데, 그때는 이미 중단된 리베이스가 남는다
        assert!(git_rebase_interactive(
            repo.path(),
            "base".to_string(),
            vec![step(&one, "squash", None)]
        )
        .is_err());
        // reword에 메시지가 없으면 편집기를 띄우려다 원문이 그대로 남는다
        assert!(git_rebase_interactive(
            repo.path(),
            "base".to_string(),
            vec![step(&one, "reword", None)]
        )
        .is_err());
        assert!(git_rebase_interactive(
            repo.path(),
            "없는베이스".to_string(),
            vec![step(&one, "pick", None)]
        )
        .is_err());

        // 아무것도 시작되지 않았다
        assert_eq!(crate::ops::sync::detect_pending(&repo.path()), None);
    }

    #[test]
    fn 충돌하면_ok_false로_멈추고_pending을_남긴다() {
        let repo = TempRepo::init("gitlanes-irebase-conflict");
        repo.write("c.txt", "base\n");
        repo.git(&["add", "-A"]);
        repo.git(&["commit", "-qm", "base"]);
        repo.write("c.txt", "one\n");
        repo.git(&["add", "-A"]);
        repo.git(&["commit", "-qm", "one"]);
        repo.write("c.txt", "two\n");
        repo.git(&["add", "-A"]);
        repo.git(&["commit", "-qm", "two"]);

        let (one, two) = (repo.rev("HEAD~1"), repo.rev("HEAD"));
        // 순서를 뒤집으면 같은 줄을 두 번 고치게 되어 충돌한다
        let result = git_rebase_interactive(
            repo.path(),
            "HEAD~2".to_string(),
            vec![step(&two, "pick", None), step(&one, "pick", None)],
        )
        .unwrap();

        assert!(!result.ok, "{result:?}");
        assert_eq!(result.conflicts, ["c.txt"]);
        assert!(crate::ops::sync::detect_pending(&repo.path()).is_some());

        // 뒷정리까지 되어야 다음 테스트 대상이 깨끗하다
        let aborted = crate::ops::history::git_pending_action(
            repo.path(),
            "rebase".to_string(),
            "abort".to_string(),
        )
        .unwrap();
        assert!(aborted.ok, "{aborted:?}");
    }

    fn continue_rebase(repo: &TempRepo) -> OpResult {
        crate::ops::history::git_pending_action(
            repo.path(),
            "rebase".to_string(),
            "continue".to_string(),
        )
        .unwrap()
    }

    #[test]
    fn edit에서_멈췄다_이어가도_reword_메시지가_적용된다() {
        let repo = stacked("gitlanes-irebase-edit-reword");
        let (one, two, three) = (repo.rev("HEAD~2"), repo.rev("HEAD~1"), repo.rev("HEAD"));

        let started = git_rebase_interactive(
            repo.path(),
            "base".to_string(),
            vec![
                step(&one, "edit", None),
                step(&two, "reword", Some("멈춘 뒤에 고친 제목")),
                step(&three, "pick", None),
            ],
        )
        .unwrap();
        assert!(started.ok, "{started:?}");
        assert!(crate::ops::sync::detect_pending(&repo.path()).is_some());

        let continued = continue_rebase(&repo);
        assert!(continued.ok, "{continued:?}");
        assert_eq!(crate::ops::sync::detect_pending(&repo.path()), None);
        assert_eq!(subjects(&repo), ["three", "멈춘 뒤에 고친 제목", "one"]);

        // 리베이스가 끝나면 메시지 파일도 치운다
        let dir = crate::ops::run::git_dir(&repo.path()).unwrap();
        assert!(!dir.join(WORKSPACE_DIR).exists());
    }

    #[test]
    fn 충돌로_멈췄다_이어가도_reword_메시지가_적용된다() {
        let repo = TempRepo::init("gitlanes-irebase-conflict-reword");
        repo.write("c.txt", "base\n");
        repo.git(&["add", "-A"]);
        repo.git(&["commit", "-qm", "base"]);
        repo.write("c.txt", "one\n");
        repo.git(&["commit", "-qam", "one"]);
        repo.write("c.txt", "two\n");
        repo.git(&["commit", "-qam", "two"]);
        let (one, two) = (repo.rev("HEAD~1"), repo.rev("HEAD"));

        // 순서를 뒤집어 two를 먼저 올리면 충돌한다. reword 대상이 바로 그 커밋이다
        let started = git_rebase_interactive(
            repo.path(),
            "HEAD~2".to_string(),
            vec![
                step(&two, "reword", Some("충돌 뒤에 고친 제목")),
                step(&one, "drop", None),
            ],
        )
        .unwrap();
        assert!(!started.ok, "{started:?}");

        repo.write("c.txt", "two\n");
        repo.git(&["add", "-A"]);
        let continued = continue_rebase(&repo);
        assert!(continued.ok, "{continued:?}");

        let subject = git::run(repo.path(), &["log", "-1", "--format=%s"]).unwrap();
        assert_eq!(subject.trim(), "충돌 뒤에 고친 제목");
    }

    #[test]
    fn 다른_브랜치의_커밋은_시작하기_전에_막는다() {
        let repo = stacked("gitlanes-irebase-foreign");
        let one = repo.rev("HEAD~2");
        repo.git(&["checkout", "-qb", "side", "base"]);
        repo.write("side.txt", "side\n");
        repo.git(&["add", "-A"]);
        repo.git(&["commit", "-qm", "side"]);
        let side = repo.rev("HEAD");
        repo.git(&["checkout", "-q", "main"]);
        let head = repo.rev("HEAD");

        let result = git_rebase_interactive(
            repo.path(),
            "base".to_string(),
            vec![step(&one, "pick", None), step(&side, "pick", None)],
        );
        assert!(result.is_err(), "{result:?}");
        assert_eq!(repo.rev("HEAD"), head, "브랜치가 그대로여야 한다");
        assert_eq!(crate::ops::sync::detect_pending(&repo.path()), None);
    }

    #[test]
    fn 범위의_머지_커밋은_시작하기_전에_막는다() {
        let repo = stacked("gitlanes-irebase-merge");
        repo.git(&["checkout", "-qb", "side", "base"]);
        repo.write("side.txt", "side\n");
        repo.git(&["add", "-A"]);
        repo.git(&["commit", "-qm", "side"]);
        repo.git(&["checkout", "-q", "main"]);
        repo.git(&["merge", "-q", "--no-ff", "--no-edit", "side"]);
        let merge = repo.rev("HEAD");
        let one = repo.rev("HEAD^1~2");

        let result = git_rebase_interactive(
            repo.path(),
            "base".to_string(),
            vec![step(&one, "pick", None), step(&merge, "pick", None)],
        );
        let error = result.expect_err("머지 커밋은 pick할 수 없다");
        assert!(error.contains("머지"), "{error}");
        assert_eq!(crate::ops::sync::detect_pending(&repo.path()), None);
    }

    #[test]
    fn 짧은_sha도_범위_안이면_받는다() {
        let repo = stacked("gitlanes-irebase-short");
        let short = |rev: &str| repo.rev(rev)[..8].to_string();

        let result = git_rebase_interactive(
            repo.path(),
            "base".to_string(),
            vec![
                step(&short("HEAD"), "pick", None),
                step(&short("HEAD~2"), "pick", None),
                step(&short("HEAD~1"), "pick", None),
            ],
        )
        .unwrap();
        assert!(result.ok, "{result:?}");
        assert_eq!(subjects(&repo), ["two", "one", "three"]);
    }

    /// stacked 위에서 base에서 갈라진 side 브랜치에 커밋 하나를 만들고 main으로 돌아온다.
    fn with_side(prefix: &str) -> TempRepo {
        let repo = stacked(prefix);
        repo.git(&["checkout", "-qb", "side", "base"]);
        repo.write("side.txt", "side\n");
        repo.git(&["add", "-A"]);
        repo.git(&["commit", "-qm", "side"]);
        repo.git(&["checkout", "-q", "main"]);
        repo
    }

    #[test]
    fn 에디터_목록은_오래된_커밋부터_pick으로_나온다() {
        let repo = stacked("gitlanes-steps-order");
        let (one, two, three) = (repo.rev("HEAD~2"), repo.rev("HEAD~1"), repo.rev("HEAD"));

        let steps = get_rebase_steps(repo.path(), "base".to_string()).unwrap();
        assert_eq!(
            steps,
            vec![
                RebaseStep {
                    sha: one,
                    action: "pick".to_string(),
                    subject: "one".to_string(),
                    message: None,
                },
                RebaseStep {
                    sha: two,
                    action: "pick".to_string(),
                    subject: "two".to_string(),
                    message: None,
                },
                RebaseStep {
                    sha: three,
                    action: "pick".to_string(),
                    subject: "three".to_string(),
                    message: None,
                },
            ]
        );
    }

    #[test]
    fn 에디터_목록에_다른_브랜치_커밋이_섞이지_않는다() {
        // side 커밋이 가장 최근이라 그래프에서는 main 커밋들 사이에 끼어 보인다
        let repo = with_side("gitlanes-steps-foreign");
        let side = repo.rev("side");

        let steps = get_rebase_steps(repo.path(), "base".to_string()).unwrap();
        let subjects: Vec<&str> = steps.iter().map(|step| step.subject.as_str()).collect();
        assert_eq!(subjects, ["one", "two", "three"]);
        assert!(steps.iter().all(|step| step.sha != side), "{steps:?}");
    }

    #[test]
    fn 제목이_빈_커밋도_에디터_목록에서_빠지지_않는다() {
        let repo = stacked("gitlanes-steps-empty-subject");
        repo.git(&[
            "commit",
            "-q",
            "--allow-empty",
            "--allow-empty-message",
            "-m",
            "",
        ]);
        let empty = repo.rev("HEAD");

        let steps = get_rebase_steps(repo.path(), "base".to_string()).unwrap();
        assert_eq!(steps.len(), 4, "{steps:?}");
        assert_eq!(steps[3].sha, empty);
        assert_eq!(steps[3].subject, "");
    }

    #[test]
    fn 조상이_아닌_base는_에디터_목록을_거절한다() {
        let repo = with_side("gitlanes-steps-not-ancestor");

        let error =
            get_rebase_steps(repo.path(), "side".to_string()).expect_err("side는 조상이 아니다");
        assert!(error.contains("not an ancestor"), "{error}");
    }

    #[test]
    fn 머지가_있는_범위는_에디터_목록을_거절한다() {
        let repo = with_side("gitlanes-steps-merge");
        repo.git(&["merge", "-q", "--no-ff", "--no-edit", "side"]);

        let error = get_rebase_steps(repo.path(), "base".to_string()).expect_err("머지가 있다");
        assert!(error.contains("merge commits"), "{error}");
    }

    #[test]
    fn 에디터_목록을_그대로_실행하면_성공한다() {
        let repo = with_side("gitlanes-steps-roundtrip");

        let steps = get_rebase_steps(repo.path(), "base".to_string()).unwrap();
        let result = git_rebase_interactive(repo.path(), "base".to_string(), steps).unwrap();
        assert!(result.ok, "{result:?}");
        assert_eq!(subjects(&repo), ["three", "two", "one"]);
        assert_eq!(crate::ops::sync::detect_pending(&repo.path()), None);
    }

    #[test]
    fn 에디터_목록을_뒤집어_실행해도_검증을_통과한다() {
        let repo = stacked("gitlanes-steps-roundtrip-reversed");

        let mut steps = get_rebase_steps(repo.path(), "base".to_string()).unwrap();
        steps.reverse();
        let result = git_rebase_interactive(repo.path(), "base".to_string(), steps).unwrap();
        assert!(result.ok, "{result:?}");
        assert_eq!(subjects(&repo), ["one", "two", "three"]);
    }

    #[test]
    fn 조상이_아닌_base로는_인터랙티브_리베이스를_시작하지_않는다() {
        // 목록과 같은 기준이다. 목록이 거절하는 base를 실행 쪽이 받아 주면 안 된다
        let repo = with_side("gitlanes-irebase-not-ancestor");
        let head = repo.rev("HEAD");
        let one = repo.rev("HEAD~2");

        let result = git_rebase_interactive(
            repo.path(),
            "side".to_string(),
            vec![step(&one, "pick", None)],
        );
        let error = result.expect_err("side는 조상이 아니다");
        assert!(error.contains("not an ancestor"), "{error}");
        assert_eq!(repo.rev("HEAD"), head);
    }

    #[test]
    fn 워킹트리가_더러워도_autostash로_시작하고_되돌려_놓는다() {
        let repo = stacked("gitlanes-irebase-autostash");
        let (one, two, three) = (repo.rev("HEAD~2"), repo.rev("HEAD~1"), repo.rev("HEAD"));
        repo.write("one.txt", "아직 커밋 안 한 수정");

        let result = git_rebase_interactive(
            repo.path(),
            "base".to_string(),
            vec![
                step(&three, "pick", None),
                step(&one, "pick", None),
                step(&two, "pick", None),
            ],
        )
        .unwrap();
        assert!(result.ok, "{result:?}");
        assert_eq!(subjects(&repo), ["two", "one", "three"]);
        assert_eq!(
            std::fs::read_to_string(std::path::Path::new(&repo.path()).join("one.txt")).unwrap(),
            "아직 커밋 안 한 수정"
        );
    }

    #[test]
    fn 리베이스_훅에_리터럴_pathspec을_물려주지_않는다() {
        use std::os::unix::fs::PermissionsExt;

        let repo = stacked("gitlanes-irebase-hook");
        let (one, two, three) = (repo.rev("HEAD~2"), repo.rev("HEAD~1"), repo.rev("HEAD"));
        let git_dir = std::path::Path::new(&repo.path()).join(".git");
        let seen = git_dir.join("seen-env");
        let hook = git_dir.join("hooks").join("post-rewrite");
        std::fs::create_dir_all(hook.parent().unwrap()).unwrap();
        std::fs::write(
            &hook,
            format!(
                "#!/bin/sh\necho \"${{GIT_LITERAL_PATHSPECS:-unset}}\" > '{}'\n",
                seen.display()
            ),
        )
        .unwrap();
        std::fs::set_permissions(&hook, std::fs::Permissions::from_mode(0o755)).unwrap();

        let result = git_rebase_interactive(
            repo.path(),
            "base".to_string(),
            vec![
                step(&three, "pick", None),
                step(&one, "pick", None),
                step(&two, "pick", None),
            ],
        )
        .unwrap();
        assert!(result.ok, "{result:?}");
        assert_eq!(std::fs::read_to_string(&seen).unwrap().trim(), "unset");
    }

    #[test]
    fn 셸_인용은_작은따옴표를_안전하게_감싼다() {
        assert_eq!(quote("/tmp/a b"), "'/tmp/a b'");
        assert_eq!(quote("it's"), r"'it'\''s'");
    }
}
