//! 서브모듈 update (v0.19).
//!
//! @see CONTRACTS.md (v0.19.0)

use crate::commands::validate_pathspec;
use crate::model::OpResult;

use super::run::{run_op, validate_paths, NETWORK_TIMEOUT};

/// `submodule update [--init] --recursive -- <paths>`. paths가 비면 전부다.
///
/// 서브모듈 HEAD를 상위 레포에 기록된 커밋으로 옮긴다. 옮기기 전 HEAD는 서브모듈 reflog에
/// 남는다(확인 대화상자는 프론트 몫). clone이나 fetch가 일어날 수 있어 네트워크 상한을 쓰고,
/// `submodule`은 needsAuth 판정 대상이다.
///
/// `protocol.file.allow`는 건드리지 않는다. 로컬 경로 서브모듈의 clone을 막는 최근 git의
/// 기본값은 사용자 설정이 결정한다.
#[tauri::command(async)]
pub fn git_submodule_update(
    path: String,
    paths: Vec<String>,
    init: bool,
) -> Result<OpResult, String> {
    let paths = if paths.is_empty() {
        Vec::new()
    } else {
        for file in &paths {
            validate_pathspec(file)?;
        }
        validate_paths(&paths)?
    };

    let mut args: Vec<&str> = vec!["submodule", "update"];
    if init {
        args.push("--init");
    }
    args.extend(["--recursive", "--"]);
    args.extend(paths.iter().map(String::as_str));
    run_op(&path, &args, NETWORK_TIMEOUT)
}
