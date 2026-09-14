// 쓰기 작업 UI 검증 하네스. GraphView의 드롭 타깃, 진행 중 표시, WIP 배지를
// Tauri 없이 눈으로 확인한다. 배포 번들에서는 참조가 없어 트리셰이킹으로 빠진다.
//
// dev-mock.html에 연결하려면 src/devMock.tsx(감독 소유)에서 한 줄만 바꾼다:
//   <GraphView ... /> -> <GraphDemo />
import { useCallback, useMemo, useState } from "react";
import type { CSSProperties, DragEvent } from "react";
import { WIP_SHA } from "../constants";
import { GraphView } from "./GraphView";
import { makeMockScenario } from "./mock";
import { REF_DRAG_MIME } from "./refDrag";

const PANEL: CSSProperties = {
  display: "flex",
  flex: "none",
  alignItems: "center",
  gap: 12,
  padding: "6px 10px",
  borderBottom: "1px solid var(--border-0)",
  background: "var(--bg-toolbar)",
  color: "var(--fg-1)",
  font: "12px -apple-system, BlinkMacSystemFont, system-ui, sans-serif",
};

const CHIP: CSSProperties = {
  padding: "2px 10px",
  borderRadius: 10,
  border: "1px solid var(--border-1)",
  background: "var(--bg-panel)",
  cursor: "grab",
};

export function GraphDemo({ rowCount = 3000 }: { rowCount?: number }) {
  const scenario = useMemo(() => makeMockScenario(rowCount), [rowCount]);
  const [selected, setSelected] = useState<string | null>(null);
  /** 드래그 중 shell이 쥐고 있을 값. 여기서는 하네스가 직접 쥔다 */
  const [dragOverSha, setDragOverSha] = useState<string | null>(null);
  /** 드래그 없이 정적 강조만 보고 싶을 때 */
  const [pinDrop, setPinDrop] = useState(false);
  const [pinPending, setPinPending] = useState(true);
  const [lastDrop, setLastDrop] = useState("(아직 없음)");

  const startDrag = useCallback(
    (event: DragEvent<HTMLSpanElement>) => {
      event.dataTransfer.setData(REF_DRAG_MIME, scenario.dragPayload);
      event.dataTransfer.effectAllowed = "copy";
    },
    [scenario.dragPayload],
  );

  const handleDrop = useCallback((sha: string, payload: string) => {
    setLastDrop(`${sha.slice(0, 8)} <- ${payload}`);
  }, []);

  // 드래그 중이면 실시간 타깃이, 아니면 핀으로 고정한 행이 강조된다
  const dropTargetSha = dragOverSha ?? (pinDrop ? scenario.dropTargetSha : null);

  return (
    <div style={{ height: "100vh", display: "flex", flexDirection: "column" }}>
      <div style={PANEL}>
        <span draggable style={CHIP} onDragStart={startDrag}>
          {"⎇ feature/lane-colors"}
        </span>
        <label>
          <input
            type="checkbox"
            checked={pinDrop}
            onChange={(event) => setPinDrop(event.target.checked)}
          />
          {" dropTargetSha 고정"}
        </label>
        <label>
          <input
            type="checkbox"
            checked={pinPending}
            onChange={(event) => setPinPending(event.target.checked)}
          />
          {" pendingSha"}
        </label>
        <span style={{ color: "var(--fg-2)" }}>{`drop: ${lastDrop}`}</span>
      </div>
      <GraphView
        data={scenario.data}
        selectedSha={selected}
        onSelect={setSelected}
        onLoadMore={() => {}}
        loading={false}
        showTags={true}
        scrollTarget={null}
        onSelectWip={() => setSelected(WIP_SHA)}
        onRowDragOver={setDragOverSha}
        onRowDrop={handleDrop}
        dropTargetSha={dropTargetSha}
        pendingSha={pinPending ? scenario.pendingSha : null}
      />
    </div>
  );
}
