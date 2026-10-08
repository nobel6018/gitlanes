//! 서브모듈 목록과 포인터 변경 (v0.19). 전부 읽기 전용이다.
//!
//! 최상위 서브모듈만 다룬다. 중첩 서브모듈은 프론트가 그 서브모듈을 새 탭으로 열어서 본다.
//!
//! # 사용자 설정
//!
//! `submodule.<name>.ignore`와 `diff.ignoreSubmodules`는 레포의 의도라 덮지 않는다. 그 결과
//! `ignore=all`인 서브모듈은 `status`에서 빠져 dirty가 늘 false다. 반면 `submodule status`는
//! 이 설정을 보지 않아 moved는 그대로 보인다(git 2.50 실측, handoff-rust19.md).
//!
//! @see CONTRACTS.md (v0.19.0)

use std::collections::HashMap;
use std::path::{Component, Path, PathBuf};

use crate::commands::{first_line_parents, resolve_in_repo, validate_pathspec, validate_rev};
use crate::git;
use crate::inspect::{diff_range, merge_base, parse_summaries, SUMMARY_FORMAT};
use crate::model::{SubmoduleChange, SubmoduleChangeSource, SubmoduleInfo, SubmoduleState};
use crate::parse::GITLINK_MODE;

const GITMODULES: &str = ".gitmodules";

/// `.gitmodules`의 `submodule.<name>.*` 전부. 값이 없으면 종료 코드 1이다.
const GITMODULES_ARGS: [&str; 6] = [
    "config",
    "-f",
    GITMODULES,
    "-z",
    "--get-regexp",
    r"^submodule\.",
];

/// `.gitmodules`의 한 항목
#[derive(Debug, Clone, Default, PartialEq, Eq)]
struct ModuleEntry {
    name: String,
    path: Option<String>,
    url: Option<String>,
    branch: Option<String>,
}

/// 상위 레포 index에서 본 gitlink
#[derive(Debug, Clone, Default, PartialEq, Eq)]
struct IndexEntry {
    /// stage 0의 sha. 충돌 중이면 None
    recorded: Option<String>,
    /// stage 1~3 항목이 있다
    conflicted: bool,
}

/// 서브모듈 목록. 경로순이다.
///
/// git 호출은 서브모듈 수와 관계없이 최대 4회다: `.gitmodules` 읽기 → index의 gitlink →
/// (`status` ∥ `submodule status`). `.gitmodules`가 없으면 git을 부르지 않는다.
///
/// `submodule status`에는 index에 gitlink로 있는 경로만 넘긴다. 경로를 안 넘기면 `.gitmodules`에
/// 없는 gitlink 하나 때문에 전체가 128로 끝나고, 없는 경로를 넘기면 pathspec 오류로 끝난다.
#[tauri::command(async)]
pub fn get_submodules(path: String) -> Result<Vec<SubmoduleInfo>, String> {
    if !has_gitmodules(&path) {
        return Ok(Vec::new());
    }

    let modules = read_gitmodules(&path)?;
    if modules.is_empty() {
        return Ok(Vec::new());
    }
    let paths: Vec<&str> = modules
        .iter()
        .filter_map(|module| module.path.as_deref())
        .collect();

    let mut ls_args: Vec<&str> = vec!["ls-files", "--stage", "-z", "--"];
    ls_args.extend(&paths);
    let index = parse_index_gitlinks(
        &git::run(&path, &ls_args).map_err(|e| format!("Could not read the submodules: {e}"))?,
    );

    let mut tracked: Vec<&str> = paths
        .iter()
        .copied()
        .filter(|path| index.contains_key(*path))
        .collect();
    tracked.sort_unstable();
    tracked.dedup();

    let (dirty, heads) = if tracked.is_empty() {
        (HashMap::new(), HashMap::new())
    } else {
        let mut status_args: Vec<&str> = vec!["status", "--porcelain=v2", "-z", "--"];
        status_args.extend(&tracked);
        let mut submodule_args: Vec<&str> = vec!["submodule", "status", "--"];
        submodule_args.extend(&tracked);
        let outputs = git::run_all(&path, &[&status_args[..], &submodule_args[..]]);
        let [status_out, submodule_out] =
            <[_; 2]>::try_from(outputs).expect("run_all은 넘긴 수만큼 결과를 돌려준다");
        let status_out = status_out.map_err(|e| format!("Could not read the submodules: {e}"))?;
        let submodule_out =
            submodule_out.map_err(|e| format!("Could not read the submodules: {e}"))?;
        (
            parse_status_dirty(&status_out),
            parse_submodule_status(&submodule_out, &tracked),
        )
    };

    let mut seen = std::collections::HashSet::new();
    let mut infos: Vec<SubmoduleInfo> = modules
        .into_iter()
        .filter_map(|module| {
            let sub_path = module.path.clone()?;
            // 같은 경로를 두 이름이 가리키면 git처럼 처음 것만 쓴다
            if !seen.insert(sub_path.clone()) {
                return None;
            }
            let index_entry = index.get(&sub_path).cloned().unwrap_or_default();
            let head = heads.get(&sub_path);
            let state = match head {
                _ if index_entry.conflicted => SubmoduleState::Conflict,
                Some((prefix, _)) => state_of(*prefix),
                // index에 없다(.gitmodules만 고치고 add 전). 체크아웃이 있으면 열 수는 있다
                None if has_checkout(&path, &sub_path) => SubmoduleState::Ok,
                None => SubmoduleState::Uninitialized,
            };
            let head_sha = match (state, head) {
                (SubmoduleState::Ok | SubmoduleState::Moved, Some((_, sha))) => Some(sha.clone()),
                _ => None,
            };
            let dirty = state != SubmoduleState::Uninitialized
                && dirty.get(&sub_path).copied().unwrap_or(false);
            Some(SubmoduleInfo {
                name: module.name,
                path: sub_path,
                url: module.url,
                branch: module.branch,
                recorded_sha: index_entry.recorded,
                head_sha,
                state,
                dirty,
            })
        })
        .collect();
    infos.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(infos)
}

