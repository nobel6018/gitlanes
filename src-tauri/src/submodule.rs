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
use crate::model::{
    SubmoduleChange, SubmoduleChangeSource, SubmoduleInfo, SubmoduleState,
};
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
    const RAW: [&str; 5] = ["--raw", "-z", "--no-abbrev", "--no-renames", "--no-ext-diff"];
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
