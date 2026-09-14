//! 워크트리 목록과 추가/삭제.
//!
//! @see CONTRACTS.md

use crate::git;
use crate::model::{OpResult, WorktreeInfo};

use super::run::{run_op, validate_paths, validate_ref_name, LOCAL_TIMEOUT};

/// 이 저장소에 딸린 워크트리 목록.
#[tauri::command]
pub fn list_worktrees(path: String) -> Result<Vec<WorktreeInfo>, String> {
    let raw = git::run(&path, &["worktree", "list", "--porcelain"])?;
    let mut entries = parse_worktrees(&raw);

    // "지금 열어 둔 워크트리"를 표시한다. 심링크나 /private 접두사 때문에 문자열 비교로는
    // 어긋나므로 canonicalize한 경로로 맞춘다.
    let current = std::fs::canonicalize(&path).ok();
    for entry in &mut entries {
        entry.is_main = match (&current, std::fs::canonicalize(&entry.path).ok()) {
            (Some(current), Some(other)) => current == &other,
            _ => false,
        };
    }
    Ok(entries)
}

/// `worktree list --porcelain`은 빈 줄로 구분된 레코드를 낸다.
///
/// 한 레코드는 `worktree <path>`로 시작하고 `HEAD`, `branch`, `detached`, `bare`,
/// `prunable`이 뒤따른다. 값이 없는 키(`detached`)는 키만 온다.
fn parse_worktrees(raw: &str) -> Vec<WorktreeInfo> {
    let mut entries = Vec::new();
    let mut current: Option<WorktreeInfo> = None;

    for line in raw.lines() {
        let line = line.trim_end();
        if line.is_empty() {
            if let Some(entry) = current.take() {
                entries.push(entry);
            }
            continue;
        }

        let (key, value) = match line.split_once(' ') {
            Some((key, value)) => (key, value.trim()),
            None => (line, ""),
        };

        match key {
            "worktree" => {
                if let Some(entry) = current.take() {
                    entries.push(entry);
                }
                current = Some(WorktreeInfo {
                    path: value.to_string(),
                    branch: None,
                    head: String::new(),
                    is_main: false,
                    is_prunable: false,
                });
            }
            "HEAD" => {
                if let Some(entry) = current.as_mut() {
                    entry.head = value.to_string();
                }
            }
            "branch" => {
                if let Some(entry) = current.as_mut() {
                    entry.branch = Some(
                        value
                            .strip_prefix("refs/heads/")
                            .unwrap_or(value)
                            .to_string(),
                    );
                }
            }
            "prunable" => {
                if let Some(entry) = current.as_mut() {
                    entry.is_prunable = true;
                }
            }
            _ => {}
        }
    }

    if let Some(entry) = current.take() {
        entries.push(entry);
    }
    entries
}

/// `create_branch`가 켜져 있으면 새 브랜치를 만들며 워크트리를 연다.
#[tauri::command]
pub fn git_add_worktree(
    path: String,
    dir: String,
    branch: String,
    create_branch: bool,
) -> Result<OpResult, String> {
    let dir = validate_paths(&[dir])?.remove(0);
    let branch = validate_ref_name(&path, &branch)?;

    let args: Vec<&str> = if create_branch {
        vec!["worktree", "add", "-b", branch.as_str(), dir.as_str()]
    } else {
        vec!["worktree", "add", dir.as_str(), branch.as_str()]
    };

    run_op(&path, &args, LOCAL_TIMEOUT)
}

/// 워크트리를 걷어낸다. 안에 변경이 남아 있으면 `force` 없이는 git이 거절한다.
#[tauri::command]
pub fn git_remove_worktree(path: String, dir: String, force: bool) -> Result<OpResult, String> {
    let dir = validate_paths(&[dir])?.remove(0);

    let mut args: Vec<&str> = vec!["worktree", "remove"];
    if force {
        args.push("--force");
    }
    args.push(dir.as_str());

    run_op(&path, &args, LOCAL_TIMEOUT)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testrepo::TempRepo;

    #[test]
    fn porcelain_레코드를_워크트리로_읽는다() {
        let raw = "worktree /repo\nHEAD abc123\nbranch refs/heads/main\n\n\
                   worktree /repo-wt\nHEAD def456\ndetached\n\n\
                   worktree /gone\nHEAD 000\nbranch refs/heads/old\nprunable gitdir file points to non-existent location\n\n";
        let parsed = parse_worktrees(raw);

        assert_eq!(parsed.len(), 3);
        assert_eq!(parsed[0].path, "/repo");
        assert_eq!(parsed[0].branch.as_deref(), Some("main"));
        assert_eq!(parsed[0].head, "abc123");
        assert!(!parsed[0].is_prunable);

        assert_eq!(parsed[1].branch, None, "detached는 브랜치가 없다");
        assert!(parsed[2].is_prunable);

        assert!(parse_worktrees("").is_empty());
    }

    #[test]
    fn 워크트리를_열고_목록에서_보고_닫는다() {
        let repo = TempRepo::linear("gitlanes-worktree", 2);
        let linked = format!("{}-wt", repo.path());

        let added =
            git_add_worktree(repo.path(), linked.clone(), "side".to_string(), true).unwrap();
        assert!(added.ok, "{added:?}");

        let listed = list_worktrees(repo.path()).unwrap();
        assert_eq!(listed.len(), 2);
        let main = listed
            .iter()
            .find(|w| w.is_main)
            .expect("열어 둔 워크트리가 표시돼야 한다");
        assert_eq!(main.branch.as_deref(), Some("main"));
        let side = listed
            .iter()
            .find(|w| w.branch.as_deref() == Some("side"))
            .expect("새 워크트리가 목록에 있어야 한다");
        assert!(!side.is_main);
        assert!(!side.is_prunable);

        // 링크된 워크트리에서 보면 is_main이 반대로 붙는다
        let from_linked = list_worktrees(linked.clone()).unwrap();
        assert_eq!(
            from_linked
                .iter()
                .find(|w| w.is_main)
                .and_then(|w| w.branch.clone())
                .as_deref(),
            Some("side")
        );

        let removed = git_remove_worktree(repo.path(), linked.clone(), false).unwrap();
        assert!(removed.ok, "{removed:?}");
        assert_eq!(list_worktrees(repo.path()).unwrap().len(), 1);

        let _ = std::fs::remove_dir_all(&linked);
    }

    #[test]
    fn 이미_쓰는_브랜치로는_워크트리를_열_수_없다() {
        let repo = TempRepo::linear("gitlanes-worktree-busy", 2);
        let linked = format!("{}-busy", repo.path());

        // main은 이미 본체가 체크아웃하고 있다
        let result =
            git_add_worktree(repo.path(), linked.clone(), "main".to_string(), false).unwrap();
        assert!(!result.ok, "{result:?}");
        assert!(!result.stderr.is_empty(), "{result:?}");

        assert!(git_add_worktree(repo.path(), String::new(), "x".to_string(), true).is_err());
        assert!(git_add_worktree(repo.path(), linked, "-x".to_string(), true).is_err());
    }

    #[test]
    fn 없는_워크트리_삭제는_ok_false다() {
        let repo = TempRepo::linear("gitlanes-worktree-gone", 1);
        let result =
            git_remove_worktree(repo.path(), format!("{}-nope", repo.path()), false).unwrap();
        assert!(!result.ok, "{result:?}");
        assert!(git_remove_worktree(repo.path(), "  ".to_string(), false).is_err());
    }
}
