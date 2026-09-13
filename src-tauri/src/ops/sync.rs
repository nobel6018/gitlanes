//! 툴바가 5초마다 묻는 동기화 상태와, 진행 중인 머지/리베이스 판정.
//!
//! @see CONTRACTS.md

use std::path::Path;

use crate::git;
use crate::model::{PendingKind, PendingOp, SyncState};

use super::run::{collect_conflicts, git_dir};

/// 현재 브랜치의 upstream 대비 상태. 폴링에서 5초마다 불려서 네 호출을 병렬로 돈다.
#[tauri::command]
pub fn get_sync_state(path: String) -> Result<SyncState, String> {
    const BRANCH_ARGS: [&str; 4] = ["symbolic-ref", "--short", "-q", "HEAD"];
    const UPSTREAM_ARGS: [&str; 4] = ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"];
    const COUNT_ARGS: [&str; 4] = ["rev-list", "--left-right", "--count", "@{u}...HEAD"];
    const STASH_ARGS: [&str; 2] = ["stash", "list"];

    let outputs = git::run_all(
        &path,
        &[
            &BRANCH_ARGS[..],
            &UPSTREAM_ARGS[..],
            &COUNT_ARGS[..],
            &STASH_ARGS[..],
        ],
    );
    let [branch_out, upstream_out, count_out, stash_out] =
        <[_; 4]>::try_from(outputs).expect("run_all은 넘긴 수만큼 결과를 돌려준다");

    let branch = branch_out
        .ok()
        .map(|out| out.trim().to_string())
        .filter(|branch| !branch.is_empty());
    let upstream = upstream_out
        .ok()
        .map(|out| out.trim().to_string())
        .filter(|upstream| !upstream.is_empty());

    // upstream이 없으면 이 호출도 실패한다. 그때는 0/0이다.
    let (behind, ahead) = count_out
        .ok()
        .and_then(|out| parse_left_right(&out))
        .unwrap_or((0, 0));

    let stash_count = stash_out
        .map(|out| out.lines().filter(|line| !line.trim().is_empty()).count() as u32)
        .unwrap_or(0);

    Ok(SyncState {
        branch,
        upstream,
        ahead,
        behind,
        stash_count,
        pending: detect_pending(&path),
    })
}

/// `rev-list --left-right --count @{u}...HEAD`의 "behind\tahead"를 쪼갠다.
///
/// 왼쪽이 upstream에만 있는 커밋(= behind), 오른쪽이 HEAD에만 있는 커밋(= ahead)이다.
pub fn parse_left_right(out: &str) -> Option<(u32, u32)> {
    let mut parts = out.split_whitespace();
    let left = parts.next()?.parse().ok()?;
    let right = parts.next()?.parse().ok()?;
    Some((left, right))
}

/// 진행 중인 작업을 `.git` 안의 표식 파일로 판정한다.
///
/// 리베이스를 먼저 본다. 리베이스 도중 충돌이 나면 git이 내부적으로 cherry-pick을 쓰기
/// 때문에 `CHERRY_PICK_HEAD`가 함께 존재할 수 있다. 순서를 뒤집으면 리베이스가
/// 체리픽으로 보이고, 프론트가 `--continue` 대신 엉뚱한 명령을 보낸다.
pub fn detect_pending(repo: &str) -> Option<PendingOp> {
    let dir = git_dir(repo)?;
    let conflict_count = collect_conflicts(repo).len() as u32;

    // rebase -i와 rebase --merge는 rebase-merge/, `git am` 기반 경로는 rebase-apply/를 쓴다
    if dir.join("rebase-merge").is_dir() {
        return Some(PendingOp {
            kind: PendingKind::Rebase,
            progress: progress_of(&dir, "rebase-merge", "msgnum", "end"),
            conflict_count,
            detail: head_name(&dir.join("rebase-merge").join("head-name")),
        });
    }
    if dir.join("rebase-apply").is_dir() {
        // rebase-apply는 `git am` 도 쓴다. applying 파일이 있으면 리베이스가 아니지만
        // 프론트에서 할 일(continue/abort/skip)이 같아 구분하지 않는다.
        return Some(PendingOp {
            kind: PendingKind::Rebase,
            progress: progress_of(&dir, "rebase-apply", "next", "last"),
            conflict_count,
            detail: head_name(&dir.join("rebase-apply").join("head-name")),
        });
    }
    if dir.join("MERGE_HEAD").is_file() {
        return Some(PendingOp {
            kind: PendingKind::Merge,
            progress: None,
            conflict_count,
            detail: read_trimmed(&dir.join("MERGE_MSG"))
                .and_then(|msg| msg.lines().next().map(str::to_string)),
        });
    }
    if dir.join("CHERRY_PICK_HEAD").is_file() {
        return Some(PendingOp {
            kind: PendingKind::CherryPick,
            progress: None,
            conflict_count,
            detail: None,
        });
    }
    if dir.join("REVERT_HEAD").is_file() {
        return Some(PendingOp {
            kind: PendingKind::Revert,
            progress: None,
            conflict_count,
            detail: None,
        });
    }
    None
}

