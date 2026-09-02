// 문법 강조 유틸. highlight.js/lib/core에 필요한 언어만 등록해 번들을 줄인다.
// 가상 스크롤과 함께 쓰려고 "전체 1회 하이라이트 → 줄 단위 HTML 배열"로 잘라 준다.
import hljs from "highlight.js/lib/core";
import bash from "highlight.js/lib/languages/bash";
import c from "highlight.js/lib/languages/c";
import cpp from "highlight.js/lib/languages/cpp";
import csharp from "highlight.js/lib/languages/csharp";
import css from "highlight.js/lib/languages/css";
import diff from "highlight.js/lib/languages/diff";
import dockerfile from "highlight.js/lib/languages/dockerfile";
import go from "highlight.js/lib/languages/go";
import graphql from "highlight.js/lib/languages/graphql";
import ini from "highlight.js/lib/languages/ini";
import java from "highlight.js/lib/languages/java";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import kotlin from "highlight.js/lib/languages/kotlin";
import lua from "highlight.js/lib/languages/lua";
import makefile from "highlight.js/lib/languages/makefile";
import markdown from "highlight.js/lib/languages/markdown";
import php from "highlight.js/lib/languages/php";
import python from "highlight.js/lib/languages/python";
import ruby from "highlight.js/lib/languages/ruby";
import rust from "highlight.js/lib/languages/rust";
import scss from "highlight.js/lib/languages/scss";
import sql from "highlight.js/lib/languages/sql";
import swift from "highlight.js/lib/languages/swift";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";

/** 이 줄 수를 넘으면 하이라이트를 생략하고 plain으로 돌려준다 */
export const MAX_HIGHLIGHT_LINES = 5000;

let registered = false;

function register() {
  if (registered) {
    return;
  }
  registered = true;
  hljs.registerLanguage("bash", bash);
  hljs.registerLanguage("c", c);
  hljs.registerLanguage("cpp", cpp);
  hljs.registerLanguage("csharp", csharp);
  hljs.registerLanguage("css", css);
  hljs.registerLanguage("diff", diff);
  hljs.registerLanguage("dockerfile", dockerfile);
  hljs.registerLanguage("go", go);
  hljs.registerLanguage("graphql", graphql);
  hljs.registerLanguage("ini", ini);
  hljs.registerLanguage("java", java);
  hljs.registerLanguage("javascript", javascript);
  hljs.registerLanguage("json", json);
  hljs.registerLanguage("kotlin", kotlin);
  hljs.registerLanguage("lua", lua);
  hljs.registerLanguage("makefile", makefile);
  hljs.registerLanguage("markdown", markdown);
  hljs.registerLanguage("php", php);
  hljs.registerLanguage("python", python);
  hljs.registerLanguage("ruby", ruby);
  hljs.registerLanguage("rust", rust);
  hljs.registerLanguage("scss", scss);
  hljs.registerLanguage("sql", sql);
  hljs.registerLanguage("swift", swift);
  hljs.registerLanguage("typescript", typescript);
  hljs.registerLanguage("xml", xml);
  hljs.registerLanguage("yaml", yaml);
}

const BY_EXTENSION: Record<string, string> = {
  kt: "kotlin",
  kts: "kotlin",
  gradle: "kotlin",
  java: "java",
  ts: "typescript",
  tsx: "typescript",
  mts: "typescript",
  cts: "typescript",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  rs: "rust",
  json: "json",
  jsonc: "json",
  yml: "yaml",
  yaml: "yaml",
  md: "markdown",
  markdown: "markdown",
  mdx: "markdown",
  css: "css",
  scss: "scss",
  sass: "scss",
  less: "scss",
  html: "xml",
  htm: "xml",
  xml: "xml",
  svg: "xml",
  vue: "xml",
  plist: "xml",
  sh: "bash",
  bash: "bash",
  zsh: "bash",
  fish: "bash",
  py: "python",
  pyi: "python",
  go: "go",
  sql: "sql",
  swift: "swift",
  rb: "ruby",
  php: "php",
  c: "c",
  h: "c",
  cpp: "cpp",
  cc: "cpp",
  cxx: "cpp",
  hpp: "cpp",
  hh: "cpp",
  cs: "csharp",
  toml: "ini",
  ini: "ini",
  cfg: "ini",
  conf: "ini",
  properties: "ini",
  lua: "lua",
  graphql: "graphql",
  gql: "graphql",
  diff: "diff",
  patch: "diff",
};

const BY_FILENAME: Record<string, string> = {
  dockerfile: "dockerfile",
  makefile: "makefile",
  "cargo.lock": "ini",
  "gemfile": "ruby",
  "rakefile": "ruby",
};

/** 경로에서 hljs 언어 이름을 고른다. 모르면 null (plain 렌더) */
export function languageForPath(path: string): string | null {
  const base = (path.split("/").pop() ?? path).toLowerCase();
  const byName = BY_FILENAME[base];
  if (byName !== undefined) {
    return byName;
  }
  const dot = base.lastIndexOf(".");
  if (dot < 0) {
    return null;
  }
  return BY_EXTENSION[base.slice(dot + 1)] ?? null;
}

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * hljs 출력(중첩 span HTML)을 줄 단위로 자른다.
 * 줄 경계에서 열려 있는 span은 모두 닫고, 다음 줄 시작에서 같은 순서로 다시 연다.
 */
function splitHighlighted(html: string): string[] {
  const lines: string[] = [];
  const open: string[] = [];
  const pattern = /<span [^>]*>|<span>|<\/span>|\n/g;
  let current = "";
  let cursor = 0;
  let match = pattern.exec(html);

  while (match !== null) {
    current += html.slice(cursor, match.index);
    cursor = match.index + match[0].length;
    if (match[0] === "\n") {
      lines.push(current + "</span>".repeat(open.length));
      current = open.join("");
    } else if (match[0] === "</span>") {
      open.pop();
      current += match[0];
    } else {
      open.push(match[0]);
      current += match[0];
    }
    match = pattern.exec(html);
  }

  current += html.slice(cursor);
  lines.push(current + "</span>".repeat(open.length));
  return lines;
}

/**
 * text를 줄 단위 HTML 배열로 돌려준다 (innerHTML로 그대로 넣을 수 있게 이스케이프됨).
 * lang이 null이거나 등록되지 않았거나 줄 수가 MAX_HIGHLIGHT_LINES를 넘으면 plain.
 */
export function highlightLines(text: string, lang: string | null): string[] {
  const raw = text.replace(/\r\n/g, "\n").replace(/\n$/, "");
  const plain = () => raw.split("\n").map(escapeHtml);
  if (lang === null) {
    return plain();
  }
  register();
  if (hljs.getLanguage(lang) === undefined) {
    return plain();
  }
  // 큰 파일에서 hljs는 수백 ms를 먹는다. 줄 수로 먼저 걸러낸다
  let count = 1;
  for (let i = 0; i < raw.length; i++) {
    if (raw.charCodeAt(i) === 10) {
      count += 1;
      if (count > MAX_HIGHLIGHT_LINES) {
        return plain();
      }
    }
  }
  try {
    const html = hljs.highlight(raw, { language: lang, ignoreIllegals: true }).value;
    const lines = splitHighlighted(html);
    // 방어: 줄 수가 어긋나면 plain으로 (렌더가 줄 번호와 어긋나는 것보다 낫다)
    return lines.length === count ? lines : plain();
  } catch {
    return plain();
  }
}
