//! discard 되돌리기 (v0.24). 버리기 전후의 파일 내용을 git tree로 찍어 두었다가 되살린다.
//!
//! ref를 비교하는 다른 되돌리기([`super::undo`])와 달리 파일 내용을 다룬다.
//!
//! - **찍기**: 인덱스는 `write-tree` 그대로, 워킹 트리는 인덱스 사본에 대상 경로를 `add -A`한 뒤
//!   `write-tree`. 사본을 쓰므로 실제 인덱스는 움직이지 않고, untracked 파일도 담긴다.
//! - **되살리기**: 대상 경로가 지금도 discard 직후 그대로일 때만 한다. 그 사이 사용자가 파일을
//!   고쳤으면 되살리는 순간 그 수정을 덮어쓰므로 거절한다.
//!
//! @see docs/decisions.md#discard-되돌리기

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use crate::git;
use crate::model::{DiscardUndo, OpResult, WorkSnapshot};

use super::run::{finish, run_chain, run_op_with_env, validate_paths, Outcome, LOCAL_TIMEOUT};

const STALE_MESSAGE: &str =
    "The files changed since they were discarded. Undo would overwrite those changes, so it was skipped.";

/// 대상 경로의 인덱스와 워킹 트리 내용을 tree 두 개로 찍는다.
///
/// 충돌 중(unmerged 항목이 있는 인덱스)에는 `write-tree`가 실패해 `Err`가 된다. 프론트는 그때
/// 되돌리기만 포기하고 discard는 그대로 한다.
#[tauri::command(async)]
pub fn get_work_snapshot(path: String, files: Vec<String>) -> Result<WorkSnapshot, String> {
    let files = validate_paths(&files)?;
    let index = write_tree(&path, None)?;

    let temp = TempIndex::copy_of(&path)?;
    let present = present_paths(&path, &files);
    if !present.is_empty() {
        let mut args: Vec<&str> = vec!["add", "-A", "--"];
        args.extend(present.iter().map(String::as_str));
        let result = run_op_with_env(&path, &args, LOCAL_TIMEOUT, &temp.env())?;
        if !result.ok {
            return Err(format!(
                "Could not snapshot the files: {}",
                result.stderr.trim()
            ));
        }
    }
    let worktree = write_tree(&path, Some(&temp))?;
    Ok(WorkSnapshot { index, worktree })
}

/// [`super::undo::git_undo`]가 kind=discard일 때 부른다.
pub fn undo_discard(path: &str, undo: &DiscardUndo) -> Result<OpResult, String> {
    let files = validate_paths(&undo.files)?;
    for sha in [
        &undo.before.index,
        &undo.before.worktree,
        &undo.after.index,
        &undo.after.worktree,
    ] {
        if !super::undo::is_oid(sha) {
            return Err(format!("Invalid tree id: {sha}"));
        }
    }

    let current = get_work_snapshot(path.to_string(), files.clone())?;
    let now_worktree = entries(path, &current.worktree, &files)?;
    let mut stale = now_worktree != entries(path, &undo.after.worktree, &files)?;
    if undo.restore_index {
        stale |=
            entries(path, &current.index, &files)? != entries(path, &undo.after.index, &files)?;
    }
    if stale {
        return Ok(outcome(path, 1, STALE_MESSAGE));
    }

    let before_worktree = entries(path, &undo.before.worktree, &files)?;
    let source_index = format!("--source={}", undo.before.index);
    let source_worktree = format!("--source={}", undo.before.worktree);
    let (before_index, now_index) = if undo.restore_index {
        (
            entries(path, &undo.before.index, &files)?,
            entries(path, &current.index, &files)?,
        )
    } else {
        (BTreeMap::new(), BTreeMap::new())
    };
    let mut steps: Vec<Vec<&str>> = Vec::new();
    // discard 전에는 인덱스에 없던 경로(그 뒤 add된 것)는 인덱스에서 내린다
    let gone: Vec<&str> = now_index
        .keys()
        .filter(|name| !before_index.contains_key(*name))
        .map(String::as_str)
        .collect();
    if !gone.is_empty() {
        let mut args = vec!["rm", "--cached", "-q", "--ignore-unmatch", "--"];
        args.extend(gone);
        steps.push(args);
    }
    if !before_index.is_empty() {
        let mut args = vec!["restore", source_index.as_str(), "--staged", "--"];
        args.extend(before_index.keys().map(String::as_str));
        steps.push(args);
    }
    if !before_worktree.is_empty() {
        let mut args = vec!["restore", source_worktree.as_str(), "--worktree", "--"];
        args.extend(before_worktree.keys().map(String::as_str));
        steps.push(args);
    }

    let result = if steps.is_empty() {
        outcome(path, 0, "")
    } else {
        run_chain(path, &steps, LOCAL_TIMEOUT)?
    };
    if !result.ok {
        return Ok(result);
    }

    // discard가 되살린 파일(워킹 트리에서 지웠던 파일을 되돌린 경우)은 다시 지운다.
    // 경로는 git tree에서 나온 것이라 레포 바깥을 가리키지 않는다
    for name in now_worktree
        .keys()
        .filter(|name| !before_worktree.contains_key(*name))
    {
        let target = Path::new(path).join(name);
        if let Err(err) = std::fs::remove_file(&target) {
            if err.kind() != std::io::ErrorKind::NotFound {
                return Ok(outcome(path, 1, &format!("Could not remove {name}: {err}")));
            }
        }
    }
    Ok(result)
}

