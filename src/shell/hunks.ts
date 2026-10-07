// unified diff 파서와 부분 패치 재구성기.
// hunk/줄 단위 스테이징이 여기에만 의존한다. 전부 순수 함수로 두고, 파일 맨 아래에
// 입출력 예시를 주석으로 남긴다.
// 검증: tests/patch-engine.test.mts (npm run test:patch). 실제 git에 Rust와 같은 인자로
// 적용한 결과를 바이트 단위로 본다. 이 파일을 고치면 반드시 돌린다.
//
// 입력은 파일 하나짜리 unified diff다 (get_wip_file_diff 응답).
// 여러 파일이 이어진 diff는 다루지 않는다. 두 번째 "diff --git" 줄부터는
// hunk 본문의 context로 잘못 읽히므로 호출 측이 파일별로 잘라 넣어야 한다.

export type DiffLineKind = "context" | "add" | "del" | "meta";

export interface DiffLine {
  kind: DiffLineKind;
  /**
   * context/add/del은 접두(공백, +, -)를 뗀 본문.
   * meta는 "\ No newline at end of file" 원문 그대로.
   */
  text: string;
}

export interface Hunk {
  /** "@@ -1,5 +1,7 @@ fn main()" 원문. 뒤에 붙는 섹션 이름까지 포함한다 */
  header: string;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: DiffLine[];
}

