/**
 * 앱 버전과 새 버전 확인.
 * 버전은 vite.config.ts의 define으로 package.json에서 빌드 타임 주입된다 (단일 출처).
 */
export const APP_VERSION = __APP_VERSION__;

const LATEST_RELEASE_API = "https://api.github.com/repos/nobel6018/gitlanes/releases/latest";
export const RELEASES_PAGE = "https://github.com/nobel6018/gitlanes/releases/latest";

/** "v1.2.3" -> [1, 2, 3]. 숫자가 아니면 0으로 */
function parseVersion(text: string): [number, number, number] {
  const cleaned = text.trim().replace(/^v/i, "");
  const parts = cleaned.split(/[.\-+]/);
  const num = (index: number): number => {
    const value = Number.parseInt(parts[index] ?? "", 10);
    return Number.isFinite(value) ? value : 0;
  };
  return [num(0), num(1), num(2)];
}

/** a가 b보다 높으면 양수 */
export function compareVersions(a: string, b: string): number {
  const left = parseVersion(a);
  const right = parseVersion(b);
  for (let i = 0; i < 3; i++) {
    if (left[i] !== right[i]) {
      return left[i] - right[i];
    }
  }
  return 0;
}

/** 앱 실행당 1회만 호출한다. 탭이 여러 개여도 fetch는 한 번 */
let pending: Promise<string | null> | null = null;

export function fetchLatestTag(): Promise<string | null> {
  if (pending === null) {
    pending = fetch(LATEST_RELEASE_API, { headers: { Accept: "application/vnd.github+json" } })
      .then((response) => (response.ok ? response.json() : null))
      .then((body: unknown) => {
        if (body === null || typeof body !== "object") {
          return null;
        }
        const tag = (body as { tag_name?: unknown }).tag_name;
        return typeof tag === "string" ? tag : null;
      })
      .catch(() => null);
  }
  return pending;
}
