//! 테스트용 임시 git 저장소.
//!
//! 테스트가 자기 저장소(`"."`)에 git을 걸면 실행 환경의 히스토리 깊이에 결과가 묶인다.
//! CI의 `actions/checkout`은 기본이 `fetch-depth: 1` 얕은 클론이라 커밋이 하나뿐이고,
//! "커밋 3개를 읽는다" 같은 단정이 로컬에서만 통과한다. 검증이 필요한 히스토리는
//! 테스트가 직접 만들어 쓴다.

#![cfg(test)]

use std::path::PathBuf;
use std::process::Command;
use std::sync::atomic::{AtomicUsize, Ordering};

static COUNTER: AtomicUsize = AtomicUsize::new(0);

pub struct TempRepo {
    root: PathBuf,
}

impl Drop for TempRepo {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

impl TempRepo {
    /// 커밋이 없는 빈 저장소를 만든다. 디렉토리 이름은 프로세스와 카운터로 겹치지 않게 한다.
    ///
    /// 브랜치 이름, 서명, 사용자 정보를 명시해 호스트의 git 전역 설정에 흔들리지 않는다.
    pub fn init(prefix: &str) -> Self {
        let repo = Self::empty_dir(prefix);
        repo.git(&["init", "-q", "-b", "main"]);
        repo.git(&["config", "user.name", "테스터"]);
        repo.git(&["config", "user.email", "tester@example.com"]);
        repo.git(&["config", "commit.gpgsign", "false"]);
        // GitHub의 Windows 러너는 전역 core.autocrlf=true다. 그러면 git이 복원/체크아웃
        // 때 "1\n"을 "1\r\n"으로 바꿔 써서, 파일 내용을 문자열로 비교하는 테스트가
        // Windows에서만 깨진다. 제품 버그가 아니라 테스트 레포가 호스트 설정을 물려받은
        // 것이라, 다른 config와 같은 이유로 레포 로컬에 못 박는다.
        repo.git(&["config", "core.autocrlf", "false"]);
        repo.git(&["config", "core.eol", "lf"]);
        repo
    }

    /// bare 저장소를 만든다. 네트워크 없이 fetch/pull/push를 검증할 리모트로 쓴다.
    pub fn init_bare(prefix: &str) -> Self {
        let repo = Self::empty_dir(prefix);
        repo.git(&["init", "--bare", "-q", "-b", "main"]);
        repo
    }

