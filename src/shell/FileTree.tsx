import { useMemo, useState } from "react";
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

export interface FileTreeProps {
  files: FileChange[];
  onOpen: (file: FileChange) => void;
}

export function FileTree({ files, onOpen }: FileTreeProps) {
  // 파일 수백 개짜리 커밋에서도 렌더마다 다시 만들지 않는다
  const tree = useMemo(() => buildTree(files), [files]);
  // 기본은 전부 펼침. 접힌 경로만 담는다
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set<string>());

  const toggle = (path: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
  };

  return (
    <ul className="file-list tree">
      <TreeLevel nodes={tree} depth={0} collapsed={collapsed} onToggle={toggle} onOpen={onOpen} />
    </ul>
  );
}

interface TreeLevelProps {
  nodes: TreeNode[];
  depth: number;
  collapsed: ReadonlySet<string>;
  onToggle: (path: string) => void;
  onOpen: (file: FileChange) => void;
}

function TreeLevel({ nodes, depth, collapsed, onToggle, onOpen }: TreeLevelProps) {
  return (
    <>
      {nodes.map((node) => {
        if (node.kind === "file") {
          return (
            <FileRow
              key={node.file.path}
              file={node.file}
              depth={depth}
              nameOnly
              onOpen={() => onOpen(node.file)}
            />
          );
        }
        const isCollapsed = collapsed.has(node.path);
        return (
          <li key={node.path}>
            <button
              className="tree-dir"
              style={{ paddingLeft: 4 + depth * 12 }}
              onClick={() => onToggle(node.path)}
              aria-expanded={!isCollapsed}
              title={node.path}
            >
              <span className={isCollapsed ? "sb-caret collapsed" : "sb-caret"} aria-hidden="true">
                ▾
              </span>
              <span className="tree-dir-name">{node.name}</span>
              <span className="tree-dir-count">{node.fileCount}</span>
            </button>
            {/* 접힌 노드는 아예 렌더하지 않는다 */}
            {!isCollapsed && (
              <ul className="file-list">
                <TreeLevel
                  nodes={node.children}
                  depth={depth + 1}
                  collapsed={collapsed}
                  onToggle={onToggle}
                  onOpen={onOpen}
                />
              </ul>
            )}
          </li>
        );
      })}
    </>
  );
}
