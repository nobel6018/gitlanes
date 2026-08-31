import { useMemo } from "react";

type DiffLineKind = "add" | "del" | "hunk" | "meta" | "context";

interface DiffLine {
  kind: DiffLineKind;
  text: string;
}

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
  return raw.split("\n").map((text) => ({ kind: classify(text), text }));
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

  return (
    <div className="diff">
      {lines.map((line, i) => (
        <div key={i} className={`diff-line ${line.kind}`}>
          {line.text === "" ? " " : line.text}
        </div>
      ))}
    </div>
  );
}
