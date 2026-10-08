//! 작업 되돌리기. 쓰기 전후의 ref 스냅샷을 비교해 이전 상태로 돌린다.
//!
//! 되돌리기는 "그 작업이 바꾼 ref가 지금도 작업 직후 그대로일 때"만 한다. 그 사이 다른 작업
//! (다른 창, 터미널, 자동 fetch가 아닌 사용자 작업)이 같은 ref를 움직였다면 before로 되돌리는
//! 순간 그 작업을 덮어쓴다. 검사를 통과한 뒤의 ref 쓰기도 `update-ref`의 옛 값 인자로 묶어,
//! 검사와 쓰기 사이에 ref가 움직이면 git이 거절하게 한다.
//!
//! @see CONTRACTS.md

use std::collections::{BTreeMap, BTreeSet};

use crate::git;
use crate::model::{BranchUpstream, OpResult, RefSnapshot, ResetMode, UndoEntry, UndoKind};

use super::run::{finish, run_op, run_op_with_input, Outcome, LOCAL_TIMEOUT};

const STALE_MESSAGE: &str = "The repository changed since this action. Undo is no longer safe.";

/// reflog에 남는 이름. 사용자가 `git reflog`에서 무엇이 ref를 옮겼는지 알아보게 한다
const REFLOG_MESSAGE: &str = "undo (GitLanes)";

/// HEAD 브랜치, HEAD sha, 로컬 브랜치와 태그 전부, 브랜치 upstream 설정.
/// 쓰기마다 전후로 불리므로 git 네 번을 병렬로 돈다.
#[tauri::command(async)]
pub fn get_ref_snapshot(path: String) -> Result<RefSnapshot, String> {
    const HEAD_REF_ARGS: [&str; 3] = ["symbolic-ref", "-q", "HEAD"];
    const HEAD_SHA_ARGS: [&str; 4] = ["rev-parse", "--verify", "-q", "HEAD"];
    // objectname은 태그 객체 자체의 sha다(%(*objectname)이 가리키는 커밋). 삭제를 되돌릴 때 이 값이 있어야
    // annotated 태그가 메시지째 살아난다
    const REFS_ARGS: [&str; 4] = [
        "for-each-ref",
        "--format=%(objectname) %(refname)",
        "refs/heads",
        "refs/tags",
    ];

    // `git branch`가 쓰고 지우는 곳이 레포 설정이라 --local만 본다. 전역 설정의 같은 키를 되살린
    // 브랜치에 복사해 넣지 않기 위해서다
    const UPSTREAM_ARGS: [&str; 5] = [
        "config",
        "--local",
        "-z",
        "--get-regexp",
        r"^branch\..+\.(remote|merge)$",
    ];

    let mut outputs = git::run_all(
        &path,
        &[
            &HEAD_REF_ARGS[..],
            &HEAD_SHA_ARGS[..],
            &REFS_ARGS[..],
            &UPSTREAM_ARGS[..],
        ],
    )
    .into_iter();
    let head_ref = outputs.next().and_then(Result::ok);
    let head_sha = outputs.next().and_then(Result::ok);
    let refs = outputs
        .next()
        .ok_or_else(|| "Could not read refs.".to_string())??;
    // 일치하는 키가 없으면 git config가 exit 1로 끝난다. upstream이 하나도 없다는 뜻이다
    let upstream_config = outputs.next().and_then(Result::ok).unwrap_or_default();

    Ok(RefSnapshot {
        head_ref: head_ref
            .map(|out| out.trim().to_string())
            .filter(|name| !name.is_empty()),
        // unborn 브랜치는 HEAD를 풀 수 없어 rev-parse가 실패한다
        head_sha: head_sha
            .map(|out| out.trim().to_string())
            .unwrap_or_default(),
        refs: refs
            .lines()
            .filter_map(|line| line.split_once(' '))
            .map(|(sha, name)| (name.to_string(), sha.to_string()))
            .collect(),
        upstreams: parse_upstreams(&upstream_config),
    })
}

/// `git config -z --get-regexp`의 `키\n값\0` 목록에서 브랜치별 remote와 merge를 모은다.
///
/// 브랜치 이름에 `.`이 들어갈 수 있어(`release.v1`) 키는 앞의 `branch.`와 마지막 `.` 뒤의 변수
/// 이름만 떼고 가운데를 통째로 이름으로 본다. git이 소문자로 내리는 것은 섹션과 변수 이름뿐이고
/// 브랜치 이름(서브섹션)은 대소문자를 그대로 둔다. 같은 키가 여러 번 나오면 git처럼 마지막 값을 쓴다.
fn parse_upstreams(config: &str) -> BTreeMap<String, BranchUpstream> {
    let mut remotes: BTreeMap<&str, &str> = BTreeMap::new();
    let mut merges: BTreeMap<&str, &str> = BTreeMap::new();
    for (key, value) in config
        .split('\0')
        .filter_map(|entry| entry.split_once('\n'))
    {
        let Some((branch, variable)) = key
            .strip_prefix("branch.")
            .and_then(|rest| rest.rsplit_once('.'))
        else {
            continue;
        };
        match variable {
            "remote" => remotes.insert(branch, value),
            "merge" => merges.insert(branch, value),
            _ => None,
        };
    }
    remotes
        .into_iter()
        .filter_map(|(branch, remote)| {
            let merge = merges.get(branch)?;
            Some((
                format!("refs/heads/{branch}"),
                BranchUpstream {
                    remote: remote.to_string(),
                    merge: merge.to_string(),
                },
            ))
        })
        .collect()
}

/// `entry`의 작업을 되돌린다. kind별 복원 규칙은 types.ts `git_undo` 주석과 같다.
///
/// 상태가 작업 직후와 다르면 git을 실행하지 않고 `ok=false`로 이유를 돌려준다.
/// `Err`는 entry 자체가 잘못됐을 때(ref 이름, sha 형식, reset 모드 누락)만 쓴다.
#[tauri::command(async)]
pub fn git_undo(path: String, entry: UndoEntry) -> Result<OpResult, String> {
    validate_snapshot(&path, &entry.before)?;
    validate_snapshot(&path, &entry.after)?;
    for name in changed_refs(&entry.before, &entry.after) {
        validate_full_ref(&path, &name)?;
    }

    let current = get_ref_snapshot(path.clone())?;
    if !still_after(&entry, &current) {
        return Ok(refused(&path, STALE_MESSAGE));
    }

    match entry.kind {
        UndoKind::Commit | UndoKind::Amend => undo_commit(&path, &entry),
        UndoKind::Checkout => undo_checkout(&path, &entry),
        UndoKind::Reset => undo_reset(&path, &entry),
        UndoKind::CreateBranch
        | UndoKind::DeleteBranch
        | UndoKind::RenameBranch
        | UndoKind::CreateTag
        | UndoKind::DeleteTag => undo_refs(&path, &entry),
    }
}

