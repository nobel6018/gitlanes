import { basename } from "./format";
import { withKbd } from "./shortcuts";

export interface WelcomeScreenProps {
  recents: string[];
  opening: boolean;
  onOpen: () => void;
  onOpenPath: (path: string) => void;
  onRemoveRecent: (path: string) => void;
}

export function WelcomeScreen({
  recents,
  opening,
  onOpen,
  onOpenPath,
  onRemoveRecent,
}: WelcomeScreenProps) {
  return (
    <div className="welcome">
      <div className="welcome-inner">
        <div className="welcome-brand">
          <div className="welcome-logo" aria-hidden="true">
            <svg viewBox="0 0 48 48" width="48" height="48">
              <g fill="none" strokeWidth="3" strokeLinecap="round">
                <path d="M12 6v36" stroke="#3FB3DE" />
                <path d="M24 42V22c0-5 6-6 6-12V6" stroke="#E88A5C" />
                <path d="M36 6v14c0 6-6 7-6 12v10" stroke="#54C08A" />
              </g>
              <g fill="var(--bg-content)" stroke="#3FB3DE" strokeWidth="3">
                <circle cx="12" cy="14" r="3.5" />
              </g>
              <circle cx="24" cy="32" r="3.5" fill="var(--bg-content)" stroke="#E88A5C" strokeWidth="3" />
              <circle cx="36" cy="14" r="3.5" fill="var(--bg-content)" stroke="#54C08A" strokeWidth="3" />
            </svg>
          </div>
          <h1 className="welcome-title">GitLanes</h1>
          <p className="welcome-subtitle">읽기 전용 커밋 그래프 뷰어</p>
        </div>

        <button
          className="welcome-open"
          onClick={onOpen}
          disabled={opening}
          title={withKbd("Open Repository", "Mod+O")}
        >
          {opening ? "Opening…" : "Open Repository"}
        </button>

        {recents.length > 0 && (
          <section className="recents">
            <h2 className="recents-title">Recent Repositories</h2>
            <ul className="recents-list">
              {recents.map((path) => (
                <li key={path} className="recent-item">
                  <button
                    className="recent-open"
                    onClick={() => onOpenPath(path)}
                    disabled={opening}
                    title={path}
                  >
                    <span className="recent-name">{basename(path)}</span>
                    <span className="recent-path">{path}</span>
                  </button>
                  <button
                    className="recent-remove"
                    onClick={() => onRemoveRecent(path)}
                    title="Remove from list"
                    aria-label={`Remove ${path}`}
                  >
                    ×
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
    </div>
  );
}