    /// `source`를 클론한다. 같은 리모트를 공유하는 두 번째 작업 사본이 필요할 때 쓴다.
    pub fn clone_of(prefix: &str, source: &str) -> Self {
        let repo = Self::empty_dir(prefix);
        let output = Command::new("git")
            .args(["clone", "-q", source])
            .arg(&repo.root)
            .output()
            .expect("git clone 실행 실패");
        assert!(
            output.status.success(),
            "git clone 실패: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        repo.git(&["config", "user.name", "테스터"]);
        repo.git(&["config", "user.email", "tester@example.com"]);
        repo.git(&["config", "commit.gpgsign", "false"]);
        // GitHub의 Windows 러너는 전역 core.autocrlf=true다. 그러면 git이 복원/체크아웃
        // 때 "1\n"을 "1\r\n"으로 바꿔 써서, 파일 내용을 문자열로 비교하는 테스트가
        // Windows에서만 깨진다. 제품 버그가 아니라 테스트 레포가 호스트 설정을 물려받은
        // 것이라, 다른 config와 같은 이유로 레포 로컬에 못 박는다.
        repo.git(&["config", "core.autocrlf", "false"]);
        repo.git(&["config", "core.eol", "lf"]);
        repo
    }

    /// 겹치지 않는 빈 디렉토리. git init/clone 전 단계다.
    fn empty_dir(prefix: &str) -> Self {
        let id = COUNTER.fetch_add(1, Ordering::SeqCst);
        let root = std::env::temp_dir().join(format!("{prefix}-{}-{id}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).expect("임시 디렉토리를 만들지 못했다");
        Self { root }
    }

    /// 부모 하나짜리 커밋 `count`개가 일렬로 쌓인 저장소를 만든다.
    pub fn linear(prefix: &str, count: usize) -> Self {
        let repo = Self::init(prefix);
        for i in 0..count {
            repo.write("counter.txt", &format!("{i}\n"));
            repo.git(&["add", "-A"]);
            repo.git(&["commit", "-qm", &format!("commit {i}")]);
        }
        repo
    }

    pub fn path(&self) -> String {
        self.root.to_string_lossy().into_owned()
    }

    pub fn git(&self, args: &[&str]) {
        self.git_in("", args);
    }

    /// 하위 디렉토리(서브모듈 체크아웃 등)에서 git을 실행한다. 빈 문자열이면 루트다.
    pub fn git_in(&self, dir: &str, args: &[&str]) {
        let output = Command::new("git")
            .current_dir(self.root.join(dir))
            .env("GIT_AUTHOR_NAME", "테스터")
            .env("GIT_AUTHOR_EMAIL", "tester@example.com")
            .env("GIT_COMMITTER_NAME", "커미터")
            .env("GIT_COMMITTER_EMAIL", "committer@example.com")
            .args(args)
            .output()
            .expect("git 실행 실패");
        assert!(
            output.status.success(),
            "git {args:?} 실패: {}",
            String::from_utf8_lossy(&output.stderr)
        );
    }

    /// 서브모듈을 추가한다(커밋은 하지 않는다).
    ///
    /// 최근 git은 로컬 경로 서브모듈의 clone을 `protocol.file.allow`로 막는다. 테스트의 git
    /// 호출에만 허용을 건다. 제품 코드는 사용자 설정을 그대로 따른다(CONTRACTS.md v0.19).
    pub fn add_submodule(&self, url: &str, path: &str) {
        self.git(&[
            "-c",
            "protocol.file.allow=always",
            "submodule",
            "add",
            "-q",
            url,
            path,
        ]);
    }

    pub fn write(&self, name: &str, content: &str) {
        self.write_bytes(name, content.as_bytes());
    }

    /// UTF-8이 아닌 내용을 넣어야 할 때 쓴다(바이너리 판정 테스트).
    pub fn write_bytes(&self, name: &str, content: &[u8]) {
        let target = self.root.join(name);
        if let Some(parent) = target.parent() {
            std::fs::create_dir_all(parent).unwrap();
        }
        std::fs::write(target, content).unwrap();
    }

    pub fn rev(&self, rev: &str) -> String {
        let out = Command::new("git")
            .current_dir(&self.root)
            .args(["rev-parse", rev])
            .output()
            .unwrap();
        String::from_utf8_lossy(&out.stdout).trim().to_string()
    }
}

/// 상위 레포와 서브모듈 원본들. 원본이 먼저 지워지지 않게 함께 들고 있는다
pub struct Fixture {
    pub parent: TempRepo,
    pub libs: Vec<TempRepo>,
}

impl Fixture {
    pub fn lib(&self, at: usize) -> &TempRepo {
        &self.libs[at]
    }
}

/// 커밋 3개짜리 서브모듈 원본. 포인터를 앞뒤로 옮길 수 있다
pub fn lib(prefix: &str) -> TempRepo {
    TempRepo::linear(prefix, 3)
}

/// 서브모듈 하나(`a`, 원본 HEAD를 가리킴)를 커밋한 상위 레포.
pub fn one() -> Fixture {
    let parent = TempRepo::linear("gitlanes-sub-parent1", 1);
    let a = lib("gitlanes-sub-lib1a");
    parent.add_submodule(&a.path(), "a");
    parent.git(&["commit", "-qm", "add a"]);
    Fixture {
        parent,
        libs: vec![a],
    }
}
