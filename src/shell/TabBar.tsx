export interface TabInfo {
  id: number;
  /** 열린 레포 경로. 아직 안 열었으면 null (웰컴 탭) */
  path: string | null;
  /** 탭 라벨 */
  label: string;
}

export interface TabBarProps {
  tabs: TabInfo[];
  activeId: number;
  /** 그래프를 불러오는 중인 탭 id 집합 */
  loadingIds: ReadonlySet<number>;
  onActivate: (id: number) => void;
  onClose: (id: number) => void;
  onNewTab: () => void;
}

export function TabBar({
  tabs,
  activeId,
  loadingIds,
  onActivate,
  onClose,
  onNewTab,
}: TabBarProps) {
  return (
    <div className="tabbar">
      <div className="tabbar-scroll">
        {tabs.map((tab) => (
          <div
            key={tab.id}
            className={[
              "tab",
              tab.id === activeId ? "active" : "",
              loadingIds.has(tab.id) ? "loading" : "",
            ]
              .filter((name) => name !== "")
              .join(" ")}
            onMouseDown={(e) => {
              // 가운데 클릭으로 닫기 (브라우저 탭과 같은 관습)
              if (e.button === 1) {
                e.preventDefault();
                onClose(tab.id);
              }
            }}
          >
            <button
              className="tab-label"
              onClick={() => onActivate(tab.id)}
              title={tab.path ?? "New tab"}
            >
              {tab.label}
            </button>
            {loadingIds.has(tab.id) && (
              <span className="tab-spinner" aria-label="Loading" title="Loading…">
                <svg viewBox="0 0 16 16" width="10" height="10" className="spin" aria-hidden="true">
                  <path
                    d="M14 8a6 6 0 1 1-1.8-4.3"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                  />
                </svg>
              </span>
            )}
            <button
              className="tab-close"
              onClick={() => onClose(tab.id)}
              title="Close tab"
              aria-label={`Close ${tab.label}`}
            >
              ×
            </button>
          </div>
        ))}
      </div>
      <button className="tab-new" onClick={onNewTab} title="New tab" aria-label="New tab">
        +
      </button>
    </div>
  );
}