/// before와 after 사이에서 바뀐 ref 이름. 한쪽에만 있는 ref(생성, 삭제)도 포함한다.
fn changed_refs(before: &RefSnapshot, after: &RefSnapshot) -> BTreeSet<String> {
    before
        .refs
        .keys()
        .chain(after.refs.keys())
        .filter(|name| before.refs.get(*name) != after.refs.get(*name))
        .cloned()
        .collect()
}

fn head_changed(before: &RefSnapshot, after: &RefSnapshot) -> bool {
    before.head_ref != after.head_ref || before.head_sha != after.head_sha
}

/// 이 작업이 바꾼 ref와 HEAD가 지금도 작업 직후 그대로인지. 다른 ref가 움직인 것은 상관없다.
fn still_after(entry: &UndoEntry, current: &RefSnapshot) -> bool {
    let (before, after) = (&entry.before, &entry.after);
    // commit/amend는 HEAD 브랜치를 되돌리므로 sha가 그대로여도(같은 초의 동일한 amend) 브랜치는 맞아야 한다
    let head_matters =
        head_changed(before, after) || matches!(entry.kind, UndoKind::Commit | UndoKind::Amend);
    if head_matters && (current.head_ref != after.head_ref || current.head_sha != after.head_sha) {
        return false;
    }
    changed_refs(before, after)
        .iter()
        .all(|name| current.refs.get(name) == after.refs.get(name))
}

/// 커밋 취소. 변경은 스테이지에 남는다.
fn undo_commit(path: &str, entry: &UndoEntry) -> Result<OpResult, String> {
    let (before, after) = (&entry.before, &entry.after);
    if !before.head_sha.is_empty() {
        // `reset --soft`와 같은 결과다. 변경은 스테이지에 남는다
        return move_head(path, after, &before.head_sha);
    }

    // 첫 커밋 취소. 되돌아갈 커밋이 없으니 브랜치를 지워 unborn으로 돌린다.
    // detached HEAD에 `update-ref -d HEAD`를 걸면 HEAD 파일이 지워져 레포가 깨지므로 브랜치만 다룬다
    let Some(branch) = after.head_ref.as_deref() else {
        return Ok(refused(
            path,
            "Cannot undo the first commit on a detached HEAD. Check out a branch first.",
        ));
    };
    run_op(
        path,
        &[
            "update-ref",
            "-m",
            REFLOG_MESSAGE,
            "-d",
            branch,
            after.head_sha.as_str(),
        ],
        LOCAL_TIMEOUT,
    )
}

/// HEAD(브랜치면 그 브랜치, detached면 HEAD 자체)를 `target`으로 옮긴다. index와 워킹트리는
/// 건드리지 않는다(`reset --soft`와 같다).
///
/// 옛 값으로 `after.headSha`를 넘겨서 [`still_after`] 검사 뒤에 누가 HEAD를 움직였으면 git이
/// 거절한다. `reset`은 옛 값을 받지 않아 검사와 실행 사이의 틈을 막지 못한다.
fn move_head(path: &str, after: &RefSnapshot, target: &str) -> Result<OpResult, String> {
    let mut args = vec!["update-ref", "-m", REFLOG_MESSAGE];
    match after.head_ref.as_deref() {
        Some(branch) => args.push(branch),
        // --no-deref가 없으면 HEAD가 가리키는 쪽을 따라가는데, detached라 그 자체를 바꾼다는 뜻을
        // 분명히 둔다. 그 사이 누가 브랜치를 체크아웃했다면 옛 값이 맞지 않아 거절된다
        None => args.extend(["--no-deref", "HEAD"]),
    }
    args.extend([target, after.head_sha.as_str()]);
    run_op(path, &args, LOCAL_TIMEOUT)
}

/// before의 HEAD로 checkout. 브랜치였으면 그 브랜치로, detached였으면 그 커밋으로.
/// 워킹트리가 막으면 git이 거절하고 그 stderr가 그대로 간다.
fn restore_head(path: &str, before: &RefSnapshot) -> Result<OpResult, String> {
    match before.head_ref.as_deref() {
        Some(full) => {
            let short = full
                .strip_prefix("refs/heads/")
                .ok_or_else(|| format!("HEAD was not a local branch: {full}"))?;
            // 끝의 `--`가 없으면 git은 ref를 못 찾았을 때 같은 이름의 경로를 인덱스에서 복원한다
            run_op(path, &["checkout", short, "--"], LOCAL_TIMEOUT)
        }
        None if before.head_sha.is_empty() => Ok(refused(
            path,
            "There was no commit to go back to before this action.",
        )),
        None => run_op(
            path,
            &["checkout", "--detach", before.head_sha.as_str(), "--"],
            LOCAL_TIMEOUT,
        ),
    }
}

fn undo_reset(path: &str, entry: &UndoEntry) -> Result<OpResult, String> {
    let mode = entry
        .reset_mode
        .ok_or_else(|| "This reset has no mode to undo with.".to_string())?;
    if entry.before.head_sha.is_empty() {
        return Ok(refused(
            path,
            "There was no commit to go back to before this action.",
        ));
    }
    if mode == ResetMode::Hard {
        // 되돌리는 hard reset이 그 뒤에 한 작업을 지운다. 추적되지 않은 파일도 대상 커밋에 같은
        // 경로가 있으면 덮어써지므로 `??`까지 포함해 비어 있어야 한다
        let status = git::run(path, &["status", "--porcelain"])?;
        if !status.trim().is_empty() {
            return Ok(refused(
                path,
                "You have uncommitted changes. Commit or stash them before undoing a hard reset.",
            ));
        }
    }

    // ref부터 옛 값으로 묶어 옮기고, index와 워킹트리는 옮긴 HEAD에 맞춘다. 대상 없는 reset은
    // HEAD를 움직이지 않아 그 사이에 다른 작업이 끼어도 ref를 덮어쓰지 않는다
    let moved = move_head(path, &entry.after, &entry.before.head_sha)?;
    let sync = match mode {
        ResetMode::Soft => None,
        ResetMode::Mixed => Some("--mixed"),
        ResetMode::Hard => Some("--hard"),
    };
    let Some(flag) = sync.filter(|_| moved.ok) else {
        return Ok(moved);
    };
    let synced = run_op(path, &["reset", flag, "-q"], LOCAL_TIMEOUT)?;
    Ok(merge_results(vec![moved, synced]).expect("두 결과를 합친다"))
}