/// 서브모듈 포인터 변경 하나. old/new를 읽고 서브모듈 저장소에서 사이의 커밋을 센다.
///
/// 서브모듈 저장소는 체크아웃(`<repo>/<subPath>/.git`이 있을 때)이나 상위 레포의
/// `modules/<name>`으로 연다. `.git`이 없는 빈 디렉토리에 `git -C`를 걸면 git이 위로 올라가
/// **상위 레포**를 찾아서, 상위 레포의 커밋을 서브모듈 커밋인 것처럼 읽는다.
#[tauri::command(async)]
pub fn get_submodule_change(
    path: String,
    sub_path: String,
    source: SubmoduleChangeSource,
    limit: usize,
) -> Result<SubmoduleChange, String> {
    let sub_path = validate_pathspec(&sub_path)?;
    let (old_sha, new_sha, dirty) = read_pointers(&path, &sub_path, &source)?;

    let mut change = SubmoduleChange {
        path: sub_path.clone(),
        old_sha,
        new_sha,
        dirty,
        available: false,
        ahead: Vec::new(),
        behind: Vec::new(),
        ahead_truncated: false,
        behind_truncated: false,
    };
    if change.old_sha.is_none() && change.new_sha.is_none() {
        return Ok(change);
    }
    let Some(repo) = submodule_repo(&path, &sub_path) else {
        return Ok(change);
    };

    match (change.old_sha.as_deref(), change.new_sha.as_deref()) {
        (Some(old), Some(new)) => {
            let max_count = format!("--max-count={}", limit.saturating_add(1));
            let ahead_range = format!("{old}..{new}");
            let behind_range = format!("{new}..{old}");
            let log_args = |range: &str| -> Vec<String> {
                [
                    "log",
                    "--no-color",
                    "--no-show-signature",
                    SUMMARY_FORMAT,
                    max_count.as_str(),
                    range,
                    "--",
                ]
                .map(str::to_string)
                .to_vec()
            };
            let ahead_args = log_args(&ahead_range);
            let behind_args = log_args(&behind_range);
            let outputs = git::run_all(&repo, &[&ahead_args[..], &behind_args[..]]);
            let [ahead_out, behind_out] =
                <[_; 2]>::try_from(outputs).expect("run_all은 넘긴 수만큼 결과를 돌려준다");
            // 둘 중 하나라도 못 읽으면(fetch 안 된 커밋) 목록 전체를 믿을 수 없다
            if let (Ok(ahead_out), Ok(behind_out)) = (ahead_out, behind_out) {
                let mut ahead = parse_summaries(&ahead_out);
                let mut behind = parse_summaries(&behind_out);
                change.ahead_truncated = ahead.len() > limit;
                change.behind_truncated = behind.len() > limit;
                ahead.truncate(limit);
                behind.truncate(limit);
                change.ahead = ahead;
                change.behind = behind;
                change.available = true;
            }
        }
        // 추가나 삭제: 사이의 커밋이라는 개념이 없다. 남은 쪽 커밋을 읽을 수 있는지만 본다
        (Some(sha), None) | (None, Some(sha)) => {
            let spec = format!("{sha}^{{commit}}");
            change.available = git::run(&repo, &["cat-file", "-e", spec.as_str()]).is_ok();
        }
        (None, None) => {}
    }
    Ok(change)
}

type PointerPair = (Option<String>, Option<String>);

/// source별 (old, new, dirty).
fn read_pointers(
    path: &str,
    sub_path: &str,
    source: &SubmoduleChangeSource,
) -> Result<(Option<String>, Option<String>, bool), String> {
    // `--no-abbrev`: raw의 sha가 기본으로 7자로 잘린다. `--no-renames`: 경로 하나라 짝이 없다
    const RAW: [&str; 5] = [
        "--raw",
        "-z",
        "--no-abbrev",
        "--no-renames",
        "--no-ext-diff",
    ];
    let fail = |e: String| format!("Could not read the submodule change: {e}");

    match source {
        SubmoduleChangeSource::Commit { sha } => {
            let sha = validate_rev(sha)?;
            let parents = first_line_parents(path, &sha)?;
            let first_parent = format!("{sha}^1");
            let mut args: Vec<&str> = if parents.is_empty() {
                // 루트 커밋: show가 빈 트리와 비교해 준다
                vec!["show", "--format="]
            } else {
                vec!["diff"]
            };
            args.extend(RAW);
            if !parents.is_empty() {
                args.push(first_parent.as_str());
            }
            args.extend([sha.as_str(), "--", sub_path]);
            let out = git::run(path, &args).map_err(fail)?;
            let (old, new) = committed_pointer(&out, || tree_gitlink(path, &sha, sub_path));
            Ok((old, new, false))
        }
        SubmoduleChangeSource::Compare { base, head } => {
            let base = validate_rev(base)?;
            let head = validate_rev(head)?;
            let ancestor = merge_base(path, &base, &head)?;
            let range = diff_range(&base, &head, ancestor.as_deref());
            let mut args: Vec<&str> = vec!["diff"];
            args.extend(RAW);
            args.extend(range.iter().map(String::as_str));
            args.extend(["--", sub_path]);
            let out = git::run(path, &args).map_err(fail)?;
            let (old, new) = committed_pointer(&out, || tree_gitlink(path, &head, sub_path));
            Ok((old, new, false))
        }
        SubmoduleChangeSource::Staged => {
            let mut args: Vec<&str> = vec!["diff", "--cached"];
            args.extend(RAW);
            args.extend(["--", sub_path]);
            let out = git::run(path, &args).map_err(fail)?;
            let (old, new) = committed_pointer(&out, || index_gitlink(path, sub_path));
            Ok((old, new, false))
        }
        SubmoduleChangeSource::Unstaged => {
            let mut diff_args: Vec<&str> = vec!["diff"];
            diff_args.extend(RAW);
            diff_args.extend(["--", sub_path]);
            let status_args = ["status", "--porcelain=v2", "-z", "--", sub_path];
            let outputs = git::run_all(path, &[&diff_args[..], &status_args[..]]);
            let [diff_out, status_out] =
                <[_; 2]>::try_from(outputs).expect("run_all은 넘긴 수만큼 결과를 돌려준다");
            let dirty = parse_status_dirty(&status_out.map_err(fail)?)
                .get(sub_path)
                .copied()
                .unwrap_or(false);
            let (old, new) = match parse_raw_pointer(&diff_out.map_err(fail)?) {
                Some(pair) => pair,
                None => {
                    let same = index_gitlink(path, sub_path);
                    (same.clone(), same)
                }
            };
            // 워킹 트리 쪽 gitlink는 raw에 0으로 온다(git이 체크아웃을 해싱하지 않는다).
            // 서브모듈 HEAD를 직접 읽는다
            let new = match new {
                Some(sha) if is_zero_sha(&sha) => checkout_head(path, sub_path),
                other => other,
            };
            Ok((old, new, dirty))
        }
    }
}

