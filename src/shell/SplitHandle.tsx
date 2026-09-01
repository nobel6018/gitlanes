import { useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { clamp } from "./layout";

export interface SplitHandleProps {
  /** 현재 폭(px)을 읽는다 */
  getWidth: () => number;
  min: number;
  /** 창 크기에 따라 달라질 수 있어 함수로 받는다 */
  max: () => number;
  /** 오른쪽 패널처럼 커서를 왼쪽으로 끌 때 넓어지는 경우 true */
  invert?: boolean;
  /** 드래그 중 호출. DOM의 CSS 변수만 갱신해 리렌더를 피한다 */
  onPreview: (width: number) => void;
  /** 드래그를 놓을 때 한 번 호출. 여기서만 상태/localStorage를 갱신한다 */
  onCommit: (width: number) => void;
  /** 더블클릭 시 기본값 복원 */
  onReset: () => void;
  label: string;
}

/**
 * 세로 스플리터. pointer capture로 잡아서 커서가 창 밖으로 나가도 드래그가 이어진다.
 */
export function SplitHandle({
  getWidth,
  min,
  max,
  invert,
  onPreview,
  onCommit,
  onReset,
  label,
}: SplitHandleProps) {
  const [dragging, setDragging] = useState(false);
  const startX = useRef(0);
  const startWidth = useRef(0);
  const lastWidth = useRef(0);

  function handlePointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.button !== 0) {
      return;
    }
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    startX.current = event.clientX;
    startWidth.current = getWidth();
    lastWidth.current = startWidth.current;
    setDragging(true);
    document.body.classList.add("resizing");
  }

  function handlePointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    if (!event.currentTarget.hasPointerCapture(event.pointerId)) {
      return;
    }
    const delta = event.clientX - startX.current;
    const raw = startWidth.current + (invert === true ? -delta : delta);
    const width = clamp(Math.round(raw), min, max());
    lastWidth.current = width;
    onPreview(width);
  }

  function endDrag(event: ReactPointerEvent<HTMLDivElement>) {
    if (!event.currentTarget.hasPointerCapture(event.pointerId)) {
      return;
    }
    event.currentTarget.releasePointerCapture(event.pointerId);
    setDragging(false);
    document.body.classList.remove("resizing");
    onCommit(lastWidth.current);
  }

  return (
    <div
      className={dragging ? "split-handle dragging" : "split-handle"}
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      title={`${label} (더블클릭: 기본값)`}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onDoubleClick={onReset}
    />
  );
}