export interface ParsedDiff {
  /** 첫 "@@" 이전의 모든 줄 (diff --git, index, ---, +++, rename from 등) */
  fileHeader: string[];
  hunks: Hunk[];
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/** 선택 집합의 키. 줄은 (hunk 번호, hunk 안에서의 줄 번호)로만 식별된다 */
export function lineKey(hunkIndex: number, lineIndex: number): string {
  return `${hunkIndex}:${lineIndex}`;
}

export function parseUnifiedDiff(diff: string): ParsedDiff {
  const fileHeader: string[] = [];
  const hunks: Hunk[] = [];
  // "\n"으로만 나눈다. CRLF로 커밋된 파일의 "\r"은 줄 구분자가 아니라 줄 내용이라
  // 지우면 재구성한 패치가 실제 파일과 맞지 않는다 (core.autocrlf=true면 diff에 "\r"이 애초에 없다)
  const raw = diff.endsWith("\n") ? diff.slice(0, -1) : diff;
  if (raw === "") {
    return { fileHeader, hunks };
  }

  let current: Hunk | null = null;
  for (const line of raw.split("\n")) {
    const match = HUNK_RE.exec(line);
    if (match !== null) {
      current = {
        header: line,
        oldStart: Number(match[1]),
        oldLines: match[2] === undefined ? 1 : Number(match[2]),
        newStart: Number(match[3]),
        newLines: match[4] === undefined ? 1 : Number(match[4]),
        lines: [],
      };
      hunks.push(current);
      continue;
    }
    if (current === null) {
      fileHeader.push(line);
      continue;
    }
    if (line.startsWith("+")) {
      current.lines.push({ kind: "add", text: line.slice(1) });
    } else if (line.startsWith("-")) {
      current.lines.push({ kind: "del", text: line.slice(1) });
    } else if (line.startsWith("\\")) {
      current.lines.push({ kind: "meta", text: line });
    } else {
      // git은 context에 공백 접두를 붙이지만, 빈 줄을 ""로 흘리는 도구도 있다
      current.lines.push({ kind: "context", text: line.startsWith(" ") ? line.slice(1) : line });
    }
  }

  return { fileHeader, hunks };
}

/** 해당 hunk에 고를 수 있는 줄(+ 또는 -)이 하나라도 있는가 */
export function hunkHasChanges(hunk: Hunk): boolean {
  return hunk.lines.some((line) => line.kind === "add" || line.kind === "del");
}

/**
 * diff 원문이 손실 디코딩을 거쳤는가 (UTF-8이 아닌 바이트가 U+FFFD로 바뀌었는가).
 * Rust가 diff를 String::from_utf8_lossy로 넘기므로 EUC-KR, CP949, Latin-1 파일은 원래 바이트를 잃는다.
 * 그대로 패치를 만들면 깨진 바이트가 stage되므로 호출 측은 부분 패치를 막아야 한다 (audit-patch H4).
 * 파일에 원래 U+FFFD가 들어 있어도 true가 되지만, 막는 쪽으로 틀리므로 안전하다
 */
export function hasLossyDecoding(diff: string): boolean {
  return diff.includes("�");
}

/** hunk 안에서 선택된 +/- 줄 수 */
export function countSelectedInHunk(
  hunk: Hunk,
  hunkIndex: number,
  selected: ReadonlySet<string>,
): number {
  let count = 0;
  hunk.lines.forEach((line, index) => {
    if (line.kind === "meta" || line.kind === "context") {
      return;
    }
    if (selected.has(lineKey(hunkIndex, index))) {
      count += 1;
    }
  });
  return count;
}

/** 고를 수 있는 줄 전체를 선택 집합에 담는다 (hunk 전체 선택) */
export function selectWholeHunk(
  hunk: Hunk,
  hunkIndex: number,
  into: Set<string>,
): void {
  hunk.lines.forEach((line, index) => {
    if (line.kind === "add" || line.kind === "del") {
      into.add(lineKey(hunkIndex, index));
    }
  });
}

/**
 * 선택한 hunk들만 담은 최소 패치.
 * hunk 전체 선택은 줄 단위 선택의 특수한 경우라 buildLinePatch로 위임한다.
 */
export function buildPatch(
  parsed: ParsedDiff,
  hunkIndexes: number[],
  reverse: boolean,
): string {
  const selected = new Set<string>();
  for (const hunkIndex of hunkIndexes) {
    const hunk = parsed.hunks[hunkIndex];
    if (hunk === undefined) {
      continue;
    }
    selectWholeHunk(hunk, hunkIndex, selected);
  }
  return buildLinePatch(parsed, selected, reverse);
}

interface BuiltHunk {
  lines: string[];
  oldCount: number;
  newCount: number;
}

/** 재구성 중인 패치 한 줄 */
interface Emitted {
  sign: " " | "+" | "-";
  text: string;
  /** 이 줄 뒤에 "\ No newline at end of file"이 붙는가 */
  noEol: boolean;
  /** 마커 원문. git 버전에 따라 문구가 다를 수 있어 그대로 보존한다 */
  marker: string;
}

/**
 * 범위 표기의 start를 "범위 앞에 놓인 줄 수"(0-기준 위치)로 바꾼다.
 * git 표기에서 count가 0인 쪽의 start는 "이 줄 다음"이고, 1 이상이면 "이 줄부터"다.
 * 그래서 count가 0과 비0 사이를 오가면 start를 그대로 옮겨 쓸 수 없다 (audit-patch H1)
 */
function linesBefore(start: number, count: number): number {
  return count === 0 ? start : start - 1;
}

/** linesBefore의 역. 위치와 count로 git 표기의 "start,count"를 만든다 */
function formatRange(before: number, count: number): string {
  return `${count === 0 ? before : before + 1},${count}`;
}

function lastIndexWhere(body: Emitted[], test: (entry: Emitted) => boolean): number {
  for (let i = body.length - 1; i >= 0; i--) {
    if (test(body[i])) {
      return i;
    }
  }
  return -1;
}

/**
 * "\ No newline at end of file" 마커를 다시 배치한다.
 * 마커는 "앞 줄이 그 쪽 파일의 마지막 줄이고 개행이 없다"는 뜻이라, 부분 선택으로
 * 줄이 빠지고 나면 원래 자리에 그대로 두면 거짓이 된다.
 * 한쪽에서만 마지막 줄이 된 context는 개행 유무가 좌우로 달라지므로 -/+ 쌍으로 쪼갠다.
 */
function fixupNoEol(body: Emitted[]): Emitted[] {
  if (!body.some((entry) => entry.noEol)) {
    return body;
  }
  const lastOld = lastIndexWhere(body, (entry) => entry.sign !== "+");
  const lastNew = lastIndexWhere(body, (entry) => entry.sign !== "-");
  const out: Emitted[] = [];

  body.forEach((entry, index) => {
    if (!entry.noEol) {
      out.push(entry);
      return;
    }
    const endsOld = entry.sign !== "+" && index === lastOld;
    const endsNew = entry.sign !== "-" && index === lastNew;
    if (entry.sign === " " && endsOld !== endsNew) {
      // 개행이 생기거나 사라지는 쪽을 드러내야 git apply가 원문과 맞출 수 있다
      out.push({ sign: "-", text: entry.text, noEol: endsOld, marker: entry.marker });
      out.push({ sign: "+", text: entry.text, noEol: endsNew, marker: entry.marker });
      return;
    }
    out.push({ ...entry, noEol: endsOld || endsNew });
  });

  return out;
}

/**
 * hunk 하나를 선택 상태에 맞춰 다시 쓴다. 고를 게 하나도 없으면 null.
 * offset은 앞서 패치에 담긴 hunk들이 만든 줄 수 변화의 누적값이다.
 */
function buildHunk(
  hunk: Hunk,
  hunkIndex: number,
  selected: ReadonlySet<string>,
  reverse: boolean,
  offset: number,
): BuiltHunk | null {
  if (countSelectedInHunk(hunk, hunkIndex, selected) === 0) {
    return null;
  }

  const raw: Emitted[] = [];
  /** 직전 원본 줄이 패치에 남았으면 그 위치. 빠진 줄에 마커만 남으면 패치가 깨진다 */
  let previousIndex = -1;

  const emit = (sign: " " | "+" | "-", text: string) => {
    raw.push({ sign, text, noEol: false, marker: "" });
    previousIndex = raw.length - 1;
  };

  for (let index = 0; index < hunk.lines.length; index++) {
    const line = hunk.lines[index];

    if (line.kind === "meta") {
      if (previousIndex >= 0) {
        raw[previousIndex].noEol = true;
        raw[previousIndex].marker = line.text;
      }
      continue;
    }

    if (line.kind === "context") {
      emit(" ", line.text);
      continue;
    }

    const picked = selected.has(lineKey(hunkIndex, index));

    if (line.kind === "add") {
      if (picked) {
        emit("+", line.text);
      } else if (reverse) {
        // 되돌릴 대상 파일(new 쪽)에는 이 줄이 실제로 있으므로 context로 남겨 둔다
        emit(" ", line.text);
      } else {
        previousIndex = -1;
      }
      continue;
    }

    if (picked) {
      emit("-", line.text);
    } else if (!reverse) {
      // 적용 대상 파일(old 쪽)에는 이 줄이 실제로 있으므로 context로 남겨 둔다
      emit(" ", line.text);
    } else {
      previousIndex = -1;
    }
  }

  const body = fixupNoEol(raw);
  const lines: string[] = [];
  let oldCount = 0;
  let newCount = 0;

  for (const entry of body) {
    lines.push(entry.sign + entry.text);
    if (entry.noEol) {
      lines.push(entry.marker);
    }
    if (entry.sign !== "+") {
      oldCount += 1;
    }
    if (entry.sign !== "-") {
      newCount += 1;
    }
  }

  // 패치가 실제로 붙는 쪽(정방향은 old, 역방향은 new)의 위치는 원본 그대로 써야 한다.
  // 반대쪽만 앞선 hunk들이 만든 줄 수 변화를 반영해 다시 센다.
  // 위치는 0-기준으로 옮기고 출력할 때만 count에 맞춰 git 표기로 바꾼다
  const anchorBefore = reverse
    ? linesBefore(hunk.newStart, hunk.newLines)
    : linesBefore(hunk.oldStart, hunk.oldLines);
  const oldBefore = reverse ? anchorBefore - offset : anchorBefore;
  const newBefore = reverse ? anchorBefore : anchorBefore + offset;
  const section = hunk.header.replace(HUNK_RE, "");
  const header = `@@ -${formatRange(oldBefore, oldCount)} +${formatRange(newBefore, newCount)} @@${section}`;

  return { lines: [header, ...lines], oldCount, newCount };
}

/**
 * 선택한 줄만 담은 패치.
 * 정방향(스테이지): 안 고른 +는 빼고, 안 고른 -는 context로 바꾼다.
 * 역방향(언스테이지/되돌리기, git apply --reverse에 넣는다):
 *   안 고른 -를 빼고, 안 고른 +를 context로 바꾼다.
 * 고른 줄이 없으면 빈 문자열을 돌려준다. 호출 측이 막아야 한다.
 */
export function buildLinePatch(
  parsed: ParsedDiff,
  selected: ReadonlySet<string>,
  reverse: boolean,
): string {
  const out: string[] = [];
  let offset = 0;

  for (let hunkIndex = 0; hunkIndex < parsed.hunks.length; hunkIndex++) {
    const built = buildHunk(parsed.hunks[hunkIndex], hunkIndex, selected, reverse, offset);
    if (built === null) {
      continue;
    }
    out.push(...built.lines);
    offset += built.newCount - built.oldCount;
  }

  if (out.length === 0) {
    return "";
  }
  const header = partialFileHeader(parsed.fileHeader, reverse, coversWholeFile(parsed, selected));
  // git apply는 마지막 줄도 개행으로 끝나야 받아들인다
  return [...header, ...out].join("\n") + "\n";
}

/** 모든 hunk의 모든 변경 줄을 골랐는가. 고른 결과가 파일 단위 동작과 같아지는 경우다 */
function coversWholeFile(parsed: ParsedDiff, selected: ReadonlySet<string>): boolean {
  return parsed.hunks.every((hunk, hunkIndex) =>
    hunk.lines.every(
      (line, index) =>
        (line.kind !== "add" && line.kind !== "del") || selected.has(lineKey(hunkIndex, index)),
    ),
  );
}

/** "--- a/경로" / "+++ b/경로"의 경로 부분. 따옴표로 감싼 경로("a/q\"x")도 접두만 바꾼다 */
function swapPrefix(path: string, from: "a/" | "b/", to: "a/" | "b/"): string {
  if (path.startsWith(`"${from}`)) {
    return `"${to}${path.slice(from.length + 1)}`;
  }
  if (path.startsWith(from)) {
    return to + path.slice(from.length);
  }
  return path;
}

/**
 * 부분 패치에 붙일 파일 헤더. 원본 헤더를 그대로 복사하면 두 경우에 git apply가 거절하거나 과하게 적용한다.
 *
 * 1. new/deleted 헤더 (audit-patch M1). git apply 2.50으로 실험한 결과:
 *    - 정방향 "deleted file" + 일부 줄: "deleted file f.txt still has contents"로 거절
 *    - 역방향 "new file" + 일부 줄: "new file f.txt depends on old contents"로 거절
 *    - 정방향 "new file" + 일부 줄(새 파일의 일부만 stage), 역방향 "deleted file" + 일부 줄
 *      (삭제의 일부만 되살림)은 고른 줄만 담은 파일 생성이라 그대로 맞다
 *    거절되는 두 경우는 결과 쪽 파일이 여전히 존재하므로 일반 수정 패치가 맞다.
 *    "new file mode"/"deleted file mode" 줄을 빼고 /dev/null 자리에 반대쪽 경로를 넣으면 적용된다.
 *    모드는 대상(인덱스나 워킹트리)의 기존 모드를 그대로 따르는 것도 확인했다(100755 새 파일 부분 unstage 후 100755).
 *    "index" 줄의 해시는 파일 전체 기준이라 부분 패치와 맞지 않아 같이 뺀다(git apply는 --3way가 아니면 쓰지 않는다).
 *    모든 변경 줄을 고르면 파일 단위 동작(인덱스에서 제거, 삭제 stage)과 같아야 하므로 원본 헤더를 둔다.
 * 2. "old mode"/"new mode" (audit-patch L1). 남기면 hunk 하나만 stage해도 chmod까지 stage된다.
 *    모드 변경은 파일 단위 stage에서만 다루므로(git add -p가 모드를 따로 묻는 것과 같은 이유) 늘 뺀다.
 *    빼면 git apply는 대상의 현재 모드를 유지한다.
 * 3. rename 헤더 (audit-patch M2 후속). staged diff는 원 경로를 pathspec에 함께 넣어 rename으로 나온다
 *    (commands.rs get_wip_file_diff). git apply 2.50으로 실험한 결과:
 *    - 역방향 rename 헤더 + 일부 줄: 고른 줄과 함께 rename까지 되돌린다(--cached면 "MD old.txt"가 되고
 *      new.txt가 인덱스에서 빠진다). 사용자는 줄만 내렸는데 파일 이동이 풀린다
 *    - 헤더를 "diff --git a/<새경로> b/<새경로>", "--- a/<새경로>", "+++ b/<새경로>"로 바꾸고
 *      "similarity index", "rename from/to", "index" 줄을 빼면 rename은 남고 고른 줄만 내려간다.
 *      워킹트리 대상(discard)도 같다
 *    - 정방향 rename 헤더 + 일부 줄: rename과 고른 줄만 stage된다. 같은 재작성은 "new.txt: does not exist
 *      in index"로 거절된다(적용 대상 쪽에 새 경로가 아직 없다). new file 정방향 부분 stage와 같은 이유로 그대로 둔다.
 *      앱의 unstaged diff에는 rename이 나오지 않으므로 방어용이다
 *    모든 변경 줄을 고른 역방향은 rename까지 되돌린다. 파일 단위 unstage(원 경로까지 인덱스로 되돌리는
 *    ops/stage.rs with_rename_sources)와 같은 결과라 원본 헤더를 둔다.
 *    copy 헤더는 오지 않는다. diff에 -C가 없고 staged_renames도 R만 짝짓는다.
 */
function partialFileHeader(fileHeader: string[], reverse: boolean, wholeFile: boolean): string[] {
  const header = fileHeader.filter((line) => !line.startsWith("old mode ") && !line.startsWith("new mode "));
  if (reverse && !wholeFile && header.some((line) => line.startsWith("rename from "))) {
    return renameToModification(header);
  }
  const isNew = header.some((line) => line.startsWith("new file mode "));
  const isDeleted = header.some((line) => line.startsWith("deleted file mode "));
  // 정방향은 new 쪽, 역방향은 old 쪽이 결과가 된다. 그 쪽이 /dev/null인데 내용이 남는 경우만 고친다
  const toModification = !wholeFile && ((isNew && reverse) || (isDeleted && !reverse));
  if (!toModification) {
    return header;
  }
  const oldPath = header.find((line) => line.startsWith("--- "))?.slice(4);
  const newPath = header.find((line) => line.startsWith("+++ "))?.slice(4);
  return header
    .filter(
      (line) =>
        !line.startsWith("new file mode ") && !line.startsWith("deleted file mode ") && !line.startsWith("index "),
    )
    .map((line) => {
      if (line === "--- /dev/null" && newPath !== undefined) {
        return `--- ${swapPrefix(newPath, "b/", "a/")}`;
      }
      if (line === "+++ /dev/null" && oldPath !== undefined) {
        return `+++ ${swapPrefix(oldPath, "a/", "b/")}`;
      }
      return line;
    });
}

/** rename 헤더를 새 경로끼리의 일반 수정 헤더로 바꾼다. 근거는 partialFileHeader 주석 3번 */
function renameToModification(header: string[]): string[] {
  const newPath = header.find((line) => line.startsWith("+++ "))?.slice(4);
  if (newPath === undefined) {
    return header;
  }
  const oldSide = swapPrefix(newPath, "b/", "a/");
  return header
    .filter(
      (line) =>
        !line.startsWith("similarity index ") &&
        !line.startsWith("dissimilarity index ") &&
        !line.startsWith("rename from ") &&
        !line.startsWith("rename to ") &&
        !line.startsWith("index "),
    )
    .map((line) => {
      if (line.startsWith("diff --git ")) {
        // 공백이 든 경로는 ---/+++ 끝에 탭이 붙는다. diff --git 줄에는 탭이 없다
        return `diff --git ${oldSide.replace(/\t$/, "")} ${newPath.replace(/\t$/, "")}`;
      }
      if (line.startsWith("--- ")) {
        return `--- ${oldSide}`;
      }
      return line;
    });
}

// ── 입출력 예시 ──────────────────────────────────────────────
//
// 원본 diff (unstaged):
//   diff --git a/app.ts b/app.ts
//   index 1111111..2222222 100644
//   --- a/app.ts
//   +++ b/app.ts
//   @@ -1,4 +1,5 @@
//    const a = 1;
//   -const b = 2;
//   +const b = 20;
//   +const c = 3;
//    const d = 4;
//    const e = 5;
//
// parseUnifiedDiff → fileHeader 4줄, hunks[0] = {
//   oldStart: 1, oldLines: 4, newStart: 1, newLines: 5,
//   lines: [0 context "const a = 1;", 1 del "const b = 2;",
//           2 add "const b = 20;", 3 add "const c = 3;",
//           4 context "const d = 4;", 5 context "const e = 5;"] }
//
// (1) buildPatch(parsed, [0], false): hunk 전체를 스테이지
//   헤더는 원본과 같고 본문도 그대로다.
//   @@ -1,4 +1,5 @@
//    const a = 1;
//   -const b = 2;
//   +const b = 20;
//   +const c = 3;
//    const d = 4;
//    const e = 5;
//   → applyPatch(patch, cached = true, reverse = false)
//
// (2) buildLinePatch(parsed, new Set(["0:3"]), false)
//     "const c = 3;" 한 줄만 스테이지.
//     안 고른 del(0:1)은 context로 바뀌고, 안 고른 add(0:2)는 빠진다.
//     old 쪽은 4줄 그대로, new 쪽은 context 4 + add 1 = 5줄.
//   @@ -1,4 +1,5 @@
//    const a = 1;
//    const b = 2;
//   +const c = 3;
//    const d = 4;
//    const e = 5;
//
// (3) buildPatch(parsedStaged, [0], true): staged hunk를 언스테이지
//   패치는 정방향으로 만들고 방향은 호출 측이 준다.
//   → applyPatch(patch, cached = true, reverse = true)
//   줄 단위라면 안 고른 -가 빠지고 안 고른 +가 context가 된다.
//
// (4) hunk 두 개 중 뒤엣것만 고른 경우의 헤더 재계산
//   원본: "@@ -10,3 +10,4 @@" (add 1개) 와 "@@ -30,3 +31,3 @@"
//   뒤엣것만 정방향으로 고르면 앞 hunk가 패치에 없어 offset이 0이므로
//   결과 헤더는 "@@ -30,3 +30,3 @@" 가 된다 (new 쪽이 1줄 당겨진다).
//
// (5) "\ No newline at end of file"
//   주석은 바로 앞 줄에 붙는다. 그 줄이 패치에서 빠지면 주석도 빼고,
//   뒤에 다른 줄이 더 나가면 주석은 마지막 줄로 옮겨 붙는다.