/// `--raw -z` 첫 레코드의 gitlink 쪽 sha. 레코드가 없으면 None(변경 없음).
///
/// 한쪽이 gitlink가 아니면(파일 ↔ 서브모듈 교체) 그쪽은 서브모듈이 없는 것으로 본다.
/// new 쪽의 0 sha는 그대로 둔다. 워킹 트리 비교에서는 "체크아웃 HEAD를 읽어라"라는 뜻이다.
fn parse_raw_pointer(out: &str) -> Option<(Option<String>, Option<String>)> {
    let header = out.split('\0').find_map(|chunk| chunk.strip_prefix(':'))?;
    let fields: Vec<&str> = header.split_whitespace().collect();
    let [old_mode, new_mode, old_sha, new_sha, ..] = fields[..] else {
        return None;
    };
    let old = (old_mode == GITLINK_MODE && !is_zero_sha(old_sha)).then(|| old_sha.to_string());
    let new = (new_mode == GITLINK_MODE).then(|| new_sha.to_string());
    Some((old, new))
}

/// 트리끼리 비교한 결과. 0 sha는 충돌 레코드에서만 오고 "없음"이다.
fn committed_pointer(out: &str, fallback: impl FnOnce() -> Option<String>) -> PointerPair {
    match parse_raw_pointer(out) {
        Some((old, new)) => (old, new.filter(|sha| !is_zero_sha(sha))),
        None => {
            let same = fallback();
            (same.clone(), same)
        }
    }
}

/// 커밋 트리에 기록된 gitlink. 없거나 gitlink가 아니면 None.
fn tree_gitlink(path: &str, rev: &str, sub_path: &str) -> Option<String> {
    let out = git::run(path, &["ls-tree", "-z", rev, "--", sub_path]).ok()?;
    // "<mode> <type> <sha>\t<path>"
    out.split('\0').find_map(|entry| {
        let (meta, entry_path) = entry.split_once('\t')?;
        let mut fields = meta.split(' ');
        let mode = fields.next()?;
        let sha = fields.nth(1)?;
        (mode == GITLINK_MODE && entry_path == sub_path).then(|| sha.to_string())
    })
}

/// 상위 레포 index의 stage 0 gitlink.
fn index_gitlink(path: &str, sub_path: &str) -> Option<String> {
    let out = git::run(path, &["ls-files", "--stage", "-z", "--", sub_path]).ok()?;
    parse_index_gitlinks(&out).remove(sub_path)?.recorded
}

/// 서브모듈 체크아웃의 HEAD. 체크아웃이 없거나 HEAD가 없으면 None.
fn checkout_head(path: &str, sub_path: &str) -> Option<String> {
    let checkout = initialized_checkout(path, sub_path)?;
    git::run(&checkout, &["rev-parse", "--verify", "-q", "HEAD"])
        .ok()
        .map(|out| out.trim().to_string())
        .filter(|sha| !sha.is_empty())
}

/// 서브모듈 저장소 위치. 체크아웃이 있으면 그쪽, 없으면 상위 레포의 `modules/<name>`.
fn submodule_repo(path: &str, sub_path: &str) -> Option<PathBuf> {
    if let Some(checkout) = initialized_checkout(path, sub_path) {
        return Some(checkout);
    }
    // 삭제된 서브모듈은 .gitmodules에서도 빠져 있다. 그때는 git 기본값처럼 이름 = 경로로 본다
    let name = read_gitmodules(path)
        .ok()
        .and_then(|modules| {
            modules
                .into_iter()
                .find(|module| module.path.as_deref() == Some(sub_path))
        })
        .map(|module| module.name)
        .unwrap_or_else(|| sub_path.to_string());
    if !is_safe_relative(&name) {
        return None;
    }
    let git_path = format!("modules/{name}");
    let out = git::run(path, &["rev-parse", "--git-path", git_path.as_str()]).ok()?;
    let dir = Path::new(path).join(out.trim_end_matches(['\n', '\r']));
    dir.is_dir().then_some(dir)
}

/// `.git`(파일이든 디렉토리든)이 있는 체크아웃. 레포 밖을 가리키면 None.
fn initialized_checkout(path: &str, sub_path: &str) -> Option<PathBuf> {
    let checkout = resolve_in_repo(path, sub_path).ok()?;
    let root = Path::new(path).canonicalize().ok()?;
    // 서브모듈 경로가 상위 레포 루트 자체면 상위 레포를 서브모듈로 읽게 된다
    if checkout == root {
        return None;
    }
    checkout.join(".git").exists().then_some(checkout)
}

fn has_checkout(path: &str, sub_path: &str) -> bool {
    initialized_checkout(path, sub_path).is_some()
}

/// `.gitmodules`가 일반 파일로 있는가. git은 심링크 `.gitmodules`를 읽지 않는다.
fn has_gitmodules(path: &str) -> bool {
    std::fs::symlink_metadata(Path::new(path).join(GITMODULES))
        .map(|meta| meta.file_type().is_file())
        .unwrap_or(false)
}

/// 이름이 `..`나 절대 경로로 `modules/` 밖을 가리키지 않는가. git도 이런 이름을 거절한다.
fn is_safe_relative(name: &str) -> bool {
    !name.is_empty()
        && Path::new(name)
            .components()
            .all(|component| matches!(component, Component::Normal(_)))
}

fn is_zero_sha(sha: &str) -> bool {
    sha.bytes().all(|byte| byte == b'0')
}

fn state_of(prefix: char) -> SubmoduleState {
    match prefix {
        '-' => SubmoduleState::Uninitialized,
        '+' => SubmoduleState::Moved,
        'U' => SubmoduleState::Conflict,
        _ => SubmoduleState::Ok,
    }
}

fn read_gitmodules(path: &str) -> Result<Vec<ModuleEntry>, String> {
    // 항목이 하나도 없으면 종료 코드 1이다. 그건 빈 목록이다
    let out = git::run_bytes_allow_diff(path, &GITMODULES_ARGS)
        .map_err(|e| format!("Could not read .gitmodules: {e}"))?;
    Ok(parse_gitmodules(&String::from_utf8_lossy(&out)))
}

