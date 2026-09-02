// 변경 파일 트리. 접기 상태와 키보드 포커스는 CommitDetailPanel이 소유하고(controlled),
// 여기서는 평면화된 행 목록을 그대로 렌더한다. 평면 목록이 키보드 탐색의 단일 진실이다.
import type { FileChange } from "../types";
import { FileRow } from "./FileRow";

interface TreeDir {
  kind: "dir";
  /** 압축된 표시 이름 ("a/b/c") */
  name: string;
  /** 루트부터의 전체 경로. 접기 상태 키로 쓴다 */
  path: string;
  children: TreeNode[];
  fileCount: number;
}

interface TreeFile {
  kind: "file";
  file: FileChange;
}

type TreeNode = TreeDir | TreeFile;

interface BuildDir {
  dirs: Map<string, BuildDir>;
  files: FileChange[];
}

/** 평면화된 트리 한 줄. 키보드 탐색 인덱스가 이 배열의 인덱스다 */
export type FileNavRow =
  | {
      kind: "dir";
      key: string;
      path: string;
      name: string;
      depth: number;
      fileCount: number;
      collapsed: boolean;
    }
  | { kind: "file"; key: string; depth: number; file: FileChange };

function emptyDir(): BuildDir {
  return { dirs: new Map(), files: [] };
}

/** 경로들을 트라이로 쌓은 뒤, 디렉토리 하나만 품은 체인을 "a/b/c"로 압축한다 */
function buildTree(files: FileChange[]): TreeNode[] {
  const root = emptyDir();
  for (const file of files) {
    const segments = file.path.split("/");
    let cursor = root;
    for (let i = 0; i < segments.length - 1; i++) {
      const segment = segments[i];
      let next = cursor.dirs.get(segment);
      if (next === undefined) {
        next = emptyDir();
        cursor.dirs.set(segment, next);
      }
      cursor = next;
    }
    cursor.files.push(file);
  }
  return convert(root, "").children;
}

function convert(dir: BuildDir, path: string): TreeDir {
  const children: TreeNode[] = [];
  let fileCount = dir.files.length;

  for (const [name, child] of dir.dirs) {
    const childPath = path === "" ? name : `${path}/${name}`;
    let node = convert(child, childPath);
    // 자식이 디렉토리 하나뿐이고 파일이 없으면 이름을 합쳐 한 줄로 접는다
    while (node.children.length === 1 && node.children[0].kind === "dir") {
      const only = node.children[0];
      node = { ...only, name: `${node.name}/${only.name}` };
    }
    fileCount += node.fileCount;
    children.push(node);
  }

  children.sort((a, b) => {
    if (a.kind !== b.kind) {
      return a.kind === "dir" ? -1 : 1;
    }
    if (a.kind === "dir" && b.kind === "dir") {
      return a.name.localeCompare(b.name);
    }
    if (a.kind === "file" && b.kind === "file") {
      return a.file.path.localeCompare(b.file.path);
    }
    return 0;
  });

  for (const file of dir.files) {
    children.push({ kind: "file", file });
  }

  return {
    kind: "dir",
    name: path.split("/").pop() ?? "",
    path,
    children,
    fileCount,
  };
}

/**
 * 트리를 화면에 보이는 순서대로 평면화한다.
 * 접힌 디렉토리의 자식은 아예 넣지 않으므로 렌더와 키보드 탐색 범위가 같다.
 */
export function buildFileNavRows(
  files: FileChange[],
  collapsed: ReadonlySet<string>,
): FileNavRow[] {
  const out: FileNavRow[] = [];

  const walk = (nodes: TreeNode[], depth: number) => {
    for (const node of nodes) {
      if (node.kind === "file") {
        out.push({ kind: "file", key: `f:${node.file.path}`, depth, file: node.file });
        continue;
      }
      const isCollapsed = collapsed.has(node.path);
      out.push({
        kind: "dir",
        key: `d:${node.path}`,
        path: node.path,
        name: node.name,
        depth,
        fileCount: node.fileCount,
        collapsed: isCollapsed,
      });
      if (!isCollapsed) {
        walk(node.children, depth + 1);
      }
    }
  };

  walk(buildTree(files), 0);
  return out;
}

/** Path|Tree 토글 상태. CommitDetailPanel과 WipDetailPanel이 같은 키를 공유한다 */
export type FileView = "path" | "tree";

export const FILE_VIEW_KEY = "gitlanes.fileView";

export function readFileView(): FileView {
  try {
    return localStorage.getItem(FILE_VIEW_KEY) === "tree" ? "tree" : "path";
  } catch {
    return "path";
  }
}

export function writeFileView(view: FileView) {
  try {
    localStorage.setItem(FILE_VIEW_KEY, view);
  } catch {
    // localStorage 실패는 무시 (설정만 휘발)
  }
}

export interface FileTreeProps {
  /** buildFileNavRows 결과 (접힌 디렉토리 자식은 빠져 있다) */
  rows: FileNavRow[];
  /** 키보드 포커스 행 인덱스. 없으면 -1 */
  focusIndex: number;
  /** 메인 영역 diff 뷰어에 열려 있는 파일 경로 */
  activePath?: string | null;
  onOpen: (file: FileChange, index: number) => void;
  onToggle: (path: string, index: number) => void;
}

export function FileTree({ rows, focusIndex, activePath, onOpen, onToggle }: FileTreeProps) {
  return (
    <ul className="file-list tree">
      {rows.map((row, index) =>
        row.kind === "file" ? (
          <FileRow
            key={row.key}
            file={row.file}
            depth={row.depth}
            nameOnly
            navIndex={index}
            focused={index === focusIndex}
            active={row.file.path === activePath}
            onOpen={() => onOpen(row.file, index)}
          />
        ) : (
          <li key={row.key}>
            <button
              className={index === focusIndex ? "tree-dir kb-focus" : "tree-dir"}
              style={{ paddingLeft: 4 + row.depth * 14 }}
              data-nav-index={index}
              tabIndex={-1}
              onClick={() => onToggle(row.path, index)}
              aria-expanded={!row.collapsed}
              title={row.path}
            >
              <span
                className={row.collapsed ? "sb-caret collapsed" : "sb-caret"}
                aria-hidden="true"
              >
                ▾
              </span>
              <span className="tree-dir-name">{row.name}</span>
              <span className="tree-dir-count">{row.fileCount}</span>
            </button>
          </li>
        ),
      )}
    </ul>
  );
}
