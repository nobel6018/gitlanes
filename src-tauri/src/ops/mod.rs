//! 쓰기 작업 command 전부와 그 공통 실행기.
//!
//! # v0.13~v0.17 봉인과 v0.18 해제
//!
//! v0.16에서 앱을 읽기 전용으로 되돌리면서 이 모듈은 `write-ops` cargo feature 뒤에
//! 숨어 있었다. 인증이 필요한 작업을 앱이 비대화식으로 하면 자격증명을 물을 길이 없어
//! 그냥 실패하는데, 그 실패를 사용자에게 설명할 방법이 없었던 것이 이유다.
//!
//! v0.18에서 그 문제를 풀고 봉인을 해제했다. 답은 **실패를 터미널로 넘기는 것**이다.
//! 모든 결과에 [`model::OpResult::command`]로 실행한 인자를 싣고, stderr가 인증 실패로
//! 보이면 [`model::OpResult::needs_auth`]를 켠다. 프론트는 그 인자를 하단 PTY 터미널에
//! 그대로 흘려보내고, 거기서는 사용자의 진짜 셸이라 ssh-agent와 keychain이 평소대로
//! 동작한다. feature 게이트는 사라졌고 모든 command가 기본 빌드에 등록된다.
//!
//! # 모듈 구성
//!
//! 실행기는 [`run`]에만 있고 나머지는 인자를 조립할 뿐이다. 새 command를 추가할 때
//! 프로세스 실행이나 타임아웃을 다시 짜지 않는다.
//!
//! @see CONTRACTS.md

pub mod branch;
pub mod commit;
pub mod conflict;
pub mod history;
pub mod interactive;
pub mod network;
pub mod remote;
pub mod run;
pub mod stage;
pub mod stash;
pub mod sync;
pub mod tag;
pub mod worktree;

// invoke_handler는 `ops::network::git_fetch`처럼 모듈 경로까지 적어 참조한다.
// `#[tauri::command]`가 함수 옆에 같은 이름의 내부 매크로를 함께 만들기 때문에,
// `pub use`로 끌어올린 이름만으로는 generate_handler가 짝을 찾지 못한다.
