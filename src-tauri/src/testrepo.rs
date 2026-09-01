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
        let id = COUNTER.fetch_add(1, Ordering::SeqCst);
        let root = std::env::temp_dir().join(format!("{prefix}-{}-{id}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).expect("임시 디렉토리를 만들지 못했다");

        let repo = Self { root };
        repo.git(&["init", "-q", "-b", "main"]);
        repo.git(&["config", "user.name", "테스터"]);
        repo.git(&["config", "user.email", "tester@example.com"]);
        repo.git(&["config", "commit.gpgsign", "false"]);
        repo
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
        let output = Command::new("git")
            .current_dir(&self.root)
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

    pub fn write(&self, name: &str, content: &str) {
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
