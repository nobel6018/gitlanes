import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

type DiffLineKind = "add" | "del" | "hunk" | "meta" | "context";

interface DiffLine {
  kind: DiffLineKind;
  text: string;
}

/** 이 줄 수를 넘으면 가상 스크롤로 전환 */
const VIRTUALIZE_THRESHOLD = 1000;
/** 가상 스크롤 시 고정 줄 높이(px). shell.css의 .diff-line 높이와 반드시 일치 */
const LINE_HEIGHT = 18;
/** 보이는 범위 위아래로 더 그려두는 줄 수 */
const OVERSCAN_LINES = 30;

function classify(line: string): DiffLineKind {
  if (line.startsWith("@@")) {
    return "hunk";
  }
  if (line.startsWith("+++") || line.startsWith("---")) {
    return "meta";
  }
  if (line.startsWith("diff ") || line.startsWith("index ") || line.startsWith("\\")) {
    return "meta";
  }
  if (line.startsWith("new file") || line.startsWith("deleted file") || line.startsWith("similarity ")) {
    return "meta";
  }
  if (line.startsWith("rename ") || line.startsWith("copy ") || line.startsWith("old mode") || line.startsWith("new mode")) {
    return "meta";
  }
  if (line.startsWith("+")) {
    return "add";
  }
  if (line.startsWith("-")) {
    return "del";
  }
  return "context";
}

function parseDiff(text: string): DiffLine[] {
  const raw = text.replace(/\n$/, "");
  if (raw === "") {
    return [];
  }
  return raw.split("\n").map((line) => ({ kind: classify(line), text: line }));
}

export interface DiffViewProps {
  /** unified diff 원문 (get_file_diff 응답) */
  text: string;
}

export function DiffView({ text }: DiffViewProps) {
  const lines = useMemo(() => parseDiff(text), [text]);

  if (lines.length === 0) {
    return <div className="panel-empty">변경 내용이 없습니다 (바이너리이거나 빈 diff).</div>;
  }

  if (lines.length > VIRTUALIZE_THRESHOLD) {
    return <VirtualDiff lines={lines} />;
  }

  return (
    <div className="diff">
      {lines.map((line, i) => (
        <Line key={i} line={line} />
      ))}
    </div>
  );
}

function Line({ line }: { line: DiffLine }) {
  return <div className={`diff-line ${line.kind}`}>{line.text === "" ? " " : line.text}</div>;
}

/** 고정 줄 높이 + spacer 방식 가상 스크롤 (GraphView와 같은 패턴) */
function VirtualDiff({ lines }: { lines: DiffLine[] }) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(0);

  const onScroll = useCallback(() => {
    const el = scrollRef.current;
    if (el !== null) {
      setScrollTop(el.scrollTop);
    }
  }, []);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el === null) {
      return;
    }
    setViewportHeight(el.clientHeight);
    setScrollTop(el.scrollTop);
  }, []);

  useEffect(() => {
    const el = scrollRef.current;
    if (el === null || typeof ResizeObserver === "undefined") {
      return;
    }
    const observer = new ResizeObserver(() => setViewportHeight(el.clientHeight));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // 뷰포트 높이를 아직 못 쟀으면(0) 첫 페인트용으로 넉넉히 잡는다
  const height = viewportHeight > 0 ? viewportHeight : 600;
  const first = Math.max(0, Math.floor(scrollTop / LINE_HEIGHT) - OVERSCAN_LINES);
  const last = Math.min(
    lines.length,
    Math.ceil((scrollTop + height) / LINE_HEIGHT) + OVERSCAN_LINES,
  );
  const visible = lines.slice(first, last);

  return (
    <div className="diff virt" ref={scrollRef} onScroll={onScroll}>
      <div className="diff-spacer" style={{ height: lines.length * LINE_HEIGHT }}>
        <div className="diff-window" style={{ top: first * LINE_HEIGHT }}>
          {visible.map((line, i) => (
            <Line key={first + i} line={line} />
          ))}
        </div>
      </div>
    </div>
  );
}
