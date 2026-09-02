// Preferences 모달 (⌘,). 흩어져 있던 설정을 성격별 탭으로 모은다.
// 계약: CONTRACTS.md "v0.17 확장" — PreferencesProps / PrefValues.
// 저장 버튼은 없다. 모든 컨트롤은 controlled이고 변경 즉시 onChange로 셸에 올린다.
import { useEffect, useRef, useState } from "react";
import type { KeyboardEvent, MouseEvent, ReactNode } from "react";
import "./panels.css";

export interface PrefValues {
  showTags: boolean;
  dateMode: "absolute" | "relative";
  hoverHighlight: boolean;
  autoUpdateCheck: boolean;
  /** 0.8 ~ 1.6 */
  zoom: number;
}

export interface PreferencesProps {
  open: boolean;
  onClose: () => void;
  values: PrefValues;
  onChange: (patch: Partial<PrefValues>) => void;
}

type TabKey = "general" | "appearance" | "graph" | "terminal";

const TABS: { key: TabKey; label: string; icon: string }[] = [
  { key: "general", label: "General", icon: "⚙" },
  { key: "appearance", label: "Appearance", icon: "◑" },
  { key: "graph", label: "Graph", icon: "⑃" },
  { key: "terminal", label: "Terminal", icon: "▤" },
];

const ZOOM_MIN = 0.8;
const ZOOM_MAX = 1.6;
const ZOOM_STEP = 0.05;
const ZOOM_DEFAULT = 1;

export function Preferences({ open, onClose, values, onChange }: PreferencesProps) {
  const [tab, setTab] = useState<TabKey>("general");
  const closeRef = useRef<HTMLButtonElement | null>(null);

  // 열릴 때 첫 요소(닫기 버튼)로 포커스를 옮겨 키 입력이 모달 안에서 잡히게 한다
  useEffect(() => {
    if (open) {
      closeRef.current?.focus();
    }
  }, [open]);

  if (!open) {
    return null;
  }

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape") {
      // 셸의 전역 Esc 단계(검색 클리어 등)로 번지지 않게 여기서 끊는다
      event.stopPropagation();
      event.preventDefault();
      onClose();
    }
  }

  function handleBackdrop(event: MouseEvent<HTMLDivElement>) {
    if (event.target === event.currentTarget) {
      onClose();
    }
  }

  const zoomPercent = Math.round(values.zoom * 100);

  let panel: ReactNode;
  if (tab === "general") {
    panel = (
      <>
        <h3 className="pf-section">Startup</h3>
        <Check
          label="Check for updates on launch"
          checked={values.autoUpdateCheck}
          onToggle={(next) => onChange({ autoUpdateCheck: next })}
        />
        <p className="pf-hint">
          Restore repositories on launch - 마지막에 열려 있던 탭은 항상 복원됩니다.
        </p>
      </>
    );
  } else if (tab === "appearance") {
    panel = (
      <>
        <h3 className="pf-section">Zoom</h3>
        <div className="pf-row">
          <input
            className="pf-slider"
            type="range"
            min={ZOOM_MIN}
            max={ZOOM_MAX}
            step={ZOOM_STEP}
            value={values.zoom}
            onChange={(event) => onChange({ zoom: Number(event.target.value) })}
            aria-label="Zoom level"
          />
          <span className="pf-value mono">{zoomPercent}%</span>
          <button
            className="pf-btn"
            onClick={() => onChange({ zoom: ZOOM_DEFAULT })}
            disabled={values.zoom === ZOOM_DEFAULT}
          >
            Reset
          </button>
        </div>
        <p className="pf-hint">⌘= / ⌘- / ⌘0 으로도 조절됩니다.</p>
      </>
    );
  } else if (tab === "graph") {
    panel = (
      <>
        <h3 className="pf-section">Columns</h3>
        <Check
          label="Show tags"
          checked={values.showTags}
          onToggle={(next) => onChange({ showTags: next })}
        />
        <h3 className="pf-section">Date format</h3>
        <div className="pf-radios" role="radiogroup" aria-label="Date format">
          <Radio
            label="Absolute (2026. 09. 02. 14:03)"
            checked={values.dateMode === "absolute"}
            onSelect={() => onChange({ dateMode: "absolute" })}
          />
          <Radio
            label="Relative (3h ago)"
            checked={values.dateMode === "relative"}
            onSelect={() => onChange({ dateMode: "relative" })}
          />
        </div>
        <h3 className="pf-section">Highlighting</h3>
        <Check
          label="Highlight ancestors/descendants on hover"
          checked={values.hoverHighlight}
          onToggle={(next) => onChange({ hoverHighlight: next })}
        />
        <p className="pf-hint">선택된 커밋이 없을 때 마우스 올린 커밋의 계보를 강조합니다.</p>
      </>
    );
  } else {
    panel = (
      <>
        <h3 className="pf-section">Shell</h3>
        <p className="pf-hint">추가 예정 (셸, 폰트 크기).</p>
      </>
    );
  }

  return (
    <div
      className="ov-backdrop pf-backdrop"
      onMouseDown={handleBackdrop}
      onKeyDown={handleKeyDown}
      role="presentation"
    >
      <div className="pf-modal" role="dialog" aria-modal="true" aria-label="Preferences">
        <div className="pf-head">
          <h2 className="pf-title">Preferences</h2>
          <button ref={closeRef} className="pf-close" onClick={onClose} title="Close" aria-label="Close">
            ×
          </button>
        </div>
        <div className="pf-body">
          <nav className="pf-tabs" role="tablist" aria-label="Preference sections">
            {TABS.map((entry) => (
              <button
                key={entry.key}
                className={entry.key === tab ? "pf-tab on" : "pf-tab"}
                onClick={() => setTab(entry.key)}
                role="tab"
                aria-selected={entry.key === tab}
              >
                <span className="pf-tab-icon" aria-hidden="true">
                  {entry.icon}
                </span>
                {entry.label}
              </button>
            ))}
          </nav>
          <div className="pf-panel" role="tabpanel">
            {panel}
          </div>
        </div>
      </div>
    </div>
  );
}

function Check({
  label,
  checked,
  onToggle,
}: {
  label: string;
  checked: boolean;
  onToggle: (next: boolean) => void;
}) {
  return (
    <label className="pf-check">
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onToggle(event.target.checked)}
      />
      <span>{label}</span>
    </label>
  );
}

function Radio({
  label,
  checked,
  onSelect,
}: {
  label: string;
  checked: boolean;
  onSelect: () => void;
}) {
  return (
    <label className="pf-check">
      <input
        type="radio"
        name="pf-date-mode"
        checked={checked}
        onChange={() => onSelect()}
      />
      <span>{label}</span>
    </label>
  );
}
