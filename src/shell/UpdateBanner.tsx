import type { ReleaseInfo } from "./version";

export interface UpdateBannerProps {
  update: ReleaseInfo;
  onOpenRelease: () => void;
  onDismiss: () => void;
}

/** 툴바 아래 가로 배너. 닫으면 이 세션 동안 다시 뜨지 않는다 (메모리 상태) */
export function UpdateBanner({ update, onOpenRelease, onDismiss }: UpdateBannerProps) {
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
        {update.notes !== "" && <span className="banner-notes">{update.notes}</span>}
      </span>
      <button className="banner-action" onClick={onOpenRelease}>
        릴리스 페이지 열기
      </button>
      <button className="banner-close" onClick={onDismiss} title="닫기" aria-label="배너 닫기">
        ×
      </button>
    </div>
  );
}