/// checkout 되돌리기. HEAD를 돌린 뒤, 그 checkout이 새로 만든 로컬 브랜치(`origin/x`를 체크아웃해
/// 생긴 추적 브랜치)를 지우고 설정도 지운다.
///
/// 브랜치 삭제는 작업 직후 sha를 옛 값으로 묶는다. 그 사이 브랜치가 움직였으면 git이 거절하고
/// 브랜치는 남긴다. HEAD는 이미 돌아갔으니 결과는 성공으로 두고 남긴 이유만 덧붙인다.
fn undo_checkout(path: &str, entry: &UndoEntry) -> Result<OpResult, String> {
    let (before, after) = (&entry.before, &entry.after);
    let head = restore_head(path, before)?;
    let created: Vec<(&String, &String)> = after
        .refs
        .iter()
        .filter(|(name, _)| name.starts_with("refs/heads/") && !before.refs.contains_key(*name))
        .collect();
    if !head.ok || created.is_empty() {
        return Ok(head);
    }

    let deletes: String = created
        .iter()
        .map(|(name, sha)| format!("delete {name} {sha}\n"))
        .collect();
    let removed = ref_transaction(path, deletes)?;
    if !removed.ok {
        let names: Vec<&str> = created
            .iter()
            .map(|(name, _)| name.trim_start_matches("refs/heads/"))
            .collect();
        let note = format!(
            "Kept branch {} because it changed after the checkout.",
            names.join(", ")
        );
        return Ok(with_note(head, &note));
    }
    let notes = sync_branch_config(path, entry);
    let merged = merge_results(vec![head, removed]).expect("두 결과를 합친다");
    Ok(notes
        .iter()
        .fold(merged, |result, note| with_note(result, note)))
}

/// 브랜치와 태그의 생성, 삭제, 이름 변경 되돌리기.
///
/// 세 단계로 나눈다. 먼저 before에 있던 ref를 만들거나 옮기고, HEAD를 돌리고, 마지막에
/// 작업이 새로 만든 ref를 지운다. 순서가 중요한 경우가 두 가지다.
/// - 이름 변경된 브랜치가 HEAD: 옛 이름이 생긴 뒤에 HEAD를 옮겨야 HEAD가 없는 브랜치를 가리키는 순간이 없다
/// - checkout까지 한 브랜치 생성: 그 브랜치를 떠난 뒤에 지워야 HEAD가 사라진 ref를 가리키지 않는다
///
/// 각 단계 안의 ref 쓰기는 `update-ref --stdin` 한 트랜잭션이라 일부만 반영되지 않는다.
fn undo_refs(path: &str, entry: &UndoEntry) -> Result<OpResult, String> {
    let (before, after) = (&entry.before, &entry.after);
    let mut restores = String::new();
    let mut deletes = String::new();
    for name in changed_refs(before, after) {
        match (before.refs.get(&name), after.refs.get(&name)) {
            // 빈 옛 값은 "아직 없어야 한다"는 뜻이다. 그 사이 같은 이름이 생겼으면 거절된다
            (Some(old), None) => restores.push_str(&format!("create {name} {old}\n")),
            (Some(old), Some(new)) => restores.push_str(&format!("update {name} {old} {new}\n")),
            (None, Some(new)) => deletes.push_str(&format!("delete {name} {new}\n")),
            (None, None) => {}
        }
    }

    let mut results: Vec<OpResult> = Vec::new();
    if !restores.is_empty() {
        results.push(ref_transaction(path, restores)?);
    }
    if results.iter().all(|result| result.ok) && head_changed(before, after) {
        let head = if entry.kind == UndoKind::RenameBranch {
            point_head(path, before)?
        } else {
            restore_head(path, before)?
        };
        results.push(head);
    }
    if results.iter().all(|result| result.ok) && !deletes.is_empty() {
        results.push(ref_transaction(path, deletes)?);
    }
    // 설정은 ref 쓰기가 전부 성공한 뒤에만 건드린다. ref가 거절됐는데 설정만 바뀌면 남의 브랜치
    // 설정을 덮어쓴다
    let notes = if !results.is_empty() && results.iter().all(|result| result.ok) {
        sync_branch_config(path, entry)
    } else {
        Vec::new()
    };

    let merged = merge_results(results).unwrap_or_else(|| refused(path, "Nothing to undo."));
    Ok(notes
        .iter()
        .fold(merged, |result, note| with_note(result, note)))
}

fn ref_transaction(path: &str, commands: String) -> Result<OpResult, String> {
    run_op_with_input(
        path,
        &["update-ref", "-m", REFLOG_MESSAGE, "--stdin"],
        LOCAL_TIMEOUT,
        commands.into_bytes(),
    )
}

/// 이름 변경 취소에서 HEAD만 옛 이름으로 옮긴다. 커밋은 같으니 워킹트리는 건드리지 않는다.
fn point_head(path: &str, before: &RefSnapshot) -> Result<OpResult, String> {
    let Some(full) = before.head_ref.as_deref() else {
        return Ok(refused(
            path,
            "HEAD was not on a branch before this action.",
        ));
    };
    run_op(
        path,
        &["symbolic-ref", "-m", REFLOG_MESSAGE, "HEAD", full],
        LOCAL_TIMEOUT,
    )
}

/// ref를 되돌린 뒤 `branch.<이름>.*` 설정을 맞춘다. update-ref는 ref만 다루기 때문이다.
///
/// 1. 이름 변경: `git branch -m`이 옮긴 섹션을 옛 이름으로 되돌린다(upstream 말고 description 등도)
/// 2. 되돌리면서 지운 브랜치: 섹션째 지운다. `git branch -d`가 하는 일과 같다
/// 3. 되살린 브랜치: before의 upstream을 쓴다. `git branch -D`가 섹션을 지웠기 때문이다
///
/// 섹션이 없어서 1, 2가 실패하는 것은 정상이라 결과를 버린다. 3의 실패는 사람이 읽을 문구로 돌려준다.
fn sync_branch_config(path: &str, entry: &UndoEntry) -> Vec<String> {
    let (before, after) = (&entry.before, &entry.after);
    if entry.kind == UndoKind::RenameBranch {
        move_branch_config(path, before, after);
    }

    let local_branches = |from: &RefSnapshot, absent_in: &RefSnapshot| -> Vec<String> {
        from.refs
            .keys()
            .filter(|name| !absent_in.refs.contains_key(*name))
            .filter_map(|name| name.strip_prefix("refs/heads/"))
            .map(str::to_string)
            .collect()
    };
    for branch in local_branches(after, before) {
        let section = format!("branch.{branch}");
        let _ = run_op(
            path,
            &["config", "--local", "--remove-section", section.as_str()],
            LOCAL_TIMEOUT,
        );
    }

    let mut notes = Vec::new();
    for branch in local_branches(before, after) {
        let Some(upstream) = before.upstreams.get(&format!("refs/heads/{branch}")) else {
            continue;
        };
        if let Err(reason) = write_upstream(path, &branch, upstream) {
            notes.push(format!(
                "Restored branch {branch}, but not its upstream: {reason}"
            ));
        }
    }
    notes
}

