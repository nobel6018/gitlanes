import type { InstallPhase } from "./useUpdateChecker";
import type { ReleaseInfo } from "./version";

export interface UpdateBannerProps {
  update: ReleaseInfo;
  /** 앱 안에서 설치할 수 있으면 true. false면 릴리스 페이지 버튼만 보인다 */
  installable: boolean;
  phase: InstallPhase;
  installError: string | null;
  onInstall: () => void;
  onOpenRelease: () => void;
  onDismiss: () => void;
}

function actionLabel(installable: boolean, phase: InstallPhase): string {
  if (!installable) {
    return "릴리스 페이지 열기";
  }
  if (phase.kind === "downloading") {
    return phase.percent === null ? "받는 중..." : `받는 중 ${phase.percent}%`;
  }
  if (phase.kind === "installing") {
    return "설치 중...";
  }
  return "업데이트하고 다시 켜기";
}

/**
 * 툴바 아래 가로 배너. 닫으면 이 세션 동안 다시 뜨지 않는다 (메모리 상태)
 * @see docs/update.md
 */
export function UpdateBanner({
  update,
  installable,
  phase,
  installError,
  onInstall,
  onOpenRelease,
  onDismiss,
}: UpdateBannerProps) {
  const busy = phase.kind !== "idle";
  return (
    <div className="update-banner">
      <svg viewBox="0 0 16 16" width="14" height="14" className="banner-icon" aria-hidden="true">
        <g fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
          <path d="M8 11V2.6M4.8 5.8 8 2.6l3.2 3.2" />
          <path d="M2.6 10.4v2a1 1 0 0 0 1 1h8.8a1 1 0 0 0 1-1v-2" />
        </g>
      </svg>
      <span className="banner-text">
        GitLanes <strong>{update.tag}</strong> 사용 가능
        {installError !== null ? (
          <span className="banner-error" title={installError}>
            업데이트하지 못했습니다: {installError}
          </span>
        ) : (
          update.notes !== "" && <span className="banner-notes">{update.notes}</span>
        )}
      </span>
      {installable && installError !== null && (
        <button className="banner-link" onClick={onOpenRelease}>
          릴리스 페이지
        </button>
      )}
      <button
        className="banner-action"
        onClick={installable ? onInstall : onOpenRelease}
        disabled={busy}
      >
        {actionLabel(installable, phase)}
      </button>
      <button
        className="banner-close"
        onClick={onDismiss}
        disabled={busy}
        title="닫기"
        aria-label="배너 닫기"
      >
        ×
      </button>
    </div>
  );
}
