import type { FileStatus } from "../types";

const DATE_FORMAT = new Intl.DateTimeFormat(undefined, {
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

/** unix seconds -> "2026. 09. 01. 14:03" 형태 (로케일 의존) */
export function formatTimestamp(seconds: number): string {
  return DATE_FORMAT.format(new Date(seconds * 1000));
}

/** 툴바/상태바용 축약 sha (7자) */
export function shortSha(sha: string): string {
  return sha.slice(0, 7);
}

export function formatCount(n: number): string {
  return n.toLocaleString();
}

/** "src/shell/App.tsx" -> { dir: "src/shell/", base: "App.tsx" } */
export function splitPath(path: string): { dir: string; base: string } {
  const idx = path.lastIndexOf("/");
  if (idx < 0) {
    return { dir: "", base: path };
  }
  return { dir: path.slice(0, idx + 1), base: path.slice(idx + 1) };
}

export function basename(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  return splitPath(trimmed).base || trimmed;
}

const STATUS_LABEL: Record<FileStatus, string> = {
  A: "Added",
  M: "Modified",
  D: "Deleted",
  R: "Renamed",
  C: "Copied",
  T: "Type changed",
};

export function statusLabel(status: FileStatus): string {
  return STATUS_LABEL[status] ?? status;
}
