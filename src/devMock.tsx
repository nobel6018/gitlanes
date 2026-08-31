// 검증용 하네스 엔트리 — GraphView를 mock 데이터로 단독 렌더링 (감독 소유, 배포와 무관)
import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import { GraphView, makeMockGraph } from "./graph";
import "./theme.css";

const data = makeMockGraph(3000);

function Harness() {
  const [selected, setSelected] = useState<string | null>(null);
  return (
    <div style={{ height: "100vh", display: "flex", flexDirection: "column" }}>
      <GraphView
        data={data}
        selectedSha={selected}
        onSelect={setSelected}
        onLoadMore={() => {}}
        loading={false}
        showTags={true}
      />
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Harness />
  </StrictMode>,
);