/// `tree`에서 `files` 아래 경로 → "mode sha". 디렉토리 경로(`newdir/`)는 그 안의 파일로 펼친다.
fn entries(repo: &str, tree: &str, files: &[String]) -> Result<BTreeMap<String, String>, String> {
    let mut args: Vec<&str> = vec!["ls-tree", "-r", "-z", "--full-tree", tree, "--"];
    args.extend(files.iter().map(String::as_str));
    let out = git::run(repo, &args)?;
    Ok(out
        .split('\0')
        .filter_map(|record| record.split_once('\t'))
        .map(|(meta, name)| {
            // "100644 blob <sha>"에서 type은 mode로 갈린다
            let mut parts = meta.split(' ');
            let mode = parts.next().unwrap_or_default();
            let sha = parts.nth(1).unwrap_or_default();
            (name.to_string(), format!("{mode} {sha}"))
        })
        .collect())
}

/// 디스크에 있거나 인덱스에 있는 경로. 둘 다 아니면 `add`가 "pathspec did not match"로 실패한다
/// (discard 직후 지워진 untracked 파일). 그런 경로는 tree에 없는 것이 맞으니 빼고 찍는다.
fn present_paths(repo: &str, files: &[String]) -> Vec<String> {
    let mut args: Vec<&str> = vec!["ls-files", "-z", "--"];
    args.extend(files.iter().map(String::as_str));
    let indexed = git::run(repo, &args).unwrap_or_default();
    let indexed: Vec<&str> = indexed
        .split('\0')
        .filter(|name| !name.is_empty())
        .collect();
    files
        .iter()
        .filter(|file| {
            Path::new(repo).join(file).symlink_metadata().is_ok()
                || indexed.iter().any(|name| {
                    *name == file.as_str()
                        || name
                            .strip_prefix(file.as_str())
                            .is_some_and(|rest| file.ends_with('/') || rest.starts_with('/'))
                })
        })
        .cloned()
        .collect()
}

fn write_tree(repo: &str, index: Option<&TempIndex>) -> Result<String, String> {
    let envs = index.map(TempIndex::env).unwrap_or_default();
    let result = run_op_with_env(repo, &["write-tree"], LOCAL_TIMEOUT, &envs)?;
    let sha = result.stdout.trim().to_string();
    if !result.ok || !super::undo::is_oid(&sha) {
        return Err(format!(
            "Could not snapshot the index: {}",
            result.stderr.trim()
        ));
    }
    Ok(sha)
}

fn outcome(repo: &str, code: i32, stderr: &str) -> OpResult {
    finish(
        repo,
        &[],
        Outcome {
            code: Some(code),
            stdout: String::new(),
            stderr: stderr.to_string(),
            timed_out: false,
        },
        LOCAL_TIMEOUT,
    )
}

/// 실제 인덱스의 사본. split index의 shared 파일을 같은 디렉토리에서 찾으므로 git 디렉토리 안에 둔다.
struct TempIndex {
    path: PathBuf,
}

impl TempIndex {
    fn copy_of(repo: &str) -> Result<Self, String> {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let name = format!(
            "gitlanes-snapshot-{}-{}.index",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        );
        let path = git_path(repo, &name)?;
        let real = git_path(repo, "index")?;
        // 첫 커밋 전에는 인덱스 파일이 없을 수 있다. 그러면 빈 인덱스에서 시작한다
        if real.exists() {
            std::fs::copy(&real, &path)
                .map_err(|err| format!("Could not copy the index: {err}"))?;
        }
        Ok(Self { path })
    }