/// `branch.<x>.remote`와 `branch.<x>.merge`를 쓴다. 이미 여러 값이 있어도 하나로 바꾼다.
fn write_upstream(path: &str, branch: &str, upstream: &BranchUpstream) -> Result<(), String> {
    for (variable, value) in [("remote", &upstream.remote), ("merge", &upstream.merge)] {
        let key = format!("branch.{branch}.{variable}");
        let result = run_op(
            path,
            &[
                "config",
                "--local",
                "--replace-all",
                key.as_str(),
                value.as_str(),
            ],
            LOCAL_TIMEOUT,
        )?;
        if !result.ok {
            return Err(result.stderr.trim().to_string());
        }
    }
    Ok(())
}

/// `git branch -m`은 upstream 같은 `branch.<이름>.*` 설정도 새 이름으로 옮긴다. 그 섹션을 옛 이름으로
/// 되돌린다. 설정이 없으면 git이 실패하는데 정상이라 결과를 버린다.
fn move_branch_config(path: &str, before: &RefSnapshot, after: &RefSnapshot) {
    let old_names: Vec<&str> = before
        .refs
        .keys()
        .filter(|name| !after.refs.contains_key(*name))
        .filter_map(|name| name.strip_prefix("refs/heads/"))
        .collect();
    let new_names: Vec<&str> = after
        .refs
        .keys()
        .filter(|name| !before.refs.contains_key(*name))
        .filter_map(|name| name.strip_prefix("refs/heads/"))
        .collect();
    if let ([old], [new]) = (old_names.as_slice(), new_names.as_slice()) {
        let from = format!("branch.{new}");
        let to = format!("branch.{old}");
        let _ = run_op(
            path,
            &["config", "--rename-section", from.as_str(), to.as_str()],
            LOCAL_TIMEOUT,
        );
    }
}

/// 여러 단계를 하나의 결과로. 마지막 단계의 ok와 command를 쓴다(실패했다면 거기서 멈췄다).
fn merge_results(results: Vec<OpResult>) -> Option<OpResult> {
    results.into_iter().reduce(|previous, next| OpResult {
        stdout: join(&previous.stdout, &next.stdout),
        stderr: join(&previous.stderr, &next.stderr),
        ..next
    })
}

/// 결과는 그대로 두고 stderr 끝에 알림 한 줄을 붙인다.
fn with_note(result: OpResult, note: &str) -> OpResult {
    OpResult {
        stderr: join(&result.stderr, note),
        ..result
    }
}

fn join(first: &str, second: &str) -> String {
    match (first.trim().is_empty(), second.trim().is_empty()) {
        (true, _) => second.to_string(),
        (_, true) => first.to_string(),
        _ => format!("{}\n{}", first.trim_end(), second),
    }
}

/// git을 돌리지 않고 실패 결과를 만든다. command는 비워 둔다. 터미널에서 다시 실행할 명령이 없다
fn refused(path: &str, message: &str) -> OpResult {
    let outcome = Outcome {
        code: Some(1),
        stdout: String::new(),
        stderr: message.to_string(),
        timed_out: false,
    };
    finish(path, &[], outcome, LOCAL_TIMEOUT)
}

/// 프론트가 돌려보낸 스냅샷을 그대로 git 인자와 `update-ref --stdin` 줄에 쓰므로, 줄바꿈이나
/// 공백이 섞인 이름으로 다른 ref를 건드리지 못하게 막는다.
fn validate_snapshot(path: &str, snapshot: &RefSnapshot) -> Result<(), String> {
    if !snapshot.head_sha.is_empty() && !is_oid(&snapshot.head_sha) {
        return Err(format!("Invalid commit id: {}", snapshot.head_sha));
    }
    if let Some(head) = snapshot.head_ref.as_deref() {
        validate_full_ref(path, head)?;
    }
    if let Some((name, _)) = snapshot.refs.iter().find(|(_, sha)| !is_oid(sha)) {
        return Err(format!("Invalid object id for {name}"));
    }
    // git으로 묻는 검사는 바뀐 ref만 한다([`git_undo`]). 스냅샷에는 레포의 모든 ref가 있다
    if let Some(bad) = snapshot.refs.keys().find(|name| !looks_like_full_ref(name)) {
        return Err(format!("Invalid ref name: {bad}"));
    }
    Ok(())
}

fn validate_full_ref(path: &str, name: &str) -> Result<(), String> {
    if !looks_like_full_ref(name) {
        return Err(format!("Invalid ref name: {name}"));
    }
    git::run(path, &["check-ref-format", name])
        .map(|_| ())
        .map_err(|_| format!("Invalid ref name: {name}"))
}

/// 로컬 브랜치나 태그의 전체 이름이고, 인자나 stdin 줄을 깨뜨릴 글자가 없다.
/// git의 이름 규칙 전부는 아니지만 공백과 제어 문자를 막으면 주입은 불가능하다.
fn looks_like_full_ref(name: &str) -> bool {
    (name.starts_with("refs/heads/") || name.starts_with("refs/tags/"))
        && !name.chars().any(|c| c.is_whitespace() || c.is_control())
}

