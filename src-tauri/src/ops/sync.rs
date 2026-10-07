//! 툴바가 5초마다 묻는 동기화 상태와, 진행 중인 머지/리베이스 판정.
//!
//! @see CONTRACTS.md

use std::path::Path;

use crate::git;
use crate::model::{PendingKind, PendingOp, SyncState};

use super::run::{collect_conflicts, git_dir};

/// 현재 브랜치의 upstream 대비 상태. 폴링에서 5초마다 불려서 네 호출을 병렬로 돈다.
#[tauri::command(async)]
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
///
/// 표식이 하나도 없어도 unmerged 파일이 있으면 [`PendingKind::Conflicts`]다. squash 머지와
/// stash pop/apply 충돌은 표식을 남기지 않는데, None을 돌려주면 충돌 패널이 뜨지 않아
/// 마커가 든 파일이 평범한 수정으로만 보인다.
pub fn detect_pending(repo: &str) -> Option<PendingOp> {
    let dir = git_dir(repo)?;
    let conflict_count = collect_conflicts(repo).len() as u32;
    let pending = |kind, progress, detail| {
        Some(PendingOp {
            kind,
            progress,
            conflict_count,
            detail,
        })
    };

    // rebase -i와 rebase --merge는 rebase-merge/, `git am` 기반 경로는 rebase-apply/를 쓴다
    if dir.join("rebase-merge").is_dir() {
        return pending(
            PendingKind::Rebase,
            progress_of(&dir, "rebase-merge", "msgnum", "end"),
            head_name(&dir.join("rebase-merge").join("head-name")),
        );
    }
    let apply = dir.join("rebase-apply");
    if apply.is_dir() {
        // `git am`도 rebase-apply/를 쓰고 applying 파일로 구분된다. rebase 명령을 보내면
        // "It looks like 'git am' is in progress"로 거절되어 Continue/Abort가 먹지 않는다.
        if apply.join("applying").is_file() {
            return pending(
                PendingKind::Am,
                progress_of(&dir, "rebase-apply", "next", "last"),
                None,
            );
        }
        return pending(
            PendingKind::Rebase,
            progress_of(&dir, "rebase-apply", "next", "last"),
            head_name(&apply.join("head-name")),
        );
    }
    if dir.join("MERGE_HEAD").is_file() {
        return pending(
            PendingKind::Merge,
            None,
            read_trimmed(&dir.join("MERGE_MSG"))
                .and_then(|msg| msg.lines().next().map(str::to_string)),
        );
    }
    if dir.join("CHERRY_PICK_HEAD").is_file() {
        return pending(PendingKind::CherryPick, None, None);
    }
    if dir.join("REVERT_HEAD").is_file() {
        return pending(PendingKind::Revert, None, None);
    }
    // 범위 cherry-pick/revert 도중 커밋 상자로 커밋하면 *_HEAD는 사라지고 sequencer만
    // 남는다. 여기서 None이면 남은 커밋이 적용되지 않은 채 배너가 사라진다.
    if let Some(kind) = sequencer_kind(&dir) {
        return pending(kind, None, None);
    }
    if conflict_count > 0 {
        return pending(PendingKind::Conflicts, None, None);
    }
    None
}

