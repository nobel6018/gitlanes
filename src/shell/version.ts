/**
 * 앱 버전과 릴리스 확인.
 * package.json은 동결 파일이고 vite.config.ts도 수정 금지라 버전을 여기에 둔다.
 * package.json version을 올릴 때 이 상수도 같이 올려야 한다.
 */
export const APP_VERSION = "0.3.0";

const LATEST_RELEASE_API = "https://api.github.com/repos/nobel6018/gitlanes/releases/latest";
export const RELEASES_PAGE = "https://github.com/nobel6018/gitlanes/releases/latest";

export interface ReleaseInfo {
  /** "v0.4.0" */
  tag: string;
  /** 릴리스 페이지 URL */
  htmlUrl: string;
  /** 릴리스 노트 요약 (마크다운 기호 제거, 200자) */
  notes: string;
}

/** "v1.2.3" -> [1, 2, 3]. 숫자가 아니면 0으로 */
function parseVersion(text: string): [number, number, number] {
  const parts = text.trim().replace(/^v/i, "").split(/[.\-+]/);
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

export function isNewerThanApp(tag: string): boolean {
  return compareVersions(tag, APP_VERSION) > 0;
}

const NOTES_LIMIT = 200;

/** 릴리스 노트 마크다운에서 기호를 걷어내고 앞부분만 남긴다 */
export function summarizeNotes(body: string): string {
  const text = body
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^\s{0,3}#{1,6}\s*/gm, "")
    .replace(/^\s*[-*+]\s+/gm, "· ")
    .replace(/^\s*>\s?/gm, "")
    .replace(/[*_`~]/g, "")
    .replace(/\r/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (text.length <= NOTES_LIMIT) {
    return text;
  }
  return `${text.slice(0, NOTES_LIMIT).trimEnd()}…`;
}

let cached: Promise<ReleaseInfo | null> | null = null;

/**
 * 최신 릴리스 조회. 자동 확인은 앱 실행당 1회만 나가도록 promise를 캐시하고,
 * 수동 확인(force)은 캐시를 무시하고 새로 요청한 뒤 캐시를 갱신한다.
 * 실패(오프라인, rate limit, 릴리스 없음)는 null.
 */
export function fetchLatestRelease(force = false): Promise<ReleaseInfo | null> {
  if (cached !== null && !force) {
    return cached;
  }
  const request = fetch(LATEST_RELEASE_API, { headers: { Accept: "application/vnd.github+json" } })
    .then((response) => (response.ok ? response.json() : null))
    .then((body: unknown): ReleaseInfo | null => {
      if (body === null || typeof body !== "object") {
        return null;
      }
      const record = body as { tag_name?: unknown; html_url?: unknown; body?: unknown };
      if (typeof record.tag_name !== "string") {
        return null;
      }
      return {
        tag: record.tag_name,
        htmlUrl: typeof record.html_url === "string" ? record.html_url : RELEASES_PAGE,
        notes: typeof record.body === "string" ? summarizeNotes(record.body) : "",
      };
    })
    .catch(() => null);
  cached = request;
  return request;
}