/// `config -z --get-regexp` 출력을 이름별 항목으로 묶는다. 순서는 처음 나온 순서다.
///
/// 레코드는 `submodule.<name>.<key>\n<value>\0`이다. 이름에는 `.`이 들어갈 수 있어 마지막
/// `.` 뒤를 키로 본다. 키는 git이 소문자로 내려 준다.
fn parse_gitmodules(out: &str) -> Vec<ModuleEntry> {
    let mut entries: Vec<ModuleEntry> = Vec::new();
    for record in out.split('\0').filter(|record| !record.is_empty()) {
        let (key, value) = record.split_once('\n').unwrap_or((record, ""));
        let Some(rest) = key.strip_prefix("submodule.") else {
            continue;
        };
        let Some((name, var)) = rest.rsplit_once('.') else {
            continue;
        };
        let at = match entries.iter().position(|entry| entry.name == name) {
            Some(at) => at,
            None => {
                entries.push(ModuleEntry {
                    name: name.to_string(),
                    ..ModuleEntry::default()
                });
                entries.len() - 1
            }
        };
        let entry = &mut entries[at];
        let value = Some(value.to_string()).filter(|value| !value.is_empty());
        match var {
            "path" => entry.path = entry.path.take().or(value),
            "url" => entry.url = entry.url.take().or(value),
            "branch" => entry.branch = entry.branch.take().or(value),
            _ => {}
        }
    }
    entries
}

/// `ls-files --stage -z` 출력에서 gitlink만 골라 경로별로 묶는다.
fn parse_index_gitlinks(out: &str) -> HashMap<String, IndexEntry> {
    let mut entries: HashMap<String, IndexEntry> = HashMap::new();
    for record in out.split('\0') {
        // "<mode> <sha> <stage>\t<path>"
        let Some((meta, entry_path)) = record.split_once('\t') else {
            continue;
        };
        let fields: Vec<&str> = meta.split(' ').collect();
        let [mode, sha, stage] = fields[..] else {
            continue;
        };
        if mode != GITLINK_MODE {
            continue;
        }
        let entry = entries.entry(entry_path.to_string()).or_default();
        if stage == "0" {
            entry.recorded = Some(sha.to_string());
        } else {
            entry.conflicted = true;
        }
    }
    for entry in entries.values_mut() {
        if entry.conflicted {
            entry.recorded = None;
        }
    }
    entries
}

/// 서브모듈 안에 커밋 안 한 변경(추적 파일 수정 또는 untracked)이 있는가.
/// [`get_submodules`]의 dirty와 같은 기준이다(같은 `status`, 같은 파서). 상위 레포 git 1회.
pub(crate) fn is_dirty(path: &str, sub_path: &str) -> Result<bool, String> {
    let out = git::run(path, &["status", "--porcelain=v2", "-z", "--", sub_path])
        .map_err(|e| format!("Could not read the submodule status: {e}"))?;
    Ok(parse_status_dirty(&out)
        .get(sub_path)
        .copied()
        .unwrap_or(false))
}

/// `status --porcelain=v2 -z`에서 서브모듈 항목의 dirty(추적 파일 수정 M 또는 untracked U).
///
/// 서브모듈 필드는 `S<c><m><u>`이고 서브모듈이 아니면 `N...`이다. 일반(`1`), rename(`2`),
/// 충돌(`u`) 항목 모두 세 번째 필드다. rename은 다음 NUL 조각이 원 경로라 건너뛴다.
fn parse_status_dirty(out: &str) -> HashMap<String, bool> {
    let mut dirty = HashMap::new();
    let mut chunks = out.split('\0');
    while let Some(chunk) = chunks.next() {
        let (kind, path_at) = match chunk.as_bytes().first() {
            Some(b'1') => ('1', 8),
            Some(b'2') => ('2', 9),
            Some(b'u') => ('u', 10),
            _ => continue,
        };
        if kind == '2' {
            chunks.next();
        }
        let fields: Vec<&str> = chunk.splitn(path_at + 1, ' ').collect();
        let (Some(sub), Some(entry_path)) = (fields.get(2), fields.get(path_at)) else {
            continue;
        };
        let sub = sub.as_bytes();
        if sub.first() != Some(&b'S') {
            continue;
        }
        let modified = sub.get(2) == Some(&b'M') || sub.get(3) == Some(&b'U');
        dirty.insert(entry_path.to_string(), modified);
    }
    dirty
}

