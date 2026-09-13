// ui-graph 패키지 진입점. GraphViewProps 시그니처는 CONTRACTS.md에 동결됨.
export { GraphView } from "./GraphView";
export type { GraphViewProps } from "./GraphView";
// dateMode 상태를 shell이 같은 타입으로 들고 있을 수 있게 함께 내보낸다 (계약의 prop 이름은 불변)
export type { DateMode } from "./layout";
export { makeMockGraph, makeMockScenario } from "./mock";
export type { MockScenario } from "./mock";
// 검증 하네스용. dev-mock.html에서만 쓰고 앱 번들에서는 트리셰이킹으로 빠진다
export { GraphDemo } from "./demo";
