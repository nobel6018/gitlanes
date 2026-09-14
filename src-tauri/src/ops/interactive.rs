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
use super::run::{run_op_with_env, validate_commitish, LOCAL_TIMEOUT};

/// todo에 쓸 수 있는 동작.
#[cfg(not(target_os = "windows"))]
const ACTIONS: [&str; 6] = ["pick", "reword", "edit", "squash", "fixup", "drop"];

#[cfg(not(target_os = "windows"))]
#[tauri::command]
pub fn git_rebase_interactive(
    path: String,
    base: String,
    steps: Vec<RebaseStep>,
) -> Result<OpResult, String> {
    let base = validate_commitish(&path, &base)?;
    let steps = validate_steps(&path, &steps)?;

    let workspace = Workspace::create()?;
    let todo = workspace.write_todo(&steps)?;
    let script = workspace.write_sequence_script()?;

    // git이 이 명령 뒤에 todo 파일 경로를 덧붙여 셸로 실행한다.
    // 결과적으로 `sh <script> <우리 todo> <git todo>`가 된다.
    let sequence_editor = format!("sh {} {}", quote(&script), quote(&todo));

    // 커밋을 통째로 빼는 todo(drop, 또는 목록에서 제거)를 git이 실수로 보고 되묻지
    // 않게 한다. 되물으면 편집기가 다시 떠서 비대화식 실행이 깨진다.
    run_op_with_env(
        &path,
        &[
            "-c",
            "rebase.missingCommitsCheck=ignore",
            "-c",
            "rebase.autoSquash=false",
            "rebase",
            "-i",
            base.as_str(),
        ],
        LOCAL_TIMEOUT,
        &[("GIT_SEQUENCE_EDITOR", sequence_editor)],
    )
}

/// Windows에서는 `sh` 기반 주입을 쓸 수 없다. 프론트가 이 오류를 보고 메뉴를 감춘다.
#[cfg(target_os = "windows")]
#[tauri::command]
pub fn git_rebase_interactive(
    path: String,
    base: String,
    steps: Vec<RebaseStep>,
) -> Result<OpResult, String> {
    let _ = (path, base, steps);
    Err("unsupported on Windows".to_string())
}

/// 검증을 통과한 한 줄. sha는 실재가 확인된 값이다.
#[cfg(not(target_os = "windows"))]
struct Planned {
    action: String,
    sha: String,
    subject: String,
    /// reword일 때만 채워진다
    message: Option<String>,
}

#[cfg(not(target_os = "windows"))]
fn validate_steps(repo: &str, steps: &[RebaseStep]) -> Result<Vec<Planned>, String> {
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

/// todo와 메시지 파일을 담는 임시 디렉토리. Drop에서 통째로 지운다.
#[cfg(not(target_os = "windows"))]
struct Workspace {
    root: std::path::PathBuf,
}

#[cfg(not(target_os = "windows"))]
impl Drop for Workspace {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

#[cfg(not(target_os = "windows"))]
impl Workspace {
    fn create() -> Result<Self, String> {
        use std::sync::atomic::{AtomicUsize, Ordering};
        static COUNTER: AtomicUsize = AtomicUsize::new(0);

        let id = COUNTER.fetch_add(1, Ordering::SeqCst);
        let root =
            std::env::temp_dir().join(format!("gitlanes-rebase-{}-{id}", std::process::id()));
        std::fs::create_dir_all(&root)
            .map_err(|error| format!("임시 디렉토리를 만들지 못했습니다: {error}"))?;
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

    #[test]
    fn 셸_인용은_작은따옴표를_안전하게_감싼다() {
        assert_eq!(quote("/tmp/a b"), "'/tmp/a b'");
        assert_eq!(quote("it's"), r"'it'\''s'");
    }
}
