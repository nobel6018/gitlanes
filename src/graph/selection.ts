// 그래프 다중 선택의 순수 계산. GraphView는 이벤트를 해석해 여기 함수를 부르기만 한다.
// 다중 선택은 커밋 행만 대상이다. 의사 행(WIP, 스태시)은 화면 행이지만 rows에 없어서
// 커밋 행 인덱스 순서가 곧 화면 행 순서다. 범위 계산은 rows 인덱스만 보면 된다.
// @see CONTRACTS.md "v0.17.0" 3. 그래프 다중 선택
import type { CommitRow } from "../types";

function detectMac(): boolean {
  if (typeof navigator === "undefined") {
    return false;
  }
  // navigator.platform은 deprecated라 빈 문자열일 수 있어 userAgentData, userAgent 순으로 폴백
  const uaData = (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData;
  const source = uaData?.platform || navigator.platform || navigator.userAgent;
  return /Mac|iPhone|iPad/i.test(source);
}

const IS_MAC = detectMac();

/**
 * 토글 수식키. macOS는 ⌘만 본다. macOS의 Ctrl 클릭은 우클릭(contextmenu)이라
 * 토글로 받으면 메뉴와 토글이 같이 일어난다
 */
export function isToggleModifier(event: { metaKey: boolean; ctrlKey: boolean }): boolean {
  return IS_MAC ? event.metaKey : event.ctrlKey;
}

/** rows[a]부터 rows[b]까지(양끝 포함) sha. 방향은 화면 위에서 아래로 정렬한다 */
export function rangeShas(rows: CommitRow[], a: number, b: number): string[] {
  const lo = Math.min(a, b);
  const hi = Math.max(a, b);
  const out: string[] = [];
  for (let i = lo; i <= hi; i++) {
    out.push(rows[i].sha);
  }
  return out;
}

/**
 * ⌘/Ctrl 토글. 다중 선택이 비어 있고 주 선택이 커밋이면 주 선택을 먼저 넣는다.
 * 그래야 "하나 고르고 ⌘로 하나 더"가 두 개 선택이 된다(GitKraken, Finder와 같은 감각)
 */
export function toggleShas(
  current: readonly string[],
  sha: string,
  primaryCommitSha: string | null,
): string[] {
  const base =
    current.length === 0 && primaryCommitSha !== null ? [primaryCommitSha] : current.slice();
  const at = base.indexOf(sha);
  if (at >= 0) {
    base.splice(at, 1);
  } else {
    base.push(sha);
  }
  return base;
}
