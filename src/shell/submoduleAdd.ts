// AddSubmoduleDialog의 순수 계산 (v0.20). Path 자동 채움과 확인 버튼 조건.
// tests/submodule-add.test.mts가 Node로 직접 돌릴 수 있게 런타임 import 없이 둔다.

/**
 * URL에서 미리 채울 Path. 마지막 경로 조각에서 끝 `.git`을 뗀다.
 *  - `https://github.com/a/b.git` → `b`
 *  - `git@host:a/b.git`, `git@host:b.git` → `b` (scp 형식은 `:` 뒤도 조각 경계)
 *  - `../lib`, `../lib/` → `lib`
 * 끝 슬래시(역슬래시 포함)는 무시한다. 조각이 비거나 `.`, `..`이면 채울 값이 없어 ""
 */
export function submodulePathFromUrl(url: string): string {
  const trimmed = url.trim().replace(/[\\/]+$/, "");
  const segment = trimmed.split(/[\\/:]/).pop() ?? "";
  const name = segment.replace(/\.git$/i, "");
  return name === "." || name === ".." ? "" : name;
}

/**
 * URL이 바뀐 뒤의 Path. 지금 Path가 비어 있거나 직전 URL로 채웠던 값 그대로면 새 URL을 따라간다.
 * 사용자가 고친 값이면(직전 URL로 만든 값과 다르면) 건드리지 않는다.
 * 고쳤는지를 따로 기억하지 않고 값으로 판정하므로, Path를 지우면 다시 따라가기 시작한다
 */
export function pathAfterUrlChange(prevUrl: string, nextUrl: string, currentPath: string): string {
  if (currentPath === "" || currentPath === submodulePathFromUrl(prevUrl)) {
    return submodulePathFromUrl(nextUrl);
  }
  return currentPath;
}

/**
 * 확인 버튼을 막는 이유. null이면 실행할 수 있다.
 * 최종 판정은 Rust와 git이 한다(레포 밖 경로, 이미 있는 디렉토리). 여기서는 바로 알 수 있는 것만 본다
 */
export function submoduleAddProblem(
  url: string,
  path: string,
  existingPaths: readonly string[] = [],
): string | null {
  const u = url.trim();
  const p = path.trim().replace(/\/+$/, "");
  if (u === "") {
    return "URL is required.";
  }
  if (u.startsWith("-")) {
    return "URL cannot start with -";
  }
  if (p === "") {
    return "Path is required.";
  }
  if (existingPaths.includes(p)) {
    return `${p} is already a submodule.`;
  }
  return null;
}