/// SHA-1(40)과 SHA-256(64) 레포 둘 다.
fn is_oid(text: &str) -> bool {
    matches!(text.len(), 40 | 64) && text.bytes().all(|b| b.is_ascii_hexdigit())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testrepo::TempRepo;

    fn snapshot(repo: &TempRepo) -> RefSnapshot {
        get_ref_snapshot(repo.path()).unwrap()
    }

    /// 프론트 액션 계층이 하는 일: 작업 전후로 스냅샷을 찍어 항목을 만든다
    fn record(repo: &TempRepo, kind: UndoKind, action: impl FnOnce()) -> UndoEntry {
        let before = snapshot(repo);
        action();
        UndoEntry {
            kind,
            label: format!("Undo {kind:?}"),
            before,
            after: snapshot(repo),
            reset_mode: None,
        }
    }

    fn undo(repo: &TempRepo, entry: &UndoEntry) -> OpResult {
        git_undo(repo.path(), entry.clone()).unwrap()
    }

    fn out(repo: &TempRepo, args: &[&str]) -> String {
        git::run(repo.path(), args).unwrap().trim().to_string()
    }

    fn base() -> TempRepo {
        TempRepo::linear("gitlanes-undo", 2)
    }

    #[test]
    fn 스냅샷은_head와_브랜치와_태그_객체_sha를_담는다() {
        let repo = base();
        repo.git(&["branch", "topic", "HEAD~1"]);
        repo.git(&["tag", "light"]);
        repo.git(&["tag", "-a", "-m", "릴리스", "v1"]);

        let snap = snapshot(&repo);
        assert_eq!(snap.head_ref.as_deref(), Some("refs/heads/main"));
        assert_eq!(snap.head_sha, repo.rev("HEAD"));
        assert_eq!(snap.refs["refs/heads/topic"], repo.rev("HEAD~1"));
        assert_eq!(snap.refs["refs/tags/light"], repo.rev("HEAD"));
        // annotated 태그는 커밋이 아니라 태그 객체 sha
        assert_eq!(snap.refs["refs/tags/v1"], repo.rev("refs/tags/v1"));
        assert_ne!(snap.refs["refs/tags/v1"], repo.rev("HEAD"));
        assert_eq!(snap.refs.len(), 4);

        repo.git(&["checkout", "-q", "--detach", "HEAD~1"]);
        let detached = snapshot(&repo);
        assert_eq!(detached.head_ref, None);
        assert_eq!(detached.head_sha, repo.rev("HEAD"));

        let empty = TempRepo::init("gitlanes-undo-empty");
        let unborn = snapshot(&empty);
        assert_eq!(unborn.head_ref.as_deref(), Some("refs/heads/main"));
        assert_eq!(unborn.head_sha, "");
        assert!(unborn.refs.is_empty());
    }

    #[test]
    fn 커밋_취소는_변경을_스테이지에_남긴다() {
        let repo = base();
        let old_head = repo.rev("HEAD");
        let entry = record(&repo, UndoKind::Commit, || {
            repo.write("new.txt", "새 파일\n");
            repo.git(&["add", "new.txt"]);
            repo.git(&["commit", "-qm", "추가"]);
        });

        let result = undo(&repo, &entry);
        assert!(result.ok, "{result:?}");
        assert_eq!(repo.rev("HEAD"), old_head);
        assert_eq!(out(&repo, &["symbolic-ref", "HEAD"]), "refs/heads/main");
        assert_eq!(out(&repo, &["diff", "--cached", "--name-only"]), "new.txt");
    }

    #[test]
    fn amend_취소는_원래_커밋으로_돌린다() {
        let repo = base();
        let old_head = repo.rev("HEAD");
        let entry = record(&repo, UndoKind::Amend, || {
            repo.git(&["commit", "-q", "--amend", "-m", "고친 메시지"]);
        });
        assert_ne!(entry.after.head_sha, old_head);

        let result = undo(&repo, &entry);
        assert!(result.ok, "{result:?}");
        assert_eq!(repo.rev("HEAD"), old_head);
    }

    #[test]
    fn 첫_커밋_취소는_브랜치를_unborn으로_돌린다() {
        let repo = TempRepo::init("gitlanes-undo-root");
        let entry = record(&repo, UndoKind::Commit, || {
            repo.write("a.txt", "a\n");
            repo.git(&["add", "a.txt"]);
            repo.git(&["commit", "-qm", "첫 커밋"]);
        });

        let result = undo(&repo, &entry);
        assert!(result.ok, "{result:?}");
        assert_eq!(snapshot(&repo).head_sha, "");
        assert_eq!(out(&repo, &["diff", "--cached", "--name-only"]), "a.txt");
    }

    #[test]
    fn checkout_취소는_원래_브랜치로_돌아간다() {
        let repo = base();
        repo.git(&["branch", "topic", "HEAD~1"]);
        let entry = record(&repo, UndoKind::Checkout, || {
            repo.git(&["checkout", "-q", "topic"]);
        });

        let result = undo(&repo, &entry);
        assert!(result.ok, "{result:?}");
        assert!(result.command.contains(&"--".to_string()), "{result:?}");
        assert_eq!(out(&repo, &["symbolic-ref", "HEAD"]), "refs/heads/main");
        assert_eq!(repo.rev("HEAD"), entry.before.head_sha);
    }

    #[test]
    fn detached에서_한_checkout_취소는_그_커밋으로_돌아간다() {
        let repo = base();
        repo.git(&["checkout", "-q", "--detach", "HEAD~1"]);
        let detached_at = repo.rev("HEAD");
        let entry = record(&repo, UndoKind::Checkout, || {
            repo.git(&["checkout", "-q", "main"]);
        });

        let result = undo(&repo, &entry);
        assert!(result.ok, "{result:?}");
        assert_eq!(snapshot(&repo).head_ref, None);
        assert_eq!(repo.rev("HEAD"), detached_at);
    }

    #[test]
    fn 브랜치_생성_취소는_브랜치를_지운다() {
        let repo = base();
        let entry = record(&repo, UndoKind::CreateBranch, || {
            repo.git(&["branch", "topic", "HEAD~1"]);
        });

        let result = undo(&repo, &entry);
        assert!(result.ok, "{result:?}");
        assert_eq!(snapshot(&repo), entry.before);
    }

    #[test]
    fn checkout까지_한_브랜치_생성_취소는_원래_브랜치로_돌아간_뒤_지운다() {
        let repo = base();
        let entry = record(&repo, UndoKind::CreateBranch, || {
            repo.git(&["checkout", "-qb", "topic"]);
        });

        let result = undo(&repo, &entry);
        assert!(result.ok, "{result:?}");
        assert_eq!(snapshot(&repo), entry.before);
    }

    #[test]
    fn 스냅샷은_remote와_merge가_다_있는_브랜치의_upstream만_담는다() {
        let repo = base();
        repo.git(&["branch", "release.v1"]);
        repo.git(&["config", "branch.release.v1.remote", "origin"]);
        repo.git(&["config", "branch.release.v1.merge", "refs/heads/release.v1"]);
        repo.git(&["branch", "Topic"]);
        repo.git(&["config", "branch.Topic.remote", "."]);
        repo.git(&["config", "branch.Topic.merge", "refs/heads/main"]);
        repo.git(&["branch", "half"]);
        repo.git(&["config", "branch.half.remote", "origin"]);

        let upstreams = snapshot(&repo).upstreams;
        assert_eq!(
            upstreams.get("refs/heads/release.v1"),
            Some(&BranchUpstream {
                remote: "origin".to_string(),
                merge: "refs/heads/release.v1".to_string(),
            })
        );
        // 브랜치 이름의 대소문자는 그대로
        assert_eq!(upstreams["refs/heads/Topic"].remote, ".");
        assert_eq!(upstreams.len(), 2, "{upstreams:?}");
    }

    #[test]
    fn upstream_파싱은_마지막_점에서_변수_이름을_자른다() {
        let parsed = parse_upstreams(
            "branch.a.b.c.remote\nup\0branch.a.b.c.merge\nrefs/heads/x\0branch.a.b.c.merge\nrefs/heads/y\0branch.lone\0",
        );
        assert_eq!(parsed.len(), 1);
        assert_eq!(parsed["refs/heads/a.b.c"].remote, "up");
        // 같은 키가 여럿이면 git처럼 마지막 값
        assert_eq!(parsed["refs/heads/a.b.c"].merge, "refs/heads/y");
        assert!(parse_upstreams("").is_empty());
    }

    #[test]
    fn upstream은_바뀐_ref_판단에_쓰지_않는다() {
        let repo = base();
        let entry = record(&repo, UndoKind::CreateTag, || {
            repo.git(&["tag", "v1"]);
        });
        repo.git(&["config", "branch.main.remote", "origin"]);
        repo.git(&["config", "branch.main.merge", "refs/heads/main"]);

        let result = undo(&repo, &entry);
        assert!(result.ok, "{result:?}");
    }

    #[test]
    fn 브랜치_삭제_취소는_upstream_설정도_되살린다() {
        let repo = base();
        repo.git(&["branch", "release.v1", "HEAD~1"]);
        repo.git(&["config", "branch.release.v1.remote", "origin"]);
        repo.git(&["config", "branch.release.v1.merge", "refs/heads/release.v1"]);
        let entry = record(&repo, UndoKind::DeleteBranch, || {
            repo.git(&["branch", "-D", "release.v1"]);
        });
        assert!(
            entry.after.upstreams.is_empty(),
            "git branch -D가 설정을 지운다"
        );

        let result = undo(&repo, &entry);
        assert!(result.ok, "{result:?}");
        assert_eq!(snapshot(&repo), entry.before);
        assert_eq!(
            out(&repo, &["config", "branch.release.v1.remote"]),
            "origin"
        );
    }

    #[test]
    fn 추적_브랜치_생성_취소는_upstream_설정도_지운다() {
        let repo = base();
        let entry = record(&repo, UndoKind::CreateBranch, || {
            repo.git(&["branch", "--track", "topic", "main"]);
        });
        assert!(entry.after.upstreams.contains_key("refs/heads/topic"));

        let result = undo(&repo, &entry);
        assert!(result.ok, "{result:?}");
        assert_eq!(snapshot(&repo), entry.before);
        assert!(git::run(repo.path(), &["config", "branch.topic.merge"]).is_err());
    }

    #[test]
    fn 브랜치_삭제_취소가_거절되면_설정도_쓰지_않는다() {
        let repo = base();
        repo.git(&["branch", "topic", "HEAD~1"]);
        repo.git(&["config", "branch.topic.remote", "origin"]);
        repo.git(&["config", "branch.topic.merge", "refs/heads/topic"]);
        let entry = record(&repo, UndoKind::DeleteBranch, || {
            repo.git(&["branch", "-D", "topic"]);
        });
        repo.git(&["branch", "--no-track", "topic", "HEAD"]);

        // 검사를 건너뛰고 쓰기 단계만 불러 ref 쓰기 실패를 만든다
        let result = undo_refs(&repo.path(), &entry).unwrap();
        assert!(!result.ok, "{result:?}");
        assert!(git::run(repo.path(), &["config", "branch.topic.remote"]).is_err());
    }

    #[test]
    fn head가_아닌_점_든_브랜치_이름_변경_취소는_설정을_옛_이름으로_돌린다() {
        let repo = base();
        repo.git(&["branch", "release.v1", "HEAD~1"]);
        repo.git(&["config", "branch.release.v1.remote", "origin"]);
        repo.git(&["config", "branch.release.v1.merge", "refs/heads/release.v1"]);
        let entry = record(&repo, UndoKind::RenameBranch, || {
            repo.git(&["branch", "-m", "release.v1", "release.v2"]);
        });

        let result = undo(&repo, &entry);
        assert!(result.ok, "{result:?}");
        assert_eq!(snapshot(&repo), entry.before);
        assert!(git::run(repo.path(), &["config", "branch.release.v2.remote"]).is_err());
    }

    /// origin에 feature가 있는 클론. `checkout --track origin/feature`가 로컬 feature를 새로 만든다
    fn clone_with_remote_feature() -> (TempRepo, TempRepo) {
        let origin = base();
        origin.git(&["branch", "feature", "HEAD~1"]);
        let clone = TempRepo::clone_of("gitlanes-undo-clone", &origin.path());
        (origin, clone)
    }

    #[test]
    fn checkout이_만든_추적_브랜치는_checkout_취소가_지우고_설정도_지운다() {
        let (_origin, repo) = clone_with_remote_feature();
        let entry = record(&repo, UndoKind::Checkout, || {
            repo.git(&["checkout", "-q", "--track", "origin/feature"]);
        });
        assert!(entry.after.refs.contains_key("refs/heads/feature"));

        let result = undo(&repo, &entry);
        assert!(result.ok, "{result:?}");
        assert_eq!(out(&repo, &["symbolic-ref", "HEAD"]), "refs/heads/main");
        assert_eq!(snapshot(&repo), entry.before);
        assert!(git::run(repo.path(), &["config", "branch.feature.remote"]).is_err());
    }

    #[test]
    fn 추적_브랜치가_그_사이_움직였으면_head만_돌리고_브랜치는_남긴다() {
        let (_origin, repo) = clone_with_remote_feature();
        let mut entry = record(&repo, UndoKind::Checkout, || {
            repo.git(&["checkout", "-q", "--track", "origin/feature"]);
        });
        let feature = repo.rev("feature");
        // 검사 뒤에 feature가 움직인 경쟁을 옛 값 불일치로 만든다
        entry
            .after
            .refs
            .insert("refs/heads/feature".to_string(), repo.rev("main"));

        let result = undo_checkout(&repo.path(), &entry).unwrap();
        assert!(result.ok, "{result:?}");
        assert!(result.stderr.contains("Kept branch feature"), "{result:?}");
        assert_eq!(out(&repo, &["symbolic-ref", "HEAD"]), "refs/heads/main");
        assert_eq!(repo.rev("feature"), feature);
        assert_eq!(out(&repo, &["config", "branch.feature.remote"]), "origin");
    }

    #[test]
    fn 브랜치_삭제_취소는_같은_sha로_다시_만든다() {
        let repo = base();
        repo.git(&["branch", "topic", "HEAD~1"]);
        let entry = record(&repo, UndoKind::DeleteBranch, || {
            repo.git(&["branch", "-D", "topic"]);
        });

        let result = undo(&repo, &entry);
        assert!(result.ok, "{result:?}");
        assert_eq!(snapshot(&repo), entry.before);
    }

    #[test]
    fn head_브랜치_이름_변경_취소는_head와_upstream_설정도_옛_이름으로_돌린다() {
        let repo = base();
        repo.git(&["config", "branch.main.remote", "origin"]);
        repo.git(&["config", "branch.main.merge", "refs/heads/main"]);
        let entry = record(&repo, UndoKind::RenameBranch, || {
            repo.git(&["branch", "-m", "main", "trunk"]);
        });
        assert_eq!(entry.after.head_ref.as_deref(), Some("refs/heads/trunk"));

        let result = undo(&repo, &entry);
        assert!(result.ok, "{result:?}");
        assert_eq!(snapshot(&repo), entry.before);
        assert_eq!(out(&repo, &["config", "branch.main.remote"]), "origin");
        assert!(git::run(repo.path(), &["config", "branch.trunk.remote"]).is_err());
    }

    #[test]
    fn head가_아닌_브랜치_이름_변경_취소() {
        let repo = base();
        repo.git(&["branch", "topic", "HEAD~1"]);
        let entry = record(&repo, UndoKind::RenameBranch, || {
            repo.git(&["branch", "-m", "topic", "feature"]);
        });

        let result = undo(&repo, &entry);
        assert!(result.ok, "{result:?}");
        assert_eq!(snapshot(&repo), entry.before);
    }

    #[test]
    fn 태그_생성_취소는_태그를_지운다() {
        let repo = base();
        let entry = record(&repo, UndoKind::CreateTag, || {
            repo.git(&["tag", "-a", "-m", "릴리스", "v1"]);
        });

        let result = undo(&repo, &entry);
        assert!(result.ok, "{result:?}");
        assert_eq!(snapshot(&repo), entry.before);
    }

    #[test]
    fn annotated_태그_삭제_취소는_태그_객체째_메시지까지_되살린다() {
        let repo = base();
        repo.git(&["tag", "-a", "-m", "첫 릴리스 노트", "v1"]);
        let entry = record(&repo, UndoKind::DeleteTag, || {
            repo.git(&["tag", "-d", "v1"]);
        });

        let result = undo(&repo, &entry);
        assert!(result.ok, "{result:?}");
        assert_eq!(snapshot(&repo), entry.before);
        assert_eq!(out(&repo, &["cat-file", "-t", "refs/tags/v1"]), "tag");
        assert_eq!(
            out(&repo, &["tag", "-l", "--format=%(contents)", "v1"]),
            "첫 릴리스 노트"
        );
    }

    fn reset_entry(repo: &TempRepo, mode: ResetMode, flag: &str) -> UndoEntry {
        let mut entry = record(repo, UndoKind::Reset, || {
            repo.git(&["reset", "-q", flag, "HEAD~1"]);
        });
        entry.reset_mode = Some(mode);
        entry
    }

    #[test]
    fn soft와_mixed_reset_취소는_같은_모드로_되돌린다() {
        // soft는 ref만 옮기고, mixed는 ref를 옮긴 뒤 index를 HEAD에 맞춘다(마지막 단계의 command)
        for (mode, flag, last) in [
            (ResetMode::Soft, "--soft", "update-ref"),
            (ResetMode::Mixed, "--mixed", "--mixed"),
        ] {
            let repo = base();
            let old_head = repo.rev("HEAD");
            let entry = reset_entry(&repo, mode, flag);

            let result = undo(&repo, &entry);
            assert!(result.ok, "{mode:?} {result:?}");
            assert!(result.command.contains(&last.to_string()), "{result:?}");
            assert_eq!(repo.rev("HEAD"), old_head, "{mode:?}");
            // 두 모드 모두 reset 전 상태(깨끗한 index와 워킹트리)로 돌아온다
            assert_eq!(out(&repo, &["status", "--porcelain"]), "", "{mode:?}");
            assert_eq!(
                out(&repo, &["reflog", "-1", "--format=%gs", "main"]),
                REFLOG_MESSAGE,
                "{mode:?}"
            );
        }
    }

    #[test]
    fn detached_head에서_한_커밋_취소는_head_자체를_옮긴다() {
        let repo = base();
        repo.git(&["checkout", "-q", "--detach"]);
        let old_head = repo.rev("HEAD");
        let entry = record(&repo, UndoKind::Commit, || {
            repo.write("d.txt", "d\n");
            repo.git(&["add", "d.txt"]);
            repo.git(&["commit", "-qm", "detached"]);
        });

        let result = undo(&repo, &entry);
        assert!(result.ok, "{result:?}");
        assert!(
            result.command.contains(&"--no-deref".to_string()),
            "{result:?}"
        );
        assert_eq!(repo.rev("HEAD"), old_head);
        assert_eq!(snapshot(&repo).head_ref, None);
        assert_eq!(repo.rev("main"), old_head);
        assert_eq!(out(&repo, &["diff", "--cached", "--name-only"]), "d.txt");
    }

    /// 검사([`still_after`]) 통과 뒤 HEAD가 움직인 경쟁 상황. 검사를 건너뛰고 쓰기 단계만 부른다
    #[test]
    fn 검사_뒤에_head가_움직이면_커밋_취소를_git이_거절한다() {
        let repo = base();
        let entry = record(&repo, UndoKind::Commit, || {
            repo.write("a.txt", "a\n");
            repo.git(&["add", "a.txt"]);
            repo.git(&["commit", "-qm", "a"]);
        });
        repo.git(&["commit", "-q", "--allow-empty", "-m", "끼어든 커밋"]);
        let moved = repo.rev("HEAD");

        let result = undo_commit(&repo.path(), &entry).unwrap();
        assert!(!result.ok, "{result:?}");
        assert_eq!(repo.rev("HEAD"), moved);
    }

    #[test]
    fn 검사_뒤에_head가_움직이면_detached_커밋_취소도_거절한다() {
        let repo = base();
        repo.git(&["checkout", "-q", "--detach"]);
        let entry = record(&repo, UndoKind::Amend, || {
            repo.git(&["commit", "-q", "--amend", "-m", "고친 메시지"]);
        });
        repo.git(&["commit", "-q", "--allow-empty", "-m", "끼어든 커밋"]);
        let moved = repo.rev("HEAD");

        let result = undo_commit(&repo.path(), &entry).unwrap();
        assert!(!result.ok, "{result:?}");
        assert_eq!(repo.rev("HEAD"), moved);
    }

    #[test]
    fn 검사_뒤에_head가_움직이면_reset_취소는_ref도_워킹트리도_건드리지_않는다() {
        for (mode, flag) in [
            (ResetMode::Soft, "--soft"),
            (ResetMode::Mixed, "--mixed"),
            (ResetMode::Hard, "--hard"),
        ] {
            let repo = base();
            let entry = reset_entry(&repo, mode, flag);
            repo.git(&["add", "-A"]);
            repo.git(&["commit", "-q", "--allow-empty", "-m", "끼어든 커밋"]);
            let moved = repo.rev("HEAD");
            let status = out(&repo, &["status", "--porcelain"]);

            let result = undo_reset(&repo.path(), &entry).unwrap();
            assert!(!result.ok, "{mode:?} {result:?}");
            // 실패한 update-ref에서 멈춰 뒤따르는 reset이 돌지 않았다
            assert!(
                result.command.contains(&"update-ref".to_string()),
                "{result:?}"
            );
            assert_eq!(repo.rev("HEAD"), moved, "{mode:?}");
            assert_eq!(out(&repo, &["status", "--porcelain"]), status, "{mode:?}");
        }
    }

    #[test]
    fn hard_reset_취소는_깨끗한_워킹트리에서만_한다() {
        let repo = base();
        let old_head = repo.rev("HEAD");
        let entry = reset_entry(&repo, ResetMode::Hard, "--hard");

        repo.write("scratch.txt", "작업 중\n");
        let refused = undo(&repo, &entry);
        assert!(!refused.ok, "{refused:?}");
        assert!(refused.stderr.contains("uncommitted"), "{refused:?}");
        assert!(refused.command.is_empty(), "{refused:?}");
        assert_eq!(repo.rev("HEAD"), entry.after.head_sha);

        std::fs::remove_file(std::path::Path::new(&repo.path()).join("scratch.txt")).unwrap();
        let result = undo(&repo, &entry);
        assert!(result.ok, "{result:?}");
        assert_eq!(repo.rev("HEAD"), old_head);
        assert_eq!(out(&repo, &["status", "--porcelain"]), "");
    }

    #[test]
    fn reset_모드가_없는_항목은_오류다() {
        let repo = base();
        let entry = record(&repo, UndoKind::Reset, || {
            repo.git(&["reset", "-q", "--soft", "HEAD~1"]);
        });
        assert!(git_undo(repo.path(), entry).is_err());
    }

    #[test]
    fn 그_사이_다른_커밋이_생기면_거절하고_아무것도_바꾸지_않는다() {
        let repo = base();
        let entry = record(&repo, UndoKind::Commit, || {
            repo.write("a.txt", "a\n");
            repo.git(&["add", "a.txt"]);
            repo.git(&["commit", "-qm", "a"]);
        });
        repo.write("b.txt", "b\n");
        repo.git(&["add", "b.txt"]);
        repo.git(&["commit", "-qm", "b"]);
        let now = snapshot(&repo);

        let result = undo(&repo, &entry);
        assert!(!result.ok, "{result:?}");
        assert_eq!(result.stderr, STALE_MESSAGE);
        assert_eq!(snapshot(&repo), now);
        assert_eq!(out(&repo, &["status", "--porcelain"]), "");
    }

    #[test]
    fn 지운_브랜치를_그_사이_다시_만들었으면_거절한다() {
        let repo = base();
        repo.git(&["branch", "topic", "HEAD~1"]);
        let entry = record(&repo, UndoKind::DeleteBranch, || {
            repo.git(&["branch", "-D", "topic"]);
        });
        repo.git(&["branch", "topic", "HEAD"]);

        let result = undo(&repo, &entry);
        assert!(!result.ok, "{result:?}");
        assert_eq!(repo.rev("topic"), repo.rev("HEAD"));
    }

    /// 검사([`still_after`])와 쓰기 사이에 ref가 움직인 경쟁 상황. 검사를 건너뛰고 쓰기 단계만 부른다
    #[test]
    fn 검사_뒤에_ref가_움직여도_update_ref의_옛_값이_덮어쓰기를_막는다() {
        let repo = base();
        repo.git(&["branch", "topic", "HEAD~1"]);
        let deleted = record(&repo, UndoKind::DeleteBranch, || {
            repo.git(&["branch", "-D", "topic"]);
        });
        let created = record(&repo, UndoKind::CreateBranch, || {
            repo.git(&["branch", "fresh", "HEAD~1"]);
        });
        repo.git(&["branch", "topic", "HEAD"]);
        repo.git(&["branch", "-f", "fresh", "HEAD"]);

        let recreate = undo_refs(&repo.path(), &deleted).unwrap();
        assert!(!recreate.ok, "{recreate:?}");
        assert_eq!(repo.rev("topic"), repo.rev("HEAD"));

        let delete = undo_refs(&repo.path(), &created).unwrap();
        assert!(!delete.ok, "{delete:?}");
        assert_eq!(repo.rev("fresh"), repo.rev("HEAD"));
    }

    #[test]
    fn 작업과_무관한_ref가_바뀐_것은_막지_않는다() {
        let repo = base();
        let entry = record(&repo, UndoKind::CreateTag, || {
            repo.git(&["tag", "v1"]);
        });
        repo.git(&["branch", "unrelated"]);

        let result = undo(&repo, &entry);
        assert!(result.ok, "{result:?}");
        assert!(!snapshot(&repo).refs.contains_key("refs/tags/v1"));
        assert!(snapshot(&repo).refs.contains_key("refs/heads/unrelated"));
    }

    #[test]
    fn 줄바꿈이_섞인_ref_이름은_update_ref에_닿기_전에_거절한다() {
        let repo = base();
        repo.git(&["branch", "keep"]);
        let mut entry = record(&repo, UndoKind::CreateTag, || {
            repo.git(&["tag", "v1"]);
        });
        let sha = entry.after.refs.remove("refs/tags/v1").unwrap();
        entry
            .after
            .refs
            .insert("refs/tags/v1 x\ndelete refs/heads/keep".to_string(), sha);

        assert!(git_undo(repo.path(), entry).is_err());
        assert!(snapshot(&repo).refs.contains_key("refs/heads/keep"));
    }

    #[test]
    fn undo_entry는_types_ts_모양으로_역직렬화된다() {
        let json = r#"{
            "kind": "renameBranch",
            "label": "Undo rename",
            "before": { "headRef": null, "headSha": "", "refs": {}, "upstreams": {} },
            "after": {
                "headRef": "refs/heads/main", "headSha": "", "refs": {},
                "upstreams": { "refs/heads/main": { "remote": "origin", "merge": "refs/heads/main" } }
            },
            "resetMode": "hard"
        }"#;
        let entry: UndoEntry = serde_json::from_str(json).unwrap();
        assert_eq!(entry.kind, UndoKind::RenameBranch);
        assert_eq!(entry.reset_mode, Some(ResetMode::Hard));
        assert_eq!(entry.after.head_ref.as_deref(), Some("refs/heads/main"));
        assert_eq!(entry.after.upstreams["refs/heads/main"].remote, "origin");
        assert_eq!(
            serde_json::to_value(&entry.after).unwrap()["upstreams"]["refs/heads/main"]["merge"],
            "refs/heads/main"
        );
    }
}
