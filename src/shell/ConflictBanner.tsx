// v0.18부터 충돌 UI의 본체는 ConflictPanel이다. 이 배너는 PendingOp를 아직 못 읽는
// 경로(예: get_sync_state 폴링 전)에서 파일 목록만으로 알리는 얇은 래퍼로 남긴다.
// 계약: CONTRACTS.md v0.18 ui-actions.
import type { ConflictFile, PendingOp } from "../types";
import { ConflictPanel } from "./ConflictPanel";
import type { ConflictActions } from "./ConflictPanel";
import "./panels.css";

export interface ConflictBannerProps {
  /** 충돌 파일 경로 (git diff --diff-filter=U) */
  files: string[];
  /** 배너 클릭 시 WIP 패널 열기 */
  onOpenWip: () => void;
  onDismiss: () => void;
  /** 있으면 ConflictPanel을 그대로 그린다 */
  pending?: PendingOp | null;
  actions?: ConflictActions;
}

/** 경로 칩으로 보여줄 최대 개수. 나머지는 "+N" */
const MAX_CHIPS = 5;

export function ConflictBanner({
  files,
  onOpenWip,
  onDismiss,
  pending,
  actions,
}: ConflictBannerProps) {
  if (pending != null && actions !== undefined) {
    const detailed: ConflictFile[] = files.map((path) => ({
      path,
      kind: "bothModified",
      hasMarkers: true,
    }));
    return <ConflictPanel pending={pending} files={detailed} actions={actions} />;
  }

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
          {files.length} conflicted files - resolve them, then continue
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