    fn env(&self) -> Vec<(&'static str, String)> {
        vec![("GIT_INDEX_FILE", self.path.to_string_lossy().into_owned())]
    }
}

impl Drop for TempIndex {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.path);
    }
}

fn git_path(repo: &str, name: &str) -> Result<PathBuf, String> {
    let out = git::run(repo, &["rev-parse", "--git-path", name])?;
    Ok(Path::new(repo).join(out.trim()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{UndoEntry, UndoKind};
    use crate::ops::stage::{git_apply_patch, git_clean, git_discard};
    use crate::ops::undo::{get_ref_snapshot, git_undo};
    use crate::testrepo::TempRepo;

    fn repo() -> TempRepo {
        let repo = TempRepo::init("gitlanes-discard-undo");
        repo.write("a.txt", "a\n");
        repo.write("b.txt", "b\n");
        repo.git(&["add", "."]);
        repo.git(&["commit", "-q", "-m", "init"]);
        repo
    }

    fn read(repo: &TempRepo, name: &str) -> Option<String> {
        std::fs::read_to_string(Path::new(&repo.path()).join(name)).ok()
    }

    fn status(repo: &TempRepo) -> String {
        git::run(repo.path(), &["status", "--porcelain"]).unwrap()
    }

    /// 프론트 액션 계층이 하는 일: discard 전후로 ref와 파일 스냅샷을 찍어 항목을 만든다
    fn record(
        repo: &TempRepo,
        files: &[&str],
        restore_index: bool,
        action: impl FnOnce(),
    ) -> UndoEntry {
        let files: Vec<String> = files.iter().map(|name| name.to_string()).collect();
        let refs = get_ref_snapshot(repo.path()).unwrap();
        let before = get_work_snapshot(repo.path(), files.clone()).unwrap();
        action();
        UndoEntry {
            kind: UndoKind::Discard,
            label: "Undo discard".to_string(),
            before: refs.clone(),
            after: refs,
            reset_mode: None,
            discard: Some(DiscardUndo {
                files: files.clone(),
                restore_index,
                before,
                after: get_work_snapshot(repo.path(), files).unwrap(),
            }),
        }
    }

    #[test]
    fn 스냅샷은_실제_인덱스를_건드리지_않는다() {
        let repo = repo();
        repo.write("a.txt", "a2\n");
        repo.write("new.txt", "n\n");
        let before = status(&repo);
        get_work_snapshot(repo.path(), vec!["a.txt".into(), "new.txt".into()]).unwrap();
        assert_eq!(status(&repo), before);
    }

    #[test]
    fn worktree_discard를_되돌린다() {
        let repo = repo();
        repo.write("a.txt", "a2\n");
        repo.git(&["add", "a.txt"]);
        repo.write("a.txt", "a3\n");
        let entry = record(&repo, &["a.txt"], false, || {
            assert!(
                git_discard(repo.path(), vec!["a.txt".into()], "worktree".into())
                    .unwrap()
                    .ok
            );
        });
        assert_eq!(read(&repo, "a.txt").as_deref(), Some("a2\n"));

        let result = git_undo(repo.path(), entry).unwrap();
        assert!(result.ok, "{result:?}");
        assert_eq!(read(&repo, "a.txt").as_deref(), Some("a3\n"));
        assert_eq!(status(&repo), "MM a.txt\n");
    }

    #[test]
    fn all_discard는_staged_변경까지_되돌린다() {
        let repo = repo();
        repo.write("a.txt", "a2\n");
        repo.git(&["add", "a.txt"]);
        repo.write("a.txt", "a3\n");
        let entry = record(&repo, &["a.txt"], true, || {
            assert!(
                git_discard(repo.path(), vec!["a.txt".into()], "all".into())
                    .unwrap()
                    .ok
            );
        });
        assert_eq!(status(&repo), "");

        assert!(git_undo(repo.path(), entry).unwrap().ok);
        assert_eq!(status(&repo), "MM a.txt\n");
        assert_eq!(git::run(repo.path(), &["show", ":a.txt"]).unwrap(), "a2\n");
        assert_eq!(read(&repo, "a.txt").as_deref(), Some("a3\n"));
    }

    #[test]
    fn 새로_add한_파일의_all_discard를_되돌린다() {
        let repo = repo();
        repo.write("added.txt", "x\n");
        repo.git(&["add", "added.txt"]);
        let entry = record(&repo, &["added.txt"], true, || {
            assert!(
                git_discard(repo.path(), vec!["added.txt".into()], "all".into())
                    .unwrap()
                    .ok
            );
        });
        assert_eq!(read(&repo, "added.txt"), None);

        assert!(git_undo(repo.path(), entry).unwrap().ok);
        assert_eq!(status(&repo), "A  added.txt\n");
    }

    #[test]
    fn 지운_untracked_파일과_디렉토리를_되살린다() {
        let repo = repo();
        repo.write("note.txt", "memo\n");
        repo.write("newdir/x.txt", "x\n");
        let entry = record(&repo, &["note.txt", "newdir/"], false, || {
            assert!(
                git_clean(repo.path(), vec!["note.txt".into(), "newdir/".into()])
                    .unwrap()
                    .ok
            );
        });
        assert_eq!(read(&repo, "note.txt"), None);

        assert!(git_undo(repo.path(), entry).unwrap().ok);
        assert_eq!(read(&repo, "note.txt").as_deref(), Some("memo\n"));
        assert_eq!(read(&repo, "newdir/x.txt").as_deref(), Some("x\n"));
        assert_eq!(status(&repo), "?? newdir/\n?? note.txt\n");
    }

    #[test]
    fn 워킹_트리에서_지운_파일의_discard를_되돌리면_다시_지운다() {
        let repo = repo();
        std::fs::remove_file(Path::new(&repo.path()).join("b.txt")).unwrap();
        let entry = record(&repo, &["b.txt"], false, || {
            assert!(
                git_discard(repo.path(), vec!["b.txt".into()], "worktree".into())
                    .unwrap()
                    .ok
            );
        });
        assert_eq!(read(&repo, "b.txt").as_deref(), Some("b\n"));

        assert!(git_undo(repo.path(), entry).unwrap().ok);
        assert_eq!(read(&repo, "b.txt"), None);
        assert_eq!(status(&repo), " D b.txt\n");
    }

    #[test]
    fn hunk_discard를_되돌린다() {
        let repo = repo();
        repo.write("a.txt", "a\nmore\n");
        let patch = git::run(repo.path(), &["diff", "--", "a.txt"]).unwrap();
        let entry = record(&repo, &["a.txt"], false, || {
            let result = git_apply_patch(repo.path(), patch, false, true, "utf8".into()).unwrap();
            assert!(result.ok, "{result:?}");
        });
        assert_eq!(read(&repo, "a.txt").as_deref(), Some("a\n"));

        assert!(git_undo(repo.path(), entry).unwrap().ok);
        assert_eq!(read(&repo, "a.txt").as_deref(), Some("a\nmore\n"));
    }

    #[test]
    fn discard_뒤에_파일을_고쳤으면_되돌리지_않는다() {
        let repo = repo();
        repo.write("a.txt", "a2\n");
        let entry = record(&repo, &["a.txt"], false, || {
            assert!(
                git_discard(repo.path(), vec!["a.txt".into()], "worktree".into())
                    .unwrap()
                    .ok
            );
        });
        repo.write("a.txt", "새로 고친 내용\n");

        let result = git_undo(repo.path(), entry).unwrap();
        assert!(!result.ok);
        assert_eq!(result.stderr, STALE_MESSAGE);
        assert_eq!(read(&repo, "a.txt").as_deref(), Some("새로 고친 내용\n"));
    }

    #[test]
    fn 다른_파일을_고친_것은_상관없다() {
        let repo = repo();
        repo.write("a.txt", "a2\n");
        let entry = record(&repo, &["a.txt"], false, || {
            assert!(
                git_discard(repo.path(), vec!["a.txt".into()], "worktree".into())
                    .unwrap()
                    .ok
            );
        });
        repo.write("b.txt", "b2\n");

        assert!(git_undo(repo.path(), entry).unwrap().ok);
        assert_eq!(read(&repo, "a.txt").as_deref(), Some("a2\n"));
        assert_eq!(read(&repo, "b.txt").as_deref(), Some("b2\n"));
    }

    #[test]
    fn 잘못된_tree_id는_거절한다() {
        let repo = repo();
        let mut entry = record(&repo, &["a.txt"], false, || {});
        if let Some(undo) = entry.discard.as_mut() {
            undo.before.worktree = "HEAD; rm -rf /".to_string();
        }
        assert!(git_undo(repo.path(), entry).is_err());
    }
}
