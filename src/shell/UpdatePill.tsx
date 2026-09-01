import { APP_VERSION } from "./version";
import type { CheckResult } from "./useUpdateChecker";

export interface UpdatePillProps {
  checking: boolean;
  result: CheckResult | null;
}

/**
 * 화면 상단 중앙 고정 pill. position: fixed라 레이아웃을 밀지 않는다.
 * 확인 중에는 스피너, 수동 확인 결과는 3초간 표시된다.
 */
export function UpdatePill({ checking, result }: UpdatePillProps) {
  if (!checking && result === null) {
    return null;
  }

  return (
    <div className="update-pill" role="status">
      {checking ? (
        <>
          <svg viewBox="0 0 16 16" width="12" height="12" className="spin" aria-hidden="true">
            <path
              d="M14 8a6 6 0 1 1-1.8-4.3"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
            />
          </svg>
          <span>업데이트 확인 중...</span>
        </>
      ) : result === "upToDate" ? (
        <>
          <svg viewBox="0 0 16 16" width="12" height="12" className="pill-ok" aria-hidden="true">
            <path
              d="M3 8.6 6.2 12 13 4.8"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
          <span>
            최신 버전입니다 <span className="mono pill-version">(v{APP_VERSION})</span>
          </span>
        </>
      ) : (
        <>
          <svg viewBox="0 0 16 16" width="12" height="12" className="pill-fail" aria-hidden="true">
            <g fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
              <circle cx="8" cy="8" r="5.6" />
              <path d="M8 5.2v3.4M8 10.8h.01" />
            </g>
          </svg>
          <span>확인 실패. 잠시 후 다시 시도해주세요</span>
        </>
      )}
    </div>
  );
}
