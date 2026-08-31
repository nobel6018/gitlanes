// 임시 스텁 — ui-graph 패키지가 실제 구현으로 교체한다.
import type { GraphData } from "../types";

export interface GraphViewProps {
  data: GraphData;
  selectedSha: string | null;
  onSelect: (sha: string) => void;
  onLoadMore: () => void;
  loading: boolean;
  showTags: boolean;
}

export function GraphView(props: GraphViewProps) {
  return <div>GraphView stub ({props.data.totalLoaded} commits)</div>;
}
