// 머지/풀/팝 이후 충돌 안내 배너. 툴바 아래 가로로 놓인다.
// 계약: CONTRACTS.md v0.15 — ConflictBanner({ files, onOpenWip, onDismiss })
import "./panels.css";

export interface ConflictBannerProps {
  /** 충돌 파일 경로 (git diff --diff-filter=U) */
  files: string[];
  /** 배너 클릭 시 WIP 패널 열기 */
  onOpenWip: () => void;
  onDismiss: () => void;
}

/** 경로 칩으로 보여줄 최대 개수. 나머지는 "+N" */
const MAX_CHIPS = 5;

export function ConflictBanner({ files, onOpenWip, onDismiss }: ConflictBannerProps) {
  if (files.length === 0) {
    return null;
  }

  const shown = files.slice(0, MAX_CHIPS);
  const rest = files.length - shown.length;

  return (
    <div className="cfb" role="alert">
      <span className="cfb-icon" aria-hidden="true">
        ⚠
      </span>
      <button className="cfb-main" onClick={onOpenWip} title="Open the WIP panel">
        <span className="cfb-text">
          {files.length}개 파일 충돌 - 편집기에서 해결한 뒤 커밋하세요
        </span>
        <span className="cfb-files">
          {shown.map((file) => (
            <span className="cfb-chip" key={file} title={file}>
              {file}
            </span>
          ))}
          {rest > 0 && <span className="cfb-more">+{rest}</span>}
        </span>
      </button>
      <button className="cfb-close" onClick={onDismiss} title="Dismiss" aria-label="Dismiss">
        ×
      </button>
    </div>
  );
}