/// "3/12" 형태의 진행도. 둘 중 하나라도 못 읽으면 None이다.
fn progress_of(dir: &Path, subdir: &str, current: &str, total: &str) -> Option<String> {
    let base = dir.join(subdir);
    let current = read_trimmed(&base.join(current))?;
    let total = read_trimmed(&base.join(total))?;
    if current.is_empty() || total.is_empty() {
        return None;
    }
    Some(format!("{current}/{total}"))
}

/// `head-name`은 "refs/heads/foo"로 적혀 있다. 화면에는 "foo"만 보여준다.
fn head_name(path: &Path) -> Option<String> {
    let raw = read_trimmed(path)?;
    Some(raw.strip_prefix("refs/heads/").unwrap_or(&raw).to_string())
}

fn read_trimmed(path: &Path) -> Option<String> {
    std::fs::read_to_string(path)
        .ok()
        .map(|text| text.trim().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testrepo::TempRepo;

    #[test]
    fn left_right_출력을_behind_ahead로_읽는다() {
        assert_eq!(parse_left_right("2\t5\n"), Some((2, 5)));
        assert_eq!(parse_left_right("0 0"), Some((0, 0)));
        assert_eq!(parse_left_right(""), None);
        assert_eq!(parse_left_right("fatal: no upstream"), None);
    }

    /// 충돌하는 두 갈래를 만든다. 반환값은 (충돌 브랜치 이름).
    fn conflicting(repo: &TempRepo) -> &'static str {
        repo.write("c.txt", "base\n");
        repo.git(&["add", "-A"]);
        repo.git(&["commit", "-qm", "base"]);
        repo.git(&["checkout", "-qb", "other"]);
        repo.write("c.txt", "other\n");
        repo.git(&["add", "-A"]);
        repo.git(&["commit", "-qm", "other side"]);
        repo.git(&["checkout", "-q", "main"]);
        repo.write("c.txt", "main\n");
        repo.git(&["add", "-A"]);
        repo.git(&["commit", "-qm", "main side"]);
        "other"
    }

    #[test]
    fn 깨끗한_저장소는_pending이_없다() {
        let repo = TempRepo::linear("gitlanes-pending-clean", 2);
        assert_eq!(detect_pending(&repo.path()), None);
        assert_eq!(get_sync_state(repo.path()).unwrap().pending, None);
    }

    #[test]
    fn 머지_충돌은_pending_merge로_보인다() {
        let repo = TempRepo::init("gitlanes-pending-merge");
        let branch = conflicting(&repo);

        // 실패하는 머지라 TempRepo::git의 성공 단정을 쓸 수 없다
        let _ = std::process::Command::new("git")
            .current_dir(repo.path())
            .args(["merge", "--no-edit", branch])
            .output()
            .unwrap();

        let pending = detect_pending(&repo.path()).expect("머지가 진행 중이어야 한다");
        assert_eq!(pending.kind, PendingKind::Merge);
        assert_eq!(pending.conflict_count, 1);
        assert_eq!(pending.progress, None);

        let state = get_sync_state(repo.path()).unwrap();
        assert_eq!(state.pending.map(|p| p.kind), Some(PendingKind::Merge));
    }

    #[test]
    fn 리베이스_충돌은_진행도와_브랜치_이름을_담는다() {
        let repo = TempRepo::init("gitlanes-pending-rebase");
        let branch = conflicting(&repo);
        repo.git(&["checkout", "-q", branch]);

        let _ = std::process::Command::new("git")
            .current_dir(repo.path())
            .args(["rebase", "main"])
            .output()
            .unwrap();

        let pending = detect_pending(&repo.path()).expect("리베이스가 진행 중이어야 한다");
        assert_eq!(pending.kind, PendingKind::Rebase);
        assert_eq!(pending.conflict_count, 1);
        assert_eq!(pending.progress.as_deref(), Some("1/1"));
        assert_eq!(pending.detail.as_deref(), Some("other"));
    }

    #[test]
    fn 워크트리에서도_자기_git_디렉토리를_본다() {
        // 링크된 워크트리의 표식은 <main>/.git/worktrees/<name>에 있다. <dir>/.git을
        // 디렉토리로 가정하면 여기서 None이 나온다.
        let repo = TempRepo::init("gitlanes-pending-worktree");
        let branch = conflicting(&repo);
        let linked = format!("{}-linked", repo.path());
        repo.git(&["worktree", "add", "-q", &linked, branch]);

        assert_eq!(detect_pending(&linked), None);

        let _ = std::process::Command::new("git")
            .current_dir(&linked)
            .args(["rebase", "main"])
            .output()
            .unwrap();

        let pending = detect_pending(&linked).expect("링크된 워크트리의 리베이스를 봐야 한다");
        assert_eq!(pending.kind, PendingKind::Rebase);
        // 본체 워크트리는 여전히 깨끗하다
        assert_eq!(detect_pending(&repo.path()), None);

        let _ = std::fs::remove_dir_all(&linked);
    }
}