/// `submodule status` 출력. 경로별 (상태 문자, sha).
///
/// 줄은 `<상태><sha> <경로>[ (<describe>)]`이고 경로는 따옴표 없이 그대로 온다. 공백이 든
/// 경로와 describe를 문자열만으로는 가를 수 없어서, 넘긴 경로 중 가장 길게 맞는 것을 고른다.
fn parse_submodule_status(out: &str, paths: &[&str]) -> HashMap<String, (char, String)> {
    let mut heads = HashMap::new();
    for line in out.lines() {
        let mut chars = line.chars();
        let Some(prefix) = chars.next() else {
            continue;
        };
        let rest = chars.as_str();
        let Some((sha, tail)) = rest.split_once(' ') else {
            continue;
        };
        let matched = paths
            .iter()
            .filter(|path| {
                tail.strip_prefix(**path)
                    .is_some_and(|after| after.is_empty() || after.starts_with(" ("))
            })
            .max_by_key(|path| path.len());
        if let Some(path) = matched {
            heads.insert(path.to_string(), (prefix, sha.to_string()));
        }
    }
    heads
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git::spawn_count;
    use crate::testrepo::{lib, one, Fixture, TempRepo};

    /// 서브모듈 3개: `a`는 moved, `dir/b sp`는 dirty, `c`는 uninitialized.
    fn three() -> Fixture {
        let parent = TempRepo::linear("gitlanes-sub-parent3", 1);
        let libs = vec![
            lib("gitlanes-sub-lib3a"),
            lib("gitlanes-sub-lib3b"),
            lib("gitlanes-sub-lib3c"),
        ];
        parent.add_submodule(&libs[0].path(), "a");
        parent.add_submodule(&libs[1].path(), "dir/b sp");
        parent.add_submodule(&libs[2].path(), "c");
        parent.git(&["commit", "-qm", "add submodules"]);
        parent.git(&["submodule", "deinit", "-q", "c"]);
        parent.git_in("a", &["checkout", "-q", "HEAD~1"]);
        parent.write("dir/b sp/counter.txt", "dirty\n");
        Fixture { parent, libs }
    }

    /// 서브모듈 안에서 커밋한다. 서브모듈 clone에는 TempRepo의 레포 설정이 없다
    fn commit_in(repo: &TempRepo, dir: &str, file: &str, message: &str) {
        repo.write(&format!("{dir}/{file}"), &format!("{message}\n"));
        repo.git_in(dir, &["add", "-A"]);
        repo.git_in(
            dir,
            &["-c", "commit.gpgsign=false", "commit", "-qm", message],
        );
    }

    fn find<'a>(infos: &'a [SubmoduleInfo], path: &str) -> &'a SubmoduleInfo {
        infos
            .iter()
            .find(|info| info.path == path)
            .unwrap_or_else(|| panic!("{path}가 목록에 없다: {infos:?}"))
    }

    #[test]
    fn get_submodules는_세_상태와_dirty를_경로순으로_돌려준다() {
        let fx = three();
        let infos = get_submodules(fx.parent.path()).unwrap();

        let paths: Vec<&str> = infos.iter().map(|info| info.path.as_str()).collect();
        assert_eq!(paths, ["a", "c", "dir/b sp"]);

        let a = find(&infos, "a");
        assert_eq!(a.name, "a");
        assert_eq!(a.state, SubmoduleState::Moved);
        assert_eq!(
            a.recorded_sha.as_deref(),
            Some(fx.lib(0).rev("HEAD").as_str())
        );
        assert_eq!(
            a.head_sha.as_deref(),
            Some(fx.lib(0).rev("HEAD~1").as_str())
        );
        assert!(!a.dirty);
        assert_eq!(a.url.as_deref(), Some(fx.lib(0).path().as_str()));
        assert_eq!(a.branch, None);

        let c = find(&infos, "c");
        assert_eq!(c.state, SubmoduleState::Uninitialized);
        assert_eq!(
            c.recorded_sha.as_deref(),
            Some(fx.lib(2).rev("HEAD").as_str())
        );
        assert_eq!(c.head_sha, None);
        assert!(!c.dirty);

        let b = find(&infos, "dir/b sp");
        assert_eq!(b.state, SubmoduleState::Ok);
        assert_eq!(b.head_sha, b.recorded_sha);
        assert!(b.dirty, "추적 파일을 고친 서브모듈은 dirty다");
    }

    #[test]
    fn untracked_파일만_있어도_dirty다() {
        let fx = one();
        fx.parent.write("a/new.txt", "new\n");
        let infos = get_submodules(fx.parent.path()).unwrap();
        assert!(find(&infos, "a").dirty);
        assert_eq!(find(&infos, "a").state, SubmoduleState::Ok);
    }

    #[test]
    fn gitmodules가_없으면_git을_부르지_않고_빈_목록이다() {
        let repo = TempRepo::linear("gitlanes-sub-none", 1);
        let before = spawn_count::under(&repo.path());
        assert!(get_submodules(repo.path()).unwrap().is_empty());
        assert_eq!(spawn_count::under(&repo.path()), before);
    }

    /// 성능 계약: 서브모듈 수에 비례해 git 프로세스가 늘지 않는다
    #[test]
    fn get_submodules의_git_호출_수는_서브모듈_수와_무관하다() {
        let small = one();
        let before = spawn_count::under(&small.parent.path());
        get_submodules(small.parent.path()).unwrap();
        let one_count = spawn_count::under(&small.parent.path()) - before;

        let large = three();
        let before = spawn_count::under(&large.parent.path());
        get_submodules(large.parent.path()).unwrap();
        let three_count = spawn_count::under(&large.parent.path()) - before;

        assert_eq!(one_count, 4, "config, ls-files, status, submodule status");
        assert_eq!(three_count, one_count);
    }

    #[test]
    fn branch_설정을_읽는다() {
        let fx = one();
        fx.parent
            .git(&["config", "-f", ".gitmodules", "submodule.a.branch", "main"]);
        let infos = get_submodules(fx.parent.path()).unwrap();
        assert_eq!(find(&infos, "a").branch.as_deref(), Some("main"));
    }

    /// `.gitmodules`에 없는 gitlink가 있으면 경로 없는 `submodule status`는 128로 끝난다
    #[test]
    fn gitmodules에_없는_gitlink가_있어도_목록을_돌려준다() {
        let fx = one();
        let stray = TempRepo::linear("gitlanes-sub-stray", 1);
        let target = std::path::Path::new(&fx.parent.path()).join("stray");
        std::fs::rename(stray.path(), &target).unwrap();
        fx.parent.git(&["add", "stray"]);
        fx.parent.git(&["commit", "-qm", "stray gitlink"]);

        let infos = get_submodules(fx.parent.path()).unwrap();
        let paths: Vec<&str> = infos.iter().map(|info| info.path.as_str()).collect();
        assert_eq!(paths, ["a"]);
    }

    /// `.gitmodules`에만 있고 index에 없는 경로를 `submodule status`에 넘기면 pathspec 오류다
    #[test]
    fn index에_없는_gitmodules_항목은_uninitialized로_보인다() {
        let fx = one();
        fx.parent.git(&[
            "config",
            "-f",
            ".gitmodules",
            "submodule.ghost.path",
            "ghost",
        ]);
        fx.parent.git(&[
            "config",
            "-f",
            ".gitmodules",
            "submodule.ghost.url",
            "../ghost",
        ]);

        let infos = get_submodules(fx.parent.path()).unwrap();
        let ghost = find(&infos, "ghost");
        assert_eq!(ghost.state, SubmoduleState::Uninitialized);
        assert_eq!(ghost.recorded_sha, None);
        assert_eq!(find(&infos, "a").state, SubmoduleState::Ok);
    }

    #[test]
    fn gitlink_충돌은_conflict이고_기록된_커밋이_없다() {
        let fx = one();
        let parent = &fx.parent;
        parent.git(&["checkout", "-q", "-b", "other"]);
        parent.git_in("a", &["checkout", "-q", "HEAD~1"]);
        parent.git(&["commit", "-qam", "a back"]);
        parent.git(&["checkout", "-q", "main"]);
        commit_in(parent, "a", "x.txt", "a forward");
        parent.git(&["commit", "-qam", "a forward"]);
        let merge = std::process::Command::new("git")
            .current_dir(parent.path())
            .args(["merge", "-q", "other"])
            .output()
            .unwrap();
        assert!(!merge.status.success(), "충돌이 나야 한다");

        let infos = get_submodules(parent.path()).unwrap();
        let a = find(&infos, "a");
        assert_eq!(a.state, SubmoduleState::Conflict);
        assert_eq!(a.recorded_sha, None);
        assert_eq!(a.head_sha, None);
    }

    /// 실측: `submodule status`는 ignore=all을 보지 않고 `status`는 본다
    #[test]
    fn ignore_all이면_moved는_보이고_dirty는_숨는다() {
        let fx = one();
        fx.parent.git(&["config", "submodule.a.ignore", "all"]);
        fx.parent.git_in("a", &["checkout", "-q", "HEAD~1"]);
        fx.parent.write("a/counter.txt", "dirty\n");

        let infos = get_submodules(fx.parent.path()).unwrap();
        let a = find(&infos, "a");
        assert_eq!(a.state, SubmoduleState::Moved);
        assert!(!a.dirty, "레포 설정 ignore=all을 덮지 않는다");
    }

    #[test]
    fn 한글_경로도_읽는다() {
        let parent = TempRepo::linear("gitlanes-sub-hangul", 1);
        let a = lib("gitlanes-sub-hangul-lib");
        parent.add_submodule(&a.path(), "모듈 하나");
        parent.git(&["commit", "-qm", "add"]);

        let infos = get_submodules(parent.path()).unwrap();
        assert_eq!(infos.len(), 1);
        assert_eq!(infos[0].path, "모듈 하나");
        assert_eq!(infos[0].state, SubmoduleState::Ok);
        assert_eq!(infos[0].head_sha.as_deref(), Some(a.rev("HEAD").as_str()));
    }

    #[test]
    fn 같은_경로의_describe를_경로로_착각하지_않는다() {
        let out = " 1111 a (heads/main)\n+2222 a b\n";
        let heads = parse_submodule_status(out, &["a", "a b"]);
        assert_eq!(heads["a"], (' ', "1111".to_string()));
        assert_eq!(heads["a b"], ('+', "2222".to_string()));
    }

    // ── get_submodule_change ──

    fn commit_source(sha: String) -> SubmoduleChangeSource {
        SubmoduleChangeSource::Commit { sha }
    }

    #[test]
    fn 커밋의_포인터_전진은_ahead로_보인다() {
        let fx = one();
        let old = fx.lib(0).rev("HEAD");
        fx.lib(0).write("counter.txt", "3\n");
        fx.lib(0).git(&["commit", "-qam", "lib 3"]);
        fx.lib(0).write("counter.txt", "4\n");
        fx.lib(0).git(&["commit", "-qam", "lib 4"]);
        fx.parent.git_in("a", &["pull", "-q", "--ff-only"]);
        fx.parent.git(&["commit", "-qam", "bump a"]);

        let change = get_submodule_change(
            fx.parent.path(),
            "a".into(),
            commit_source("HEAD".into()),
            10,
        )
        .unwrap();
        assert_eq!(change.old_sha.as_deref(), Some(old.as_str()));
        assert_eq!(
            change.new_sha.as_deref(),
            Some(fx.lib(0).rev("HEAD").as_str())
        );
        assert!(change.available);
        let subjects: Vec<&str> = change.ahead.iter().map(|c| c.subject.as_str()).collect();
        assert_eq!(subjects, ["lib 4", "lib 3"]);
        assert!(change.behind.is_empty());
        assert!(!change.dirty);
    }

    #[test]
    fn 되감기는_behind로_보이고_limit에서_자른다() {
        let fx = one();
        fx.parent.git_in("a", &["checkout", "-q", "HEAD~2"]);
        fx.parent.git(&["commit", "-qam", "rewind a"]);

        let change = get_submodule_change(
            fx.parent.path(),
            "a".into(),
            commit_source("HEAD".into()),
            1,
        )
        .unwrap();
        assert!(change.available);
        assert!(change.ahead.is_empty());
        assert_eq!(change.behind.len(), 1);
        assert_eq!(change.behind[0].subject, "commit 2");
        assert!(change.behind_truncated);
        assert!(!change.ahead_truncated);
    }

    #[test]
    fn 서브모듈을_추가한_커밋은_old가_없고_목록이_비어_있다() {
        let fx = one();
        let change = get_submodule_change(
            fx.parent.path(),
            "a".into(),
            commit_source("HEAD".into()),
            10,
        )
        .unwrap();
        assert_eq!(change.old_sha, None);
        assert_eq!(
            change.new_sha.as_deref(),
            Some(fx.lib(0).rev("HEAD").as_str())
        );
        assert!(change.available);
        assert!(change.ahead.is_empty() && change.behind.is_empty());
    }

    #[test]
    fn 루트_커밋의_서브모듈도_읽는다() {
        let parent = TempRepo::init("gitlanes-sub-root");
        let a = lib("gitlanes-sub-root-lib");
        parent.add_submodule(&a.path(), "a");
        parent.git(&["commit", "-qm", "root with a"]);
        let change =
            get_submodule_change(parent.path(), "a".into(), commit_source("HEAD".into()), 10)
                .unwrap();
        assert_eq!(change.old_sha, None);
        assert_eq!(change.new_sha.as_deref(), Some(a.rev("HEAD").as_str()));
    }

    #[test]
    fn staged는_head에서_index로_읽는다() {
        let fx = one();
        let recorded = fx.lib(0).rev("HEAD");
        fx.parent.git_in("a", &["checkout", "-q", "HEAD~1"]);
        fx.parent.git(&["add", "a"]);

        let change = get_submodule_change(
            fx.parent.path(),
            "a".into(),
            SubmoduleChangeSource::Staged,
            10,
        )
        .unwrap();
        assert_eq!(change.old_sha.as_deref(), Some(recorded.as_str()));
        assert_eq!(
            change.new_sha.as_deref(),
            Some(fx.lib(0).rev("HEAD~1").as_str())
        );
        assert_eq!(change.behind.len(), 1);
        assert!(!change.dirty);
    }

    #[test]
    fn unstaged는_체크아웃_head와_dirty를_읽는다() {
        let fx = one();
        let recorded = fx.lib(0).rev("HEAD");
        fx.parent.git_in("a", &["checkout", "-q", "HEAD~1"]);
        fx.parent.write("a/counter.txt", "dirty\n");

        let change = get_submodule_change(
            fx.parent.path(),
            "a".into(),
            SubmoduleChangeSource::Unstaged,
            10,
        )
        .unwrap();
        assert_eq!(change.old_sha.as_deref(), Some(recorded.as_str()));
        assert_eq!(
            change.new_sha.as_deref(),
            Some(fx.lib(0).rev("HEAD~1").as_str()),
            "워킹 트리 쪽 0 sha 대신 체크아웃 HEAD를 읽는다"
        );
        assert!(change.dirty);
        assert_eq!(change.behind.len(), 1);
    }

    #[test]
    fn unstaged에서_dirty만_있으면_old와_new가_같다() {
        let fx = one();
        fx.parent.write("a/counter.txt", "dirty\n");
        let change = get_submodule_change(
            fx.parent.path(),
            "a".into(),
            SubmoduleChangeSource::Unstaged,
            10,
        )
        .unwrap();
        assert_eq!(change.old_sha, change.new_sha);
        assert!(change.old_sha.is_some());
        assert!(change.dirty);
        assert!(change.available);
    }

    #[test]
    fn compare는_merge_base에서_head로_읽는다() {
        let fx = one();
        let recorded = fx.lib(0).rev("HEAD");
        fx.parent.git(&["checkout", "-q", "-b", "topic"]);
        fx.parent.git_in("a", &["checkout", "-q", "HEAD~2"]);
        fx.parent.git(&["commit", "-qam", "rewind a"]);
        fx.parent.git(&["checkout", "-q", "main"]);
        // main 쪽에서 다른 파일만 바꿔 merge-base와 main이 갈리게 한다
        fx.parent.write("other.txt", "x\n");
        fx.parent.git(&["add", "other.txt"]);
        fx.parent.git(&["commit", "-qm", "other"]);

        let change = get_submodule_change(
            fx.parent.path(),
            "a".into(),
            SubmoduleChangeSource::Compare {
                base: "main".into(),
                head: "topic".into(),
            },
            10,
        )
        .unwrap();
        assert_eq!(change.old_sha.as_deref(), Some(recorded.as_str()));
        assert_eq!(
            change.new_sha.as_deref(),
            Some(fx.lib(0).rev("HEAD~2").as_str())
        );
        assert_eq!(change.behind.len(), 2);
    }

    #[test]
    fn 초기화하지_않은_서브모듈은_modules_디렉토리로_읽는다() {
        let fx = one();
        fx.parent.git_in("a", &["checkout", "-q", "HEAD~1"]);
        fx.parent.git(&["commit", "-qam", "rewind a"]);
        fx.parent.git(&["submodule", "deinit", "-q", "a"]);

        let change = get_submodule_change(
            fx.parent.path(),
            "a".into(),
            commit_source("HEAD".into()),
            10,
        )
        .unwrap();
        assert!(
            change.available,
            "체크아웃이 없어도 .git/modules/a에 커밋이 있다"
        );
        assert_eq!(change.behind.len(), 1);
    }

    #[test]
    fn 빈_체크아웃_디렉토리에서_상위_레포를_서브모듈로_읽지_않는다() {
        let fx = one();
        fx.parent.git_in("a", &["checkout", "-q", "HEAD~1"]);
        fx.parent.git(&["commit", "-qam", "rewind a"]);
        fx.parent.git(&["submodule", "deinit", "-q", "a"]);
        // modules 디렉토리까지 없애 서브모듈 저장소가 아예 없게 만든다. 대신 상위 레포가 서브모듈
        // 커밋을 갖게 해서, 잘못 상위 레포를 열면 available=true가 나오게 한다
        let modules = std::path::Path::new(&fx.parent.path()).join(".git/modules/a");
        std::fs::remove_dir_all(modules).unwrap();
        fx.parent
            .git(&["fetch", "-q", &fx.lib(0).path(), "main:refs/lib/main"]);
        assert!(std::path::Path::new(&fx.parent.path()).join("a").is_dir());

        let change = get_submodule_change(
            fx.parent.path(),
            "a".into(),
            commit_source("HEAD".into()),
            10,
        )
        .unwrap();
        assert!(!change.available);
        assert!(change.behind.is_empty());
    }

    #[test]
    fn 서브모듈에_없는_커밋이면_available이_false다() {
        let fx = one();
        let missing = "1234567890123456789012345678901234567890";
        fx.parent.git(&[
            "update-index",
            "--cacheinfo",
            &format!("160000,{missing},a"),
        ]);
        fx.parent.git(&["commit", "-qm", "point to missing"]);

        let change = get_submodule_change(
            fx.parent.path(),
            "a".into(),
            commit_source("HEAD".into()),
            10,
        )
        .unwrap();
        assert_eq!(change.new_sha.as_deref(), Some(missing));
        assert!(!change.available);
        assert!(change.ahead.is_empty() && change.behind.is_empty());
    }

    #[test]
    fn 옵션처럼_생긴_인자는_거절한다() {
        let fx = one();
        assert!(get_submodule_change(
            fx.parent.path(),
            "-a".into(),
            SubmoduleChangeSource::Staged,
            10
        )
        .is_err());
        assert!(get_submodule_change(
            fx.parent.path(),
            "a".into(),
            commit_source("--all".into()),
            10
        )
        .is_err());
    }

    #[test]
    fn source는_kind_태그로_역직렬화된다() {
        let commit: SubmoduleChangeSource =
            serde_json::from_str(r#"{"kind":"commit","sha":"abc"}"#).unwrap();
        assert_eq!(commit, commit_source("abc".into()));
        let staged: SubmoduleChangeSource = serde_json::from_str(r#"{"kind":"staged"}"#).unwrap();
        assert_eq!(staged, SubmoduleChangeSource::Staged);
        let compare: SubmoduleChangeSource =
            serde_json::from_str(r#"{"kind":"compare","base":"main","head":"topic"}"#).unwrap();
        assert_eq!(
            compare,
            SubmoduleChangeSource::Compare {
                base: "main".into(),
                head: "topic".into()
            }
        );
    }

    #[test]
    fn info는_camel_case_키로_직렬화된다() {
        let info = SubmoduleInfo {
            name: "a".into(),
            path: "a".into(),
            url: None,
            branch: None,
            recorded_sha: None,
            head_sha: None,
            state: SubmoduleState::Uninitialized,
            dirty: false,
        };
        assert_eq!(
            serde_json::to_string(&info).unwrap(),
            r#"{"name":"a","path":"a","url":null,"branch":null,"recordedSha":null,"headSha":null,"state":"uninitialized","dirty":false}"#
        );
    }

    // ── FileChange.submodule (Rust 2) ──

    #[test]
    fn 커밋_상세의_gitlink는_submodule로_표시된다() {
        let fx = one();
        let details = crate::commands::get_commit_details(fx.parent.path(), "HEAD".into()).unwrap();
        let a = details.files.iter().find(|f| f.path == "a").unwrap();
        let gitmodules = details
            .files
            .iter()
            .find(|f| f.path == ".gitmodules")
            .unwrap();
        assert!(a.submodule, "추가(000000 → 160000)도 서브모듈이다");
        assert!(!gitmodules.submodule);
    }

    #[test]
    fn wip_staged와_unstaged의_gitlink는_submodule로_표시된다() {
        let fx = one();
        fx.parent.git_in("a", &["checkout", "-q", "HEAD~1"]);
        let wip = crate::commands::get_wip_details(fx.parent.path()).unwrap();
        assert!(wip.unstaged.iter().any(|f| f.path == "a" && f.submodule));

        fx.parent.git(&["add", "a"]);
        fx.parent.write("counter.txt", "changed\n");
        let wip = crate::commands::get_wip_details(fx.parent.path()).unwrap();
        assert!(wip.staged.iter().any(|f| f.path == "a" && f.submodule));
        assert!(wip
            .unstaged
            .iter()
            .any(|f| f.path == "counter.txt" && !f.submodule));
    }

    #[test]
    fn compare_refs의_gitlink는_submodule로_표시된다() {
        let fx = one();
        let before = fx.parent.rev("HEAD");
        fx.parent.git_in("a", &["checkout", "-q", "HEAD~1"]);
        fx.parent.git(&["commit", "-qam", "rewind"]);
        let result =
            crate::inspect::compare_refs(fx.parent.path(), before, "HEAD".into(), 10).unwrap();
        assert!(result.files.iter().any(|f| f.path == "a" && f.submodule));
    }

    #[test]
    fn 파일에서_서브모듈로_바뀐_항목도_submodule이다() {
        let raw = ":100644 160000 1111111111111111111111111111111111111111 2222222222222222222222222222222222222222 T\0a\0";
        assert!(crate::parse::parse_file_changes(raw)[0].submodule);
        let raw = ":100644 100644 1111111111111111111111111111111111111111 2222222222222222222222222222222222222222 M\0a\0";
        assert!(!crate::parse::parse_file_changes(raw)[0].submodule);
    }

    #[test]
    fn submodule이_false면_키를_빼고_true면_넣는다() {
        let raw = ":160000 160000 1111111111111111111111111111111111111111 2222222222222222222222222222222222222222 M\0a\0";
        let change = &crate::parse::parse_file_changes(raw)[0];
        assert!(serde_json::to_string(change)
            .unwrap()
            .contains(r#""submodule":true"#));
        let raw = ":100644 100644 1111111111111111111111111111111111111111 2222222222222222222222222222222222222222 M\0b\0";
        let change = &crate::parse::parse_file_changes(raw)[0];
        assert!(!serde_json::to_string(change).unwrap().contains("submodule"));
    }

    // ── diff.submodule 차단 (Rust 5) ──

    /// 사용자가 `diff.submodule=log`를 켠 레포. 기본 short 모양이 아니면 실패한다
    fn log_style() -> Fixture {
        let fx = one();
        fx.parent.git(&["config", "diff.submodule", "log"]);
        fx
    }

    fn assert_short(diff: &str) {
        assert!(diff.contains("+++ b/a"), "파일 헤더가 있어야 한다: {diff}");
        assert!(diff.contains("+Subproject commit "), "{diff}");
        assert!(
            !diff.contains("Submodule a "),
            "log 요약이 섞이면 안 된다: {diff}"
        );
    }

    #[test]
    fn 커밋_diff는_diff_submodule_log를_덮는다() {
        let fx = log_style();
        fx.parent.git_in("a", &["checkout", "-q", "HEAD~1"]);
        fx.parent.git(&["commit", "-qam", "rewind"]);
        let diff =
            crate::commands::get_file_diff(fx.parent.path(), "HEAD".into(), "a".into(), None)
                .unwrap();
        assert_short(&diff);
    }

    #[test]
    fn 루트_커밋_diff도_diff_submodule_log를_덮는다() {
        let parent = TempRepo::init("gitlanes-sub-rootdiff");
        let a = lib("gitlanes-sub-rootdiff-lib");
        parent.add_submodule(&a.path(), "a");
        parent.git(&["commit", "-qm", "root"]);
        parent.git(&["config", "diff.submodule", "log"]);
        let diff =
            crate::commands::get_file_diff(parent.path(), "HEAD".into(), "a".into(), None).unwrap();
        assert_short(&diff);
    }

    #[test]
    fn wip_diff는_diff_submodule_log를_덮는다() {
        let fx = log_style();
        fx.parent.git_in("a", &["checkout", "-q", "HEAD~1"]);
        let unstaged =
            crate::commands::get_wip_file_diff(fx.parent.path(), "a".into(), "unstaged".into())
                .unwrap();
        assert_short(&unstaged.text);

        fx.parent.git(&["add", "a"]);
        let staged =
            crate::commands::get_wip_file_diff(fx.parent.path(), "a".into(), "staged".into())
                .unwrap();
        assert_short(&staged.text);
    }

    #[test]
    fn 비교_diff는_diff_submodule_log를_덮는다() {
        let fx = log_style();
        let before = fx.parent.rev("HEAD");
        fx.parent.git_in("a", &["checkout", "-q", "HEAD~1"]);
        fx.parent.git(&["commit", "-qam", "rewind"]);
        let diff = crate::inspect::get_compare_file_diff(
            fx.parent.path(),
            before,
            "HEAD".into(),
            "a".into(),
            None,
        )
        .unwrap();
        assert_short(&diff);
    }

    /// `diff.ignoreSubmodules`는 레포 의도라 덮지 않는다. dirty만 있는 서브모듈은 WIP에서 빠진다
    #[test]
    fn diff_ignore_submodules_dirty는_존중한다() {
        let fx = one();
        fx.parent.write("a/counter.txt", "dirty\n");
        let wip = crate::commands::get_wip_details(fx.parent.path()).unwrap();
        assert!(wip.unstaged.iter().any(|f| f.path == "a"));

        fx.parent.git(&["config", "diff.ignoreSubmodules", "dirty"]);
        let wip = crate::commands::get_wip_details(fx.parent.path()).unwrap();
        assert!(
            !wip.unstaged.iter().any(|f| f.path == "a"),
            "{:?}",
            wip.unstaged
        );
    }
}