/// `sequencer/todo`의 첫 동작으로 cherry-pick과 revert를 가른다.
///
/// git은 todo에 `pick`/`revert`를 축약 없이 쓴다. 엉뚱한 쪽 명령을 보내면 git이
/// "cannot cherry-pick during a revert"로 거절하므로 첫 줄로 가려야 한다. 줄을 못 읽으면
/// (todo가 비어 있는 등) 더 흔한 cherry-pick으로 둔다.
fn sequencer_kind(dir: &Path) -> Option<PendingKind> {
    let todo = std::fs::read_to_string(dir.join("sequencer").join("todo")).ok()?;
    let first = todo
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty() && !line.starts_with('#'))
        .and_then(|line| line.split_whitespace().next());
    match first {
        Some("revert") => Some(PendingKind::Revert),
        _ => Some(PendingKind::CherryPick),
    }
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

    /// 실패가 정상인 git 명령(충돌하는 머지 등). TempRepo::git의 성공 단정을 피한다.
    fn git_may_fail(repo: &TempRepo, args: &[&str]) {
        let _ = std::process::Command::new("git")
            .current_dir(repo.path())
            .args(args)
            .output()
            .unwrap();
    }

    #[test]
    fn 새_pending_kind는_계약의_이름으로_직렬화된다() {
        // 프론트가 이 문자열을 그대로 git_pending_action에 되돌려 보낸다
        assert_eq!(serde_json::to_value(PendingKind::Am).unwrap(), "am");
        assert_eq!(
            serde_json::to_value(PendingKind::Conflicts).unwrap(),
            "conflicts"
        );
    }

    #[test]
    fn squash_머지_충돌은_conflicts로_보인다() {
        let repo = TempRepo::init("gitlanes-pending-squash");
        let branch = conflicting(&repo);
        git_may_fail(&repo, &["merge", "--squash", branch]);

        // squash는 MERGE_HEAD를 남기지 않는다. 표식이 없어도 충돌은 보여야 한다
        let pending = detect_pending(&repo.path()).expect("충돌이 보여야 한다");
        assert_eq!(pending.kind, PendingKind::Conflicts);
        assert_eq!(pending.conflict_count, 1);
    }

    #[test]
    fn stash_pop_충돌은_conflicts로_보인다() {
        let repo = TempRepo::init("gitlanes-pending-stash");
        conflicting(&repo);
        repo.write("c.txt", "stashed\n");
        repo.git(&["stash", "push", "-q"]);
        repo.write("c.txt", "committed\n");
        repo.git(&["commit", "-qam", "다시 고침"]);
        git_may_fail(&repo, &["stash", "pop"]);

        let pending = detect_pending(&repo.path()).expect("충돌이 보여야 한다");
        assert_eq!(pending.kind, PendingKind::Conflicts);
        assert_eq!(pending.conflict_count, 1);
    }

    #[test]
    fn 체리픽_범위_도중_커밋해도_sequencer가_남으면_cherry_pick이다() {
        let repo = TempRepo::init("gitlanes-pending-sequencer");
        let branch = conflicting(&repo);
        repo.git(&["checkout", "-q", branch]);
        repo.write("s3.txt", "s3\n");
        repo.git(&["add", "-A"]);
        repo.git(&["commit", "-qm", "s3"]);
        repo.git(&["checkout", "-q", "main"]);

        // other side(c.txt 충돌), s3 순서로 가져온다
        git_may_fail(&repo, &["cherry-pick", "other~1", "other"]);
        assert_eq!(
            detect_pending(&repo.path()).map(|p| p.kind),
            Some(PendingKind::CherryPick)
        );

        // 커밋 상자로 커밋하면 CHERRY_PICK_HEAD는 사라지고 sequencer만 남는다
        repo.write("c.txt", "resolved\n");
        repo.git(&["add", "-A"]);
        repo.git(&["commit", "-qm", "resolved"]);
        let dir = git_dir(&repo.path()).unwrap();
        assert!(!dir.join("CHERRY_PICK_HEAD").exists());
        assert!(dir.join("sequencer").join("todo").is_file());

        let pending = detect_pending(&repo.path()).expect("s3가 남아 있다");
        assert_eq!(pending.kind, PendingKind::CherryPick);
    }

    #[test]
    fn 리버트_범위_도중_커밋해도_sequencer가_남으면_revert다() {
        let repo = TempRepo::init("gitlanes-pending-sequencer-revert");
        repo.write("a.txt", "1\n");
        repo.git(&["add", "-A"]);
        repo.git(&["commit", "-qm", "base"]);
        repo.write("a.txt", "2\n");
        repo.git(&["commit", "-qam", "two"]);
        repo.write("a.txt", "3\n");
        repo.git(&["commit", "-qam", "three"]);
        repo.write("b.txt", "b\n");
        repo.git(&["add", "-A"]);
        repo.git(&["commit", "-qm", "b"]);

        // two(HEAD~2)를 되돌리면 three와 같은 줄이라 충돌하고, b(HEAD) 되돌리기가 남는다
        git_may_fail(&repo, &["revert", "--no-edit", "HEAD~2", "HEAD"]);
        repo.write("a.txt", "resolved\n");
        repo.git(&["add", "-A"]);
        repo.git(&["commit", "-qm", "resolved"]);

        let pending = detect_pending(&repo.path()).expect("남은 revert가 있다");
        assert_eq!(pending.kind, PendingKind::Revert);
    }

    #[test]
    fn git_am_진행은_am으로_보인다() {
        let repo = TempRepo::init("gitlanes-pending-am");
        let branch = conflicting(&repo);
        let patches = format!("{}-patches", repo.path());
        repo.git(&[
            "format-patch",
            "-q",
            "-o",
            &patches,
            &format!("main..{branch}"),
        ]);
        git_may_fail(
            &repo,
            &["am", "-3", &format!("{patches}/0001-other-side.patch")],
        );

        let pending = detect_pending(&repo.path()).expect("am이 진행 중이어야 한다");
        assert_eq!(pending.kind, PendingKind::Am);
        assert_eq!(pending.conflict_count, 1);
        assert_eq!(pending.progress.as_deref(), Some("1/1"));

        let _ = std::fs::remove_dir_all(&patches);
    }
}
