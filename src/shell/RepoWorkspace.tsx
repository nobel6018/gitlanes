// 탭 하나의 작업 공간. 레포/그래프/선택/검색/사이드바 상태를 전부 여기서 들고 있다.
// App은 이 컴포넌트를 탭마다 하나씩 마운트해두고 활성 탭만 보여준다.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import { GraphView } from "../graph";
import { COMMITS_PER_PAGE, WIP_SHA } from "../constants";
import type {
  ConflictFile,
  FileChange,
  RebaseStep,
  GraphData,
  RefEntry,
  RemoteInfo,
  RepoInfo,
  RepoState,
  SearchMatch,
  SyncState,
  WipArea,
  WipDetails,
  WipInfo,
  WorktreeInfo,
} from "../types";
import {
  errorMessage,
  getConflicts,
  getFileContent,
  getLastCommitMessage,
  getFileDiff,
  getRemoteUrl,
  getSyncState,
  getWipDetails,
  getWipFileContent,
  getWipFileDiff,
  getRepoState,
  listRefs,
  listRemotes,
  listWorktrees,
  loadGraph,
  openRepo,
  revealPath,
  searchCommits,
  termWrite,
} from "./api";
import { formatCommand, useRepoActions } from "./actions";
import type { ConfirmSpec, RepoActions, ToastSpec } from "./actions";
import { copyText } from "./clipboard";
import { BranchSidebar } from "./BranchSidebar";
import { CommitDetailPanel } from "./CommitDetailPanel";
import {
  AddWorktreeDialog,
  CreateBranchDialog,
  CreateTagDialog,
  MergeOptionsDialog,
  RebaseOptionsDialog,
  RemoteDialog,
  RenameBranchDialog,
  ResetBranchDialog,
  SetUpstreamDialog,
  StashDialog,
  refNameProblem,
} from "./ActionDialogs";
import { ConflictPanel } from "./ConflictPanel";
import { ContextMenu } from "./ContextMenu";
import type { MenuItem } from "./ContextMenu";
import { ConfirmDialog, PromptDialog } from "./Dialogs";
import { DiffPanel } from "./DiffPanel";
import { RebaseEditor } from "./RebaseEditor";
import { parseRefDrag } from "./dnd";
import type { RefDragPayload } from "./dnd";
import type { SidebarDialogKind, SidebarDialogTarget } from "./SidebarContextMenu";
import { Terminal } from "./Terminal";
import { WipDetailPanel } from "./WipDetailPanel";
import { FilterResults } from "./FilterResults";
import { QuickSwitcher } from "./QuickSwitcher";
import {
  DEFAULT_LAYOUT,
  DEFAULT_TERM_HEIGHT,
  DETAIL_MIN,
  detailMax,
  readLayout,
  readTermHeight,
  SIDEBAR_MAX,
  SIDEBAR_MIN,
  TERM_MIN,
  termMax,
  writeLayout,
  writeTermHeight,
} from "./layout";
import type { LayoutWidths } from "./layout";
import type { PrefValues } from "./Preferences";
import { SearchBox } from "./SearchBox";
import { SplitHandle } from "./SplitHandle";
import { ToastStack } from "./Toast";
import type { ToastItem } from "./Toast";
import { Toolbar } from "./Toolbar";
import { WelcomeScreen } from "./WelcomeScreen";
import { useRecentRepos } from "./useRecentRepos";
import { APP_VERSION } from "./version";
import { basename, formatCount, shortSha } from "./format";

const SIDEBAR_KEY = "gitlanes.sidebar";

const EMPTY_GRAPH: GraphData = {
  rows: [],
  totalLoaded: 0,
  hasMore: false,
  laneCount: 0,
  wip: null,
  graphToken: "",
  stashes: [],
};

/** load_graph 요청 한 건. skip>0이면 응답 rows를 기존 rows 뒤에 붙인다 */
interface PageRequest {
  skip: number;
  limit: number;
}

const FIRST_PAGE: PageRequest = { skip: 0, limit: COMMITS_PER_PAGE };

/** 자동 새로고침 폴링 간격(ms) */
const POLL_INTERVAL_MS = 5000;
/** search_commits가 돌려줄 최대 매치 수 (계약 상한) */
const GLOBAL_SEARCH_LIMIT = 500;

/**
 * 5초 폴링이 매번 새 객체를 돌려주므로, 내용이 같으면 상태를 갈지 않는다.
 * 안 그러면 아무 일이 없어도 워크스페이스 전체가 5초마다 다시 그려진다.
 */
function sameSync(a: SyncState | null, b: SyncState | null): boolean {
  if (a === null || b === null) {
    return a === b;
  }
  if (
    a.branch !== b.branch ||
    a.upstream !== b.upstream ||
    a.ahead !== b.ahead ||
    a.behind !== b.behind ||
    a.stashCount !== b.stashCount
  ) {
    return false;
  }
  const p = a.pending;
  const q = b.pending;
  if (p === null || q === null) {
    return p === q;
  }
  return (
    p.kind === q.kind &&
    p.progress === q.progress &&
    p.conflictCount === q.conflictCount &&
    p.detail === q.detail
  );
}

/** 충돌 목록도 같은 이유로 내용 비교를 한다 */
function sameConflicts(a: ConflictFile[], b: ConflictFile[]): boolean {
  if (a.length !== b.length) {
    return false;
  }
  return a.every((file, i) => {
    const other = b[i];
    return (
      file.path === other.path &&
      file.kind === other.kind &&
      file.hasMarkers === other.hasMarkers
    );
  });
}

/**
 * WIP 행의 모양(파일 수 배지)이 같은가.
 * untrackedFiles는 v0.18 이전 rust가 안 채웠을 수 있어 없으면 0으로 본다
 */
function sameWip(a: WipInfo | null, b: WipInfo | null): boolean {
  if (a === null || b === null) {
    return a === b;
  }
  return (
    a.changedFiles === b.changedFiles &&
    a.stagedFiles === b.stagedFiles &&
    (a.untrackedFiles ?? 0) === (b.untrackedFiles ?? 0)
  );
}

/**
 * 내용 지문(v0.15.1). 파일 수가 같아도 편집이 있었는지 가린다.
 * rust가 아직 필드를 안 채운 빌드에서는 undefined가 오므로 null로 접어 비교한다
 * (둘 다 없으면 "같음"이라 지금까지와 동작이 같다)
 */
function wipContentToken(wip: WipInfo | null): string | null {
  return wip?.contentToken ?? null;
}

/** 배지와 내용 지문까지 같으면 data.wip을 바꿀 이유가 없다 (GraphView의 의사 행 재계산을 피한다) */
function sameWipInfo(a: WipInfo | null, b: WipInfo | null): boolean {
  return sameWip(a, b) && wipContentToken(a) === wipContentToken(b);
}

/** fileTextCache 키 중 워킹 트리 파일(WIP 행)의 접두. 커밋 sha 키는 내용이 바뀔 수 없다 */
const WIP_TEXT_PREFIX = `${WIP_SHA}\u0000`;

function readFlag(key: string, fallback: boolean): boolean {
  try {
    const raw = localStorage.getItem(key);
    if (raw === null) {
      return fallback;
    }
    return raw !== "0";
  } catch {
    return fallback;
  }
}

function writeFlag(key: string, value: boolean): void {
  try {
    localStorage.setItem(key, value ? "1" : "0");
  } catch {
    // localStorage 실패는 무시 (설정만 휘발)
  }
}

/** 한 번에 쌓아 둘 토스트 수. 넘치면 오래된 것부터 밀어낸다 */
const MAX_TOASTS = 4;

/**
 * 같은 Repository 명령을 다시 받기까지의 최소 간격(ms).
 * 네이티브 메뉴와 웹뷰 keydown이 같은 조합을 물고 있어 중복 실행을 막는다
 */
const REPO_COMMAND_DEBOUNCE_MS = 400;

/** PTY 세션이 열리기를 기다리는 시간(ms). 넘으면 클립보드로 넘어간다 */
const TERM_SESSION_WAIT_MS = 3000;

/** 세션이 열린 직후 프롬프트가 그려질 틈(ms). 너무 이르면 첫 글자가 먹힌다 */
const TERM_WRITE_DELAY_MS = 120;

/**
 * 예전 showError 호출부(그래프 로드 실패, 클립보드 실패 등)가 쓰는 수명.
 * v0.18 Toast는 durationMs를 생략하면 error를 자동으로 지우지 않는데, 이런 짧은
 * 안내까지 수동으로 닫게 하면 성가시다. git stderr를 실은 쓰기 실패만 남긴다
 */
const NOTICE_ERROR_MS = 8000;

/** 확인 다이얼로그 한 건. resolve로 사용자의 선택을 액션 계층에 돌려준다 */
interface PendingConfirm {
  spec: ConfirmSpec;
  resolve: (ok: boolean) => void;
}

/**
 * 열려 있는 입력 다이얼로그. 실제 폼은 전부 ui-actions의 ActionDialogs가 그리고,
 * 셸은 어떤 걸 어떤 대상으로 열지만 정한다.
 */
type DialogState =
  | { kind: "createBranch"; startPoint: string | null }
  | { kind: "renameBranch"; branch: string }
  | { kind: "createTag"; target: string | null }
  | { kind: "reset"; target: string }
  | { kind: "merge"; source: string }
  | { kind: "rebase"; upstream: string }
  | { kind: "setUpstream"; branch: string }
  | { kind: "remote"; remote: { name: string; url: string } | null }
  | { kind: "addWorktree" }
  | { kind: "stash" }
  | { kind: "stashBranch"; ref: string };

/** 인터랙티브 리베이스 에디터의 입력. steps 참조가 바뀌면 에디터가 편집 상태를 버린다 */
interface RebaseState {
  base: string;
  steps: RebaseStep[];
}

/**
 * Repository 메뉴와 웹뷰 단축키가 올리는 카운터.
 * App이 탭별로 세기 때문에 탭 전환만으로는 값이 바뀌지 않는다.
 */
export interface RepoCommandNonces {
  fetch: number;
  pull: number;
  push: number;
  commit: number;
  newBranch: number;
  stash: number;
  stashPop: number;
}

export const NO_REPO_COMMANDS: RepoCommandNonces = {
  fetch: 0,
  pull: 0,
  push: 0,
  commit: 0,
  newBranch: 0,
  stash: 0,
  stashPop: 0,
};

/** 가장 최근 스태시. Pop/Apply 단축키의 기본 대상 */
const TOP_STASH = "stash@{0}";

/** nonce가 바뀔 때마다 GraphView가 해당 행을 뷰포트 중앙으로 스크롤한다 */
interface ScrollTarget {
  sha: string;
  nonce: number;
}

export interface RepoWorkspaceProps {
  /** 마운트 시 자동으로 열 레포 경로. null이면 웰컴 화면 */
  initialPath: string | null;
  /** 활성 탭인가. 폴링과 ⌘F는 활성 탭에서만 동작한다 */
  active: boolean;
  /** 레포를 연 뒤 탭 라벨/영속화를 위해 App에 알린다 */
  onRepoOpened: (path: string, name: string) => void;
  /** 다른 탭이 이미 그 레포를 열었으면 App이 그 탭을 활성화하고 true를 준다 */
  requestOpen: (path: string) => boolean;
  /** 앱 전역 업데이트 확인 상태 (App 소유) */
  update: WorkspaceUpdateProps;
  /** 활성 탭에만 내려오는 업데이트 배너. 툴바 바로 아래에 놓는다 */
  banner: ReactNode;
  /**
   * 메뉴 명령 카운터. 이 탭에 대해 값이 올라갈 때만 실행한다.
   * App이 탭별로 따로 세기 때문에 탭 전환만으로는 바뀌지 않는다.
   */
  openDialogNonce: number;
  refreshNonce: number;
  /** ⌘B(View > Toggle Sidebar). 활성 탭에만 올라온다 */
  toggleSidebarNonce: number;
  /** ⌃`(View > Toggle Terminal). 활성 탭에만 올라온다 */
  toggleTerminalNonce: number;
  /** ⌘W를 터미널 포커스에서 눌렀을 때. 토글이 아니라 닫기 */
  closeTerminalNonce: number;
  /** Repository 메뉴(menu:fetch 등)의 탭별 카운터. 활성 탭에만 올라온다 */
  repoCommands: RepoCommandNonces;
  /** 전역 설정 (App 소유, Preferences로 조절) */
  prefs: PrefValues;
  /** 그래프 로드/새로고침 중인지 App에 알린다 (탭 스피너용) */
  onLoadingChange?: (loading: boolean) => void;
}

export interface WorkspaceUpdateProps {
  /** 새 버전 태그. 없으면 null */
  tag: string | null;
  checking: boolean;
  onCheck: () => void;
  onOpenRelease: () => void;
}

/** 우클릭 메뉴 위치와 대상. 커밋 행과 툴바 레포명이 같은 ContextMenu를 쓴다 */
type MenuState =
  | { kind: "commit"; sha: string; x: number; y: number }
  | { kind: "repo"; x: number; y: number };

/**
 * 메인 영역 뷰어가 펼친 파일. area가 null이면 커밋 파일,
 * 값이 있으면 워킹 트리(WIP) 파일이다
 */
interface OpenFile {
  file: FileChange;
  area: WipArea | null;
}

/** 입력창(xterm의 textarea 포함)에 포커스가 있는가 */
function textFieldFocused(): boolean {
  const el = document.activeElement;
  if (el === null) {
    return false;
  }
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    return true;
  }
  return el instanceof HTMLElement && el.isContentEditable;
}

/** 입력창에 포커스가 있거나 텍스트가 선택돼 있으면 브라우저 기본 복사를 방해하지 않는다 */
function typingOrSelecting(): boolean {
  const selection = window.getSelection()?.toString() ?? "";
  if (selection !== "") {
    return true;
  }
  return textFieldFocused();
}

/**
 * 컨텍스트 메뉴(그래프/사이드바/탭)나 모달 오버레이(치트시트/퀵 스위처)가 열려 있는가.
 * 오버레이는 포커스가 자기 안에 있으면 Esc를 직접 먹지만, 포커스를 잃었을 때는
 * 이 판정이 셸의 다음 Esc 단계를 막아준다 (한 번에 하나만).
 */
function anyOverlayOpen(): boolean {
  return document.querySelector('[role="menu"], .ov-backdrop') !== null;
}

export function RepoWorkspace({
  initialPath,
  active,
  onRepoOpened,
  requestOpen,
  update,
  banner,
  openDialogNonce,
  refreshNonce,
  toggleSidebarNonce,
  toggleTerminalNonce,
  closeTerminalNonce,
  repoCommands,
  prefs,
  onLoadingChange,
}: RepoWorkspaceProps) {
  const [repo, setRepo] = useState<RepoInfo | null>(null);
  const [graph, setGraph] = useState<GraphData | null>(null);
  const [refs, setRefs] = useState<RefEntry[]>([]);
  const [refsLoading, setRefsLoading] = useState(false);
  const [page, setPage] = useState<PageRequest>(FIRST_PAGE);
  const [reloadKey, setReloadKey] = useState(0);
  /** 쓰기가 끝날 때마다 오른다. graphToken과 무관한 사이드바 목록(remote, 워크트리)을 다시 읽는다 */
  const [writeNonce, setWriteNonce] = useState(0);
  const [graphLoading, setGraphLoading] = useState(false);
  const [opening, setOpening] = useState(false);
  const [selectedSha, setSelectedSha] = useState<string | null>(null);
  const [scrollTarget, setScrollTarget] = useState<ScrollTarget | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState<boolean>(() => readFlag(SIDEBAR_KEY, true));
  const [query, setQuery] = useState("");
  const [matchIndex, setMatchIndex] = useState(0);
  const [searching, setSearching] = useState(false);
  const [searchExhausted, setSearchExhausted] = useState(false);
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const [remoteUrl, setRemoteUrl] = useState<string | null>(null);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [layout, setLayout] = useState<LayoutWidths>(readLayout);
  /** 하단 내장 터미널. 기본 접힘 (세션은 열린 뒤 탭이 살아있는 동안 유지된다) */
  const [terminalOpen, setTerminalOpen] = useState(false);
  const [termHeight, setTermHeight] = useState<number>(readTermHeight);

  /** 검색 필터 모드. 켜지면 그래프 자리에 매치 목록만 그린다 */
  const [filterMode, setFilterMode] = useState(false);
  const [quickOpen, setQuickOpen] = useState(false);
  /** 메인 영역에 펼친 파일. null이면 그래프(또는 필터 목록)를 보여준다 */
  const [openFile, setOpenFile] = useState<OpenFile | null>(null);
  const [wipDetails, setWipDetails] = useState<WipDetails | null>(null);
  const [wipLoading, setWipLoading] = useState(false);
  /** wip 요약이 바뀔 때마다 오른다. WIP 상세와 열린 WIP diff를 다시 읽는 트리거 */
  const [wipNonce, setWipNonce] = useState(0);
  const [diffText, setDiffText] = useState<string | null>(null);
  const [fileText, setFileText] = useState<string | null>(null);
  const [diffLoading, setDiffLoading] = useState(false);
  const [diffError, setDiffError] = useState<string | null>(null);

  // ── v0.18 쓰기 상태 ───────────────────────────────────────
  /** ahead/behind, stash 수, 진행 중인 머지/리베이스. 폴링과 refreshAll이 갱신한다 */
  const [syncState, setSyncState] = useState<SyncState | null>(null);
  /** 진행 중인 작업의 충돌 파일. pending이 없으면 항상 빈 배열 */
  const [conflicts, setConflicts] = useState<ConflictFile[]>([]);
  const [remotes, setRemotes] = useState<RemoteInfo[]>([]);
  const [worktrees, setWorktrees] = useState<WorktreeInfo[]>([]);
  const [pendingConfirm, setPendingConfirm] = useState<PendingConfirm | null>(null);
  const [dialog, setDialog] = useState<DialogState | null>(null);
  /**
   * 리베이스 에디터 입력. useState에 담아 두면 참조가 렌더마다 바뀌지 않아
   * 사용자가 드래그로 맞춰 놓은 순서가 리렌더에 날아가지 않는다
   */
  const [rebase, setRebase] = useState<RebaseState | null>(null);
  /** 드래그가 올라와 있는 커밋 행. 그래프가 노란 테두리로 그린다 */
  const [dropTargetSha, setDropTargetSha] = useState<string | null>(null);

  const { recents, addRecent, removeRecent } = useRecentRepos();
  const toastSeq = useRef(0);
  const graphReq = useRef(0);
  const graphToken = useRef("");
  const refsReq = useRef(0);
  const scrollSeq = useRef(0);
  const initialOpened = useRef(false);
  const lastOpenNonce = useRef(0);
  const lastRefreshNonce = useRef(0);
  const lastSidebarNonce = useRef(0);
  const lastTerminalNonce = useRef(0);
  const lastCloseTerminalNonce = useRef(0);
  /** 드래그 중 높이는 이 엘리먼트에 직접 쓴다 (리렌더 없음) */
  const dockRef = useRef<HTMLDivElement | null>(null);

  const activeRef = useRef(active);
  const lastQuery = useRef("");
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  /** ⌘⌥F로 사이드바 브랜치 필터 입력창을 포커스한다 */
  const sidebarFilterRef = useRef<HTMLInputElement | null>(null);
  /** 드래그 중에는 이 엘리먼트의 CSS 변수만 갱신한다 (리렌더 없음) */
  const mainRef = useRef<HTMLDivElement | null>(null);
  /** "sha\0path" -> 파일 전문. File View를 오갈 때 재요청하지 않는다 */
  const fileTextCache = useRef(new Map<string, string>());
  /** 진행 중인 파일 전문 요청 키. 같은 파일을 두 번 부르지 않는다 */
  const fileTextReq = useRef<string | null>(null);
  /** query -> search_commits 결과. Enter 연타에 재호출하지 않는다 */
  const searchCache = useRef(new Map<string, SearchMatch[]>());
  /** append 완료 후 점프할 sha */
  const pendingJump = useRef<string | null>(null);
  const rowCount = useRef(0);
  const loadingRef = useRef(false);
  const wipRef = useRef<WipInfo | null>(null);
  /** 콜백 안에서 최신 레포를 읽는다 (refreshAll의 의존성을 레포에 묶지 않기 위함) */
  const repoRef = useRef<RepoInfo | null>(null);
  /** 하단 터미널의 PTY 세션 id (Terminal의 onSession). 없으면 null */
  const termSessionRef = useRef<string | null>(null);
  /**
   * 세션이 열리기 전에 눌린 "Run in terminal" 명령.
   * 터미널을 한 번도 연 적이 없으면 term_open이 끝나기 전에 클릭이 들어오므로,
   * 여기 담아 뒀다가 세션이 올라오는 순간 흘려보낸다
   */
  const pendingTermCommand = useRef<string | null>(null);
  /** 세션을 기다리다 포기하고 클립보드로 넘어가는 타이머 */
  const termWaitTimer = useRef<number | null>(null);
  /** 진행 중인 sync/conflict 요청 번호. 늦게 온 응답을 버린다 */
  const syncReq = useRef(0);
  /** 진행 중인 get_repo_state 요청 번호. 쓰기 뒤 새로고침과 폴링이 함께 쓴다 */
  const stateReq = useRef(0);
  /**
   * 그래프 요청과 상태 요청이 공유하는 시작 순번. 늦게 시작한 쪽의 wip이 더 새 것이다.
   * 그래프 로드가 날아가는 사이 상태 요청이 새 wip을 반영했다면, 그 뒤에 도착한 그래프의
   * 낡은 wip이 덮어쓰지 않게 비교하는 기준이다
   */
  const ioSeq = useRef(0);
  /** 마지막으로 반영한 get_repo_state의 wip과 그 요청의 시작 순번 */
  const stateWip = useRef<{ seq: number; wip: WipInfo | null } | null>(null);
  /**
   * 큐에 들어간 쓰기 수. useRepoActions가 동기로 올리고 내린다.
   * actions.busy는 렌더를 거쳐야 바뀌어서, 쓰기 IPC가 나간 직후의 폴링 틱을 놓칠 수 있다
   */
  const writingRef = useRef(0);
  /** Repository 메뉴 카운터의 직전 값 */
  const lastRepoCommands = useRef<RepoCommandNonces>(NO_REPO_COMMANDS);
  /**
   * 마지막으로 반영한 WIP 내용 지문. 그래프를 다시 읽지 않고 diff만 새로 읽는 경로가 있어
   * 그래프의 wip(wipRef)과 따로 들고 있어야 같은 변화를 매 폴링마다 다시 잡지 않는다
   */
  const contentTokenRef = useRef<string | null>(null);
  /** 콜백(단축키, 메뉴, openPath)에서 최신 모달 상태를 읽는다 */
  const pendingConfirmRef = useRef<PendingConfirm | null>(null);
  const dialogRef = useRef<DialogState | null>(null);
  const rebaseRef = useRef<RebaseState | null>(null);

  const data: GraphData = graph ?? EMPTY_GRAPH;
  repoRef.current = repo;
  activeRef.current = active;
  rowCount.current = data.rows.length;
  loadingRef.current = graphLoading;
  wipRef.current = data.wip;
  pendingConfirmRef.current = pendingConfirm;
  dialogRef.current = dialog;
  rebaseRef.current = rebase;

  /**
   * 인증 핸드오프 핸들러를 토스트마다 붙여 준다.
   * runInTerminal은 아래에서 정의되지만 콜백 안에서만 쓰이므로 ref로 지연 참조한다
   */
  const runInTerminalRef = useRef<(command: string[], repoPath?: string) => void>(
    () => undefined,
  );

  /**
   * 액션 계층이 주는 ToastSpec을 스택에 쌓는다.
   * repoPath는 작업을 시작한 레포다. 토스트가 만들어지는 시점에 고정해 핸들러에 묶어 둔다.
   * 오류 토스트는 사용자가 닫을 때까지 남으므로, 그 사이 탭이 다른 레포로 바뀌어도
   * "Run in terminal"은 원래 레포에서 돌아야 한다 (audit-state H1)
   */
  const pushToast = useCallback((spec: ToastSpec, repoPath?: string) => {
    toastSeq.current += 1;
    const id = toastSeq.current;
    const origin = repoPath ?? repoRef.current?.path;
    const item: ToastItem = {
      id,
      ...spec,
      // 표시 문구와 실제 실행이 같은 formatCommand를 거쳐야 화면이 거짓말을 하지 않는다
      commandLine:
        spec.command !== undefined && spec.command.length > 0 && origin !== undefined
          ? formatCommand(spec.command, origin)
          : undefined,
      onRunInTerminal: (command) => runInTerminalRef.current(command, origin),
    };
    setToasts((prev) => [...prev.slice(-(MAX_TOASTS - 1)), item]);
  }, []);

  const showToast = useCallback(
    (
      message: string,
      tone: "error" | "info" | "success",
      options?: { durationMs?: number; copyable?: boolean },
    ) => {
      pushToast({ message, tone, ...options });
    },
    [pushToast],
  );

  const showError = useCallback(
    (message: string) => {
      pushToast({ message, tone: "error", durationMs: NOTICE_ERROR_MS, copyable: true });
    },
    [pushToast],
  );

  const dismissToast = useCallback((id: number) => {
    setToasts((prev) => prev.filter((item) => item.id !== id));
  }, []);

  /**
   * 동기화 상태와 충돌 목록을 한 번에 읽는다.
   * 5초 폴링과 refreshAll이 같은 경로를 쓴다. 요청 번호로 늦게 온 응답을 버린다.
   */
  const loadSyncData = useCallback(async (path: string) => {
    const reqId = syncReq.current + 1;
    syncReq.current = reqId;
    try {
      const state = await getSyncState(path);
      if (syncReq.current !== reqId) {
        return;
      }
      setSyncState((prev) => (sameSync(prev, state) ? prev : state));
      if (state.pending === null) {
        setConflicts((prev) => (prev.length === 0 ? prev : []));
        return;
      }
      const files = await getConflicts(path);
      if (syncReq.current === reqId) {
        setConflicts((prev) => (sameConflicts(prev, files) ? prev : files));
      }
    } catch {
      // rust가 아직 이 command를 안 들고 있거나(하네스) 일시적 실패다.
      // 그래프 자체는 멀쩡하므로 조용히 넘긴다
    }
  }, []);


  // 레포/페이지 요청/새로고침 키가 바뀌면 load_graph를 부른다.
  // skip=0은 교체, skip>0은 append. graphReq로 뒤늦게 도착한 이전 요청 응답을 버린다.
  useEffect(() => {
    if (repo === null) {
      setGraph(null);
      graphToken.current = "";
      return;
    }
    const reqId = graphReq.current + 1;
    graphReq.current = reqId;
    ioSeq.current += 1;
    const seq = ioSeq.current;
    setGraphLoading(true);
    loadGraph(repo.path, page.limit, page.skip)
      .then((fetched) => {
        if (graphReq.current !== reqId) {
          return;
        }
        // 이 요청보다 늦게 시작한 get_repo_state가 이미 wip을 반영했으면 그쪽이 더 새 것이다
        const newer = stateWip.current;
        const loaded =
          newer !== null && newer.seq > seq ? { ...fetched, wip: newer.wip } : fetched;
        if (page.skip === 0) {
          graphToken.current = loaded.graphToken;
          contentTokenRef.current = wipContentToken(loaded.wip);
          setGraph(loaded);
          return;
        }
        if (loaded.graphToken !== graphToken.current) {
          // 페이징 도중 레포 상태가 바뀌었다. 누적분을 버리고 처음부터 다시 읽는다
          setPage({ skip: 0, limit: page.limit });
          return;
        }
        setGraph((prev) => ({
          ...loaded,
          rows: prev === null ? loaded.rows : [...prev.rows, ...loaded.rows],
        }));
      })
      .catch((err: unknown) => {
        if (graphReq.current === reqId) {
          showError(errorMessage(err));
        }
      })
      .finally(() => {
        if (graphReq.current === reqId) {
          setGraphLoading(false);
        }
      });
  }, [repo, page, reloadKey, showError]);

  // 사이드바 refs는 로드된 커밋 범위와 무관하므로 limit 변화에는 다시 부르지 않는다
  useEffect(() => {
    if (repo === null) {
      setRefs([]);
      return;
    }
    const reqId = refsReq.current + 1;
    refsReq.current = reqId;
    setRefsLoading(true);
    listRefs(repo.path)
      .then((loaded) => {
        if (refsReq.current === reqId) {
          setRefs(loaded);
        }
      })
      .catch((err: unknown) => {
        if (refsReq.current === reqId) {
          showError(errorMessage(err));
        }
      })
      .finally(() => {
        if (refsReq.current === reqId) {
          setRefsLoading(false);
        }
      });
  }, [repo, reloadKey, showError]);

  const openPath = useCallback(
    async (path: string) => {
      // 이미 다른 탭에서 연 레포면 그 탭으로 넘긴다
      if (requestOpen(path)) {
        return;
      }
      setOpening(true);
      try {
        const info = await openRepo(path);
        const previous = repoRef.current;
        if (previous !== null && previous.path !== info.path) {
          // 같은 탭이 다른 레포로 바뀐다. 이전 레포를 향해 떠 있던 확인창, 입력 다이얼로그,
          // 리베이스 에디터를 그대로 두면 새 레포 화면에서 확정되어 엉뚱한 레포에 쓴다
          // (audit-state M5). 확인창은 거절로 끝내 run이 조용히 돌아가게 한다
          pendingConfirmRef.current?.resolve(false);
          pendingConfirmRef.current = null;
          setPendingConfirm(null);
          setDialog(null);
          setRebase(null);
          // 이전 레포의 동기화 응답이 늦게 와도 버리도록 요청 번호를 올린다
          syncReq.current += 1;
          setSyncState(null);
          setConflicts([]);
          contentTokenRef.current = null;
        }
        addRecent(info.path);
        setSelectedSha(null);
        setScrollTarget(null);
        setQuery("");
        lastQuery.current = "";
        setSearchExhausted(false);
        searchCache.current.clear();
        fileTextCache.current.clear();
        // 이전 레포를 향한 get_repo_state 응답이 늦게 와도 버린다
        stateReq.current += 1;
        stateWip.current = null;
        setOpenFile(null);
        pendingJump.current = null;
        setGraph(null);
        setRefs([]);
        setPage(FIRST_PAGE);
        graphToken.current = "";
        setMenu(null);
        setRemoteUrl(null);
        setRepo(info);
        onRepoOpened(info.path, info.name);
        getRemoteUrl(info.path)
          .then((url) => setRemoteUrl(url))
          .catch(() => setRemoteUrl(null));
      } catch (err) {
        showError(errorMessage(err));
      } finally {
        setOpening(false);
      }
    },
    [addRecent, showError, requestOpen, onRepoOpened],
  );

  const handleBrowse = useCallback(async () => {
    try {
      const picked = await openDialog({ directory: true, multiple: false });
      if (typeof picked === "string") {
        await openPath(picked);
      }
    } catch (err) {
      showError(errorMessage(err));
    }
  }, [openPath, showError]);

  // 탭에 배정된 레포를 마운트 시 1회 연다. ref 가드로 StrictMode 이중 실행에도 안전
  useEffect(() => {
    if (initialOpened.current || initialPath === null) {
      return;
    }
    initialOpened.current = true;
    void openPath(initialPath);
  }, [initialPath, openPath]);

  // 비활성 탭도 자기 로딩을 탭 바에 알린다
  useEffect(() => {
    onLoadingChange?.(graphLoading);
  }, [graphLoading, onLoadingChange]);

  // 사이드바 Remotes/Worktrees 섹션.
  // remote 추가나 워크트리 생성은 graphToken을 바꾸지 않는다. 그래프를 다시 읽지 않는 쓰기도
  // 바로 보이도록 reloadKey와 별도로 writeNonce(쓰기마다 오른다)에도 다시 읽는다
  useEffect(() => {
    if (repo === null) {
      setRemotes([]);
      setWorktrees([]);
      return;
    }
    const path = repo.path;
    listRemotes(path)
      .then(setRemotes)
      .catch(() => setRemotes([]));
    listWorktrees(path)
      .then(setWorktrees)
      .catch(() => setWorktrees([]));
  }, [repo, reloadKey, writeNonce]);

  // 동기화 배지의 초기 데이터. 그 뒤로는 refreshAll, 폴링, 수동 Refresh가 직접 부른다
  useEffect(() => {
    if (repo === null) {
      setSyncState(null);
      setConflicts([]);
      return;
    }
    void loadSyncData(repo.path);
  }, [repo, loadSyncData]);


  /** 선택 + 해당 행을 뷰포트 중앙으로 스크롤 */
  const jumpTo = useCallback((sha: string) => {
    scrollSeq.current += 1;
    setSelectedSha(sha);
    setScrollTarget({ sha, nonce: scrollSeq.current });
  }, []);

  const loadedShas = useMemo(() => new Set(data.rows.map((row) => row.sha)), [data.rows]);

  const handleSelectRef = useCallback(
    (sha: string) => {
      if (loadedShas.has(sha)) {
        jumpTo(sha);
        return;
      }
      showError("커밋이 로드 범위 밖입니다. 더 불러오세요.");
    },
    [loadedShas, jumpTo, showError],
  );

  // 검색: subject / author / shortSha 대소문자 무시 부분일치
  const matches = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (needle === "") {
      return [];
    }
    const found: string[] = [];
    for (const row of data.rows) {
      if (
        row.subject.toLowerCase().includes(needle) ||
        row.author.toLowerCase().includes(needle) ||
        row.shortSha.toLowerCase().includes(needle)
      ) {
        found.push(row.sha);
      }
    }
    return found;
  }, [data.rows, query]);

  // 질의어가 바뀐 순간에만 첫 매치로 점프한다.
  // (더 보기/새로고침으로 rows만 바뀔 때 현재 매치를 잃지 않게)
  useEffect(() => {
    if (lastQuery.current === query) {
      return;
    }
    lastQuery.current = query;
    setMatchIndex(0);
    setSearchExhausted(false);
    if (matches.length > 0) {
      jumpTo(matches[0]);
    }
  }, [query, matches, jumpTo]);

  // append가 끝나 목표 sha가 로드되면 그때 점프한다
  useEffect(() => {
    const sha = pendingJump.current;
    if (sha === null || !loadedShas.has(sha)) {
      return;
    }
    pendingJump.current = null;
    const index = matches.indexOf(sha);
    if (index >= 0) {
      setMatchIndex(index);
    }
    jumpTo(sha);
  }, [loadedShas, matches, jumpTo]);

  const gotoMatch = useCallback(
    (index: number) => {
      if (matches.length === 0) {
        return;
      }
      const next = ((index % matches.length) + matches.length) % matches.length;
      setMatchIndex(next);
      jumpTo(matches[next]);
    },
    [matches, jumpTo],
  );

  /** 로컬 매치를 다 쓴 뒤 전체 히스토리에서 다음 매치를 찾아 그 지점까지 append 확장한다 */
  const expandToGlobalMatch = useCallback(async () => {
    if (repo === null) {
      return;
    }
    const needle = query.trim();
    if (needle === "") {
      return;
    }

    let found = searchCache.current.get(needle);
    if (found === undefined) {
      setSearching(true);
      try {
        found = await searchCommits(repo.path, needle, GLOBAL_SEARCH_LIMIT);
        searchCache.current.set(needle, found);
      } catch (err) {
        showError(errorMessage(err));
        return;
      } finally {
        setSearching(false);
      }
    }

    const loaded = rowCount.current;
    const next = found.find((match) => match.index >= loaded);
    if (next === undefined) {
      // 전체에도 더 없다. 첫 매치로 순환한다
      setSearchExhausted(true);
      gotoMatch(0);
      return;
    }

    pendingJump.current = next.sha;
    setPage({ skip: loaded, limit: next.index + COMMITS_PER_PAGE });
  }, [repo, query, gotoMatch, showError]);

  const handleNextMatch = useCallback(() => {
    if (query.trim() === "") {
      return;
    }
    const atEnd = matches.length === 0 || matchIndex + 1 >= matches.length;
    if (!atEnd) {
      gotoMatch(matchIndex + 1);
      return;
    }
    if (data.hasMore && !graphLoading && !searching) {
      void expandToGlobalMatch();
      return;
    }
    setSearchExhausted(true);
    gotoMatch(0);
  }, [
    query,
    matches.length,
    matchIndex,
    gotoMatch,
    data.hasMore,
    graphLoading,
    searching,
    expandToGlobalMatch,
  ]);
  const handlePrevMatch = useCallback(() => gotoMatch(matchIndex - 1), [gotoMatch, matchIndex]);

  const handleClearSearch = useCallback(() => {
    setQuery("");
    setMatchIndex(0);
    setSearchExhausted(false);
    pendingJump.current = null;
  }, []);

  // ⌘F / Ctrl+F로 검색창 포커스
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!activeRef.current) {
        return;
      }
      if (event.shiftKey || event.altKey) {
        return;
      }
      if ((event.metaKey || event.ctrlKey) && event.code === "KeyF") {
        event.preventDefault();
        const input = searchInputRef.current;
        if (input !== null) {
          input.focus();
          input.select();
        }
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const handleLoadMore = useCallback(() => {
    if (graphLoading || !data.hasMore) {
      return;
    }
    const skip = data.rows.length;
    setPage({ skip, limit: skip + COMMITS_PER_PAGE });
  }, [graphLoading, data.hasMore, data.rows.length]);

  // 새로고침은 언제나 skip=0 전체 리로드. 지금까지 불러온 깊이는 유지한다.
  // 수동 Refresh와 자동 새로고침이 같은 경로를 쓴다
  const reloadFromStart = useCallback(() => {
    setPage({ skip: 0, limit: Math.max(COMMITS_PER_PAGE, rowCount.current) });
    setReloadKey((k) => k + 1);
  }, []);

  /** 툴바 Refresh와 ⌘R. 그래프와 함께 sync 배지도 다시 읽는다 */
  const manualRefresh = useCallback(() => {
    reloadFromStart();
    const current = repoRef.current;
    if (current !== null) {
      void loadSyncData(current.path);
    }
  }, [reloadFromStart, loadSyncData]);

  // ════════════════════════════════════════════════════════
  // v0.18 쓰기 액션 배선
  // ════════════════════════════════════════════════════════

  /**
   * 워킹 트리 파일의 전문 캐시만 버린다. 커밋 sha로 읽은 전문은 내용이 바뀔 수 없어
   * 커밋, checkout, 리베이스 뒤에도 그대로 맞으므로 남겨 둔다
   */
  const dropWipFileText = useCallback(() => {
    for (const key of fileTextCache.current.keys()) {
      if (key.startsWith(WIP_TEXT_PREFIX)) {
        fileTextCache.current.delete(key);
      }
    }
  }, []);

  /**
   * get_repo_state 하나로 그래프를 다시 읽을지 정한다 (CONTRACTS v0.15.2 4번).
   * graphToken이 바뀌었으면 그래프와 refs를 처음부터 다시 읽고, 같으면 행 배열은 그대로 두고
   * data.wip만 바꾼다. 행 참조가 그대로라 GraphView가 레인 레이아웃을 다시 계산하지 않는다.
   * contentChanged는 WIP 내용이 바뀌었는지(폴링이 WIP 상세를 다시 읽을지 정한다),
   * reloaded는 그래프 전체 리로드를 걸었는지다.
   * afterWrite가 아니면(폴링) 응답이 왔을 때 쓰기가 진행 중이면 버린다. 쓰기 도중의 중간 상태라
   * 곧 쓰기 뒤 새로고침이 덮어쓴다
   */
  const syncRepoState = useCallback(
    async (
      path: string,
      afterWrite: boolean,
    ): Promise<{ contentChanged: boolean; reloaded: boolean }> => {
      const none = { contentChanged: false, reloaded: false };
      const reqId = stateReq.current + 1;
      stateReq.current = reqId;
      ioSeq.current += 1;
      const seq = ioSeq.current;
      let state: RepoState;
      try {
        state = await getRepoState(path);
      } catch {
        if (afterWrite && stateReq.current === reqId && repoRef.current?.path === path) {
          // 지문을 못 읽었으니 무엇이 바뀌었는지 모른다. 예전처럼 전부 다시 읽는다
          searchCache.current.clear();
          reloadFromStart();
          return { contentChanged: true, reloaded: true };
        }
        // 폴링 실패는 조용히 넘긴다. 다음 주기에 다시 시도한다
        return none;
      }
      if (stateReq.current !== reqId || repoRef.current?.path !== path) {
        return none;
      }
      if (!afterWrite && writingRef.current > 0) {
        return none;
      }
      const token = wipContentToken(state.wip);
      const contentChanged = token !== contentTokenRef.current || !sameWip(state.wip, wipRef.current);
      contentTokenRef.current = token;
      stateWip.current = { seq, wip: state.wip };
      if (state.graphToken !== graphToken.current) {
        // 커밋 위치와 인덱스가 달라진 검색 결과는 쓸 수 없다
        searchCache.current.clear();
        reloadFromStart();
        return { contentChanged, reloaded: true };
      }
      setGraph((prev) =>
        prev === null || sameWipInfo(prev.wip, state.wip) ? prev : { ...prev, wip: state.wip },
      );
      return { contentChanged, reloaded: false };
    },
    [reloadFromStart],
  );

  /**
   * 쓰기 직후 새로고침. 폴링(5초)을 기다리지 않는다.
   * get_repo_state로 그래프를 다시 읽을지 정하고(syncRepoState), WIP 상세, 열린 WIP diff,
   * sync, conflicts는 무엇이 바뀌었든 항상 다시 읽는다.
   * 그래프와 refs, WIP 상세는 효과 기반이라 트리거만 걸고 await는 지문과 sync까지만 기다린다
   */
  const refreshAll = useCallback(async () => {
    const current = repoRef.current;
    // 쓰기는 워킹 트리나 인덱스를 바꿨을 수 있다. 내용 지문이 같아 보여도 확인할 방법이
    // 다시 읽는 것뿐이라 WIP 쪽 전문 캐시는 항상 버린다. 커밋 쪽은 sha가 같으면 내용도 같다
    dropWipFileText();
    setWipNonce((n) => n + 1);
    if (current === null) {
      return;
    }
    const sync = loadSyncData(current.path);
    const { reloaded } = await syncRepoState(current.path, true);
    if (!reloaded) {
      // 그래프 리로드(reloadKey)가 걸렸으면 remote, 워크트리도 그쪽에서 이미 다시 읽는다
      setWriteNonce((n) => n + 1);
    }
    await sync;
  }, [dropWipFileText, syncRepoState, loadSyncData]);

  /**
   * 확인 다이얼로그를 띄우고 사용자의 선택을 Promise로 돌려준다.
   * 이미 하나 떠 있으면 새 요청은 즉시 거절한다 (쓰기는 직렬 큐라 실제로는 겹치지 않는다).
   */
  const confirmAction = useCallback((spec: ConfirmSpec): Promise<boolean> => {
    return new Promise<boolean>((resolve) => {
      setPendingConfirm((prev) => {
        if (prev !== null) {
          resolve(false);
          return prev;
        }
        return { spec, resolve };
      });
    });
  }, []);

  const settleConfirm = useCallback(
    (ok: boolean) => {
      pendingConfirm?.resolve(ok);
      setPendingConfirm(null);
    },
    [pendingConfirm],
  );

  /** 세션이 살아 있으면 즉시 써 넣는다. 성공하면 true */
  const writeToTerminal = useCallback(
    (line: string): boolean => {
      const id = termSessionRef.current;
      if (id === null) {
        return false;
      }
      // 쓰다 만 입력이 있으면 명령 앞에 붙어 실행된다. ^E로 줄 끝으로 간 뒤 ^U로
      // 줄을 지운다 (bash의 ^U는 커서 앞만 지우므로 ^E가 먼저 필요하다)
      termWrite(id, `\x05\x15${line}\n`).catch((err: unknown) => showError(errorMessage(err)));
      return true;
    },
    [showError],
  );

  /** PTY가 없는 환경(하네스 등)에서의 마지막 수단 */
  const fallbackToClipboard = useCallback(
    (line: string) => {
      void copyText(line).then((copied) => {
        showToast(
          copied
            ? "Command copied. Paste it into the terminal below and answer the prompt."
            : `Run this in the terminal below: ${line}`,
          "info",
          { durationMs: 10_000, copyable: true },
        );
      });
    },
    [showToast],
  );

  /**
   * 인증 핸드오프. 비대화식 git은 패스프레이즈를 물을 수 없으므로
   * 같은 명령을 내장 PTY에 그대로 넘겨 사용자가 자기 셸에서 답하게 한다.
   *
   * 터미널을 한 번도 연 적이 없으면 term_open이 아직 안 끝났다. 그 순간 클립보드로
   * 떨어지면 "버튼을 눌렀는데 아무 일도 안 일어난 것처럼" 보이므로, 세션을 잠깐 기다린다.
   */
  const runInTerminal = useCallback(
    (command: string[], repoPath?: string) => {
      // 토스트가 레포를 들고 오지 않은 경로(계약상 runInTerminal 직접 호출)는 지금 레포로 본다
      const target = repoPath ?? repoRef.current?.path;
      if (target === undefined) {
        return;
      }
      const line = formatCommand(command, target);
      setTerminalOpen(true);
      if (writeToTerminal(line)) {
        return;
      }
      pendingTermCommand.current = line;
      if (termWaitTimer.current !== null) {
        window.clearTimeout(termWaitTimer.current);
      }
      termWaitTimer.current = window.setTimeout(() => {
        termWaitTimer.current = null;
        const queued = pendingTermCommand.current;
        if (queued === null) {
          return;
        }
        pendingTermCommand.current = null;
        fallbackToClipboard(queued);
      }, TERM_SESSION_WAIT_MS);
    },
    [writeToTerminal, fallbackToClipboard],
  );

  runInTerminalRef.current = runInTerminal;

  /** Terminal이 세션 id를 올려주면 대기 중인 명령을 흘려보낸다 */
  const handleTermSession = useCallback(
    (id: string | null) => {
      termSessionRef.current = id;
      if (id === null || pendingTermCommand.current === null) {
        return;
      }
      const line = pendingTermCommand.current;
      pendingTermCommand.current = null;
      if (termWaitTimer.current !== null) {
        window.clearTimeout(termWaitTimer.current);
        termWaitTimer.current = null;
      }
      // 셸이 프롬프트를 그리기 전에 쓰면 첫 글자가 먹히는 경우가 있어 한 프레임 뒤에 보낸다
      window.setTimeout(() => {
        if (!writeToTerminal(line)) {
          fallbackToClipboard(line);
        }
      }, TERM_WRITE_DELAY_MS);
    },
    [writeToTerminal, fallbackToClipboard],
  );

  // 탭이 사라질 때 대기 타이머를 정리한다
  useEffect(() => {
    return () => {
      if (termWaitTimer.current !== null) {
        window.clearTimeout(termWaitTimer.current);
      }
    };
  }, []);

  /** 충돌이 생기면 WIP 패널을 열고 배너를 다시 펴준다 */
  const handleConflicts = useCallback((files: string[]) => {
    if (files.length === 0) {
      return;
    }
    setSelectedSha(WIP_SHA);
    setOpenFile(null);
  }, []);

  const actions: RepoActions = useRepoActions({
    repoPath: repo?.path ?? "",
    refreshAll,
    confirm: confirmAction,
    toast: pushToast,
    runInTerminal,
    onConflicts: handleConflicts,
    writing: writingRef,
  });

  /**
   * 충돌 패널에서 파일을 클릭했을 때. 충돌 중인 파일은 인덱스에 unmerged로 남아
   * unstaged diff로 보면 양쪽 변경과 마커가 그대로 보인다
   */
  const openConflictFile = useCallback((path: string) => {
    setSelectedSha(WIP_SHA);
    setOpenFile({
      file: { path, oldPath: null, status: "M", additions: 0, deletions: 0 },
      area: "unstaged",
    });
  }, []);

  /** 실패는 액션 계층이 이미 토스트로 알렸다. 여기서는 unhandled rejection만 막는다 */
  const fire = useCallback((pending: Promise<void>) => {
    pending.catch(() => undefined);
  }, []);

  /**
   * 같은 Repository 명령이 짧은 사이에 두 번 들어오면 뒤엣것을 버린다.
   * 네이티브 메뉴 accelerator와 웹뷰 keydown이 같은 조합에 걸려 있어, 플랫폼에 따라
   * 두 경로가 모두 살아날 수 있다. push가 두 번 나가는 것보다 한 번 무시하는 쪽이 낫다.
   */
  const lastCommandAt = useRef<Record<string, number>>({});

  /**
   * 확인창이나 다른 모달이 떠 있는가. 그 뒤에서 쓰기 단축키가 돌면 사용자가 보고 있는
   * 확인과 무관한 쓰기가 먼저 일어난다 (예: Reset --hard 확인 중 ⌘⇧O로 stash pop, audit-state M2).
   * DOM 판정(anyOverlayOpen)은 메뉴와 모달 백드롭을 보고, React 상태는 렌더 전 틈을 메운다
   */
  const modalOpen = useCallback((): boolean => {
    return (
      pendingConfirmRef.current !== null ||
      dialogRef.current !== null ||
      rebaseRef.current !== null ||
      anyOverlayOpen()
    );
  }, []);

  const runRepoCommand = useCallback((key: string, action: () => void) => {
    const now = Date.now();
    if (now - (lastCommandAt.current[key] ?? 0) < REPO_COMMAND_DEBOUNCE_MS) {
      return;
    }
    lastCommandAt.current[key] = now;
    action();
  }, []);

  const doFetch = useCallback(
    () => runRepoCommand("fetch", () => fire(actions.fetch())),
    [actions, fire, runRepoCommand],
  );
  const doPull = useCallback(
    () => runRepoCommand("pull", () => fire(actions.pull("merge"))),
    [actions, fire, runRepoCommand],
  );
  const doPush = useCallback(
    () => runRepoCommand("push", () => fire(actions.push())),
    [actions, fire, runRepoCommand],
  );
  const doStashPop = useCallback(
    () => runRepoCommand("stashPop", () => fire(actions.stashApply(TOP_STASH, true))),
    [actions, fire, runRepoCommand],
  );

  /**
   * ⌘Enter(Commit). 커밋 메시지는 CommitBox(ui-wip)가 들고 있어 여기서 바로 커밋할 수 없다.
   * WIP 행을 선택해 커밋 상자를 띄우는 데까지가 셸의 몫이고, 포커스까지 옮기지는 않는다.
   * 상자 안에서 누른 ⌘Enter는 CommitBox가 직접 처리하므로 여기로 오지 않는다.
   */
  const doCommit = useCallback(() => {
    setOpenFile(null);
    setSelectedSha(WIP_SHA);
  }, []);

  const closeDialog = useCallback(() => setDialog(null), []);

  const openNewBranchPrompt = useCallback((startPoint: string | null) => {
    setDialog({ kind: "createBranch", startPoint });
  }, []);

  const openNewTagPrompt = useCallback((target: string | null) => {
    setDialog({ kind: "createTag", target });
  }, []);

  const openStashPrompt = useCallback(() => setDialog({ kind: "stash" }), []);

  /**
   * 확인을 먼저 받고 액션을 부른다.
   * 액션 계층이 자체 확인을 가진 작업(force delete, stash drop 등)에는 쓰지 않는다.
   * 두 번 묻게 된다.
   */
  const confirmThen = useCallback(
    (spec: ConfirmSpec, action: () => Promise<void>) => {
      void confirmAction(spec).then((okToRun) => {
        if (okToRun) {
          fire(action());
        }
      });
    },
    [confirmAction, fire],
  );

  /** 태그 원격 작업의 기본 remote. 없으면 origin으로 둔다 */
  const defaultRemote = remotes[0]?.name ?? "origin";

  /**
   * 사이드바가 넘기는 입력/확인 요청. 파괴적인 것도 전부 여기로 와서
   * 확인 다이얼로그를 한 군데서만 띄운다 (ui-sidebar는 직접 띄우지 않는다).
   */
  const handleSidebarDialog = useCallback(
    (kind: SidebarDialogKind, target: SidebarDialogTarget) => {
      switch (kind) {
        case "createBranch":
          setDialog({ kind: "createBranch", startPoint: target });
          return;
        case "createTag":
          setDialog({ kind: "createTag", target });
          return;
        case "renameBranch":
          if (target !== null) {
            setDialog({ kind: "renameBranch", branch: target });
          }
          return;
        case "setUpstream":
          if (target !== null) {
            setDialog({ kind: "setUpstream", branch: target });
          }
          return;
        case "deleteBranch":
          // 병합되지 않은 커밋이 있으면 git이 스스로 거부하므로 force는 쓰지 않는다.
          // 그래도 되돌리는 방법은 보여준다
          if (target !== null) {
            confirmThen(
              {
                title: "Delete branch?",
                body: "The branch label is removed. Git refuses if it still holds commits that are not merged anywhere else.",
                undo: "Recreate it with git branch <name> <sha>. The tip stays in git reflog for about 90 days.",
                scope: target,
                confirmLabel: "Delete",
                danger: false,
              },
              () => actions.deleteBranch(target, false, false),
            );
          }
          return;
        case "deleteRemoteBranch":
          // 액션 계층이 확인을 가지고 있다
          if (target !== null) {
            fire(actions.deleteBranch(target, false, true));
          }
          return;
        case "deleteTag":
          if (target !== null) {
            fire(actions.deleteTag(target));
          }
          return;
        case "deleteTagOnRemote":
          if (target !== null) {
            fire(actions.pushTag(defaultRemote, target, true));
          }
          return;
        case "stashPush":
          setDialog({ kind: "stash" });
          return;
        case "stashDrop":
          if (target !== null) {
            fire(actions.stashDrop(target));
          }
          return;
        case "stashBranch":
          if (target !== null) {
            setDialog({ kind: "stashBranch", ref: target });
          }
          return;
        case "addRemote":
          setDialog({ kind: "remote", remote: null });
          return;
        case "editRemoteUrl":
        case "renameRemote": {
          const remote = remotes.find((entry) => entry.name === target);
          if (remote !== undefined) {
            setDialog({ kind: "remote", remote: { name: remote.name, url: remote.fetchUrl } });
          }
          return;
        }
        case "removeRemote":
          if (target !== null) {
            confirmThen(
              {
                title: "Remove remote?",
                body: "The remote and its tracking branches are removed from this repository. Nothing is deleted on the server.",
                undo: `Add it back with git remote add ${target} <url>, then fetch.`,
                scope: target,
                confirmLabel: "Remove",
                danger: false,
              },
              () => actions.removeRemote(target),
            );
          }
          return;
        case "addWorktree":
          setDialog({ kind: "addWorktree" });
          return;
        case "removeWorktree":
          if (target !== null) {
            fire(actions.removeWorktree(target, false));
          }
          return;
        default:
      }
    },
    [actions, fire, confirmThen, remotes, defaultRemote],
  );

  /** 네이티브 폴더 선택. AddWorktreeDialog가 콜백으로만 받는다 */
  const pickDirectory = useCallback(async (): Promise<string | null> => {
    try {
      const picked = await openDialog({ directory: true, multiple: false });
      return typeof picked === "string" ? picked : null;
    } catch (err) {
      showError(errorMessage(err));
      return null;
    }
  }, [showError]);

  /**
   * "Interactive rebase from here". 클릭한 커밋이 base로 남고 그 위의 커밋들이 편집 대상이다.
   * 그래프는 최신이 위지만 todo는 과거가 위라서 여기서 한 번만 뒤집는다.
   * (onSubmit으로 돌아오는 배열은 이미 todo 순서라 다시 뒤집지 않는다)
   */
  const openRebaseEditor = useCallback(
    (sha: string) => {
      const index = data.rows.findIndex((row) => row.sha === sha);
      if (index < 0) {
        return;
      }
      if (index === 0) {
        showError("There are no commits above this one to rebase.");
        return;
      }
      const steps: RebaseStep[] = data.rows
        .slice(0, index)
        .reverse()
        .map((row) => ({ sha: row.sha, action: "pick", subject: row.subject, message: null }));
      setRebase({ base: sha, steps });
    },
    [data.rows, showError],
  );

  const closeRebaseEditor = useCallback(() => setRebase(null), []);

  /**
   * 사이드바에서 끌던 ref를 커밋 행에 놓았을 때.
   * 체크아웃된 브랜치를 놓으면 그 커밋으로 리셋(모드는 다이얼로그에서 고른다),
   * 그 밖의 ref를 놓으면 그 커밋을 start point로 새 브랜치를 만든다.
   * git이 체크아웃되지 않은 브랜치를 옮기려면 branch -f가 필요한데 계약에 없다.
   */
  const handleRowDrop = useCallback(
    (sha: string, raw: string) => {
      setDropTargetSha(null);
      const payload = parseRefDrag(raw);
      if (payload === null || repo === null) {
        return;
      }
      if (payload.kind === "localBranch" && payload.name === repo.headBranch) {
        setDialog({ kind: "reset", target: sha });
        return;
      }
      setDialog({ kind: "createBranch", startPoint: sha });
    },
    [repo],
  );

  /** 드래그가 그래프 밖으로 나가면 강조를 끈다 */
  const handleRowDragOver = useCallback((sha: string | null) => {
    setDropTargetSha(sha);
  }, []);

  /**
   * 사이드바 드래그가 끝나면 강조를 끈다.
   * 드롭 타깃 자체는 GraphView가 REF_DRAG_MIME을 확인한 뒤에만 onRowDragOver를
   * 부르므로 여기서 따로 게이트를 두지 않는다
   */
  const handleRefDragStateChange = useCallback((payload: RefDragPayload | null) => {
    if (payload === null) {
      setDropTargetSha(null);
    }
  }, []);

  // Repository 메뉴(menu:fetch 등). App이 활성 탭의 카운터만 올린다
  useEffect(() => {
    const prev = lastRepoCommands.current;
    lastRepoCommands.current = repoCommands;
    // 카운터는 위에서 이미 소비했다. 모달이 닫힌 뒤에 뒤늦게 실행되지 않는다
    if (repo === null || modalOpen()) {
      return;
    }
    if (repoCommands.fetch > prev.fetch) {
      doFetch();
    }
    if (repoCommands.pull > prev.pull) {
      doPull();
    }
    if (repoCommands.push > prev.push) {
      doPush();
    }
    if (repoCommands.commit > prev.commit) {
      doCommit();
    }
    if (repoCommands.newBranch > prev.newBranch) {
      openNewBranchPrompt(null);
    }
    if (repoCommands.stash > prev.stash) {
      openStashPrompt();
    }
    if (repoCommands.stashPop > prev.stashPop) {
      doStashPop();
    }
  }, [
    repoCommands,
    repo,
    modalOpen,
    doFetch,
    doPull,
    doPush,
    doCommit,
    doStashPop,
    openNewBranchPrompt,
    openStashPrompt,
  ]);

  /**
   * 쓰기 단축키는 웹뷰 keydown이 실질적인 경로다.
   * macOS muda가 Shift 조합 accelerator를 제대로 못 잡아 네이티브 메뉴 쪽은 안 울릴 수 있다.
   * 입력창(커밋 메시지 textarea 포함)에서도 ⌘Enter는 살려둔다.
   */
  useEffect(() => {
    if (repo === null) {
      return;
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (!activeRef.current || (!event.metaKey && !event.ctrlKey) || event.altKey) {
        return;
      }
      if (modalOpen()) {
        return;
      }
      if (!event.shiftKey) {
        // ⌘Enter = Commit.
        // 커밋 메시지 상자 안에서는 CommitBox가 직접 커밋한다. 그 이벤트는
        // stopPropagation 없이 window까지 올라오므로, 여기서 한 번 더 처리하면
        // doCommit이 열려 있던 diff를 닫아버린다. 입력창에 있으면 손대지 않는다
        if ((event.code === "Enter" || event.code === "NumpadEnter") && !textFieldFocused()) {
          event.preventDefault();
          doCommit();
        }
        return;
      }
      // 나머지는 전부 ⌘⇧ 조합. 터미널이나 입력창에서는 가로채지 않는다
      if (textFieldFocused()) {
        return;
      }
      switch (event.code) {
        case "KeyF":
          event.preventDefault();
          doFetch();
          return;
        case "KeyP":
          event.preventDefault();
          doPull();
          return;
        case "KeyU":
          event.preventDefault();
          doPush();
          return;
        case "KeyN":
          event.preventDefault();
          openNewBranchPrompt(null);
          return;
        case "KeyS":
          event.preventDefault();
          openStashPrompt();
          return;
        case "KeyO":
          event.preventDefault();
          doStashPop();
          return;
        default:
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [
    repo,
    modalOpen,
    doFetch,
    doPull,
    doPush,
    doCommit,
    doStashPop,
    openNewBranchPrompt,
    openStashPrompt,
  ]);

  // 메뉴 Open Repository… (⌘O): 이 탭에서 폴더 다이얼로그를 연다
  useEffect(() => {
    if (openDialogNonce === 0 || openDialogNonce === lastOpenNonce.current) {
      return;
    }
    lastOpenNonce.current = openDialogNonce;
    void handleBrowse();
  }, [openDialogNonce, handleBrowse]);

  // 메뉴 Refresh (⌘R): 툴바 Refresh와 같은 경로
  useEffect(() => {
    if (refreshNonce === 0 || refreshNonce === lastRefreshNonce.current) {
      return;
    }
    lastRefreshNonce.current = refreshNonce;
    manualRefresh();
  }, [refreshNonce, manualRefresh]);

  /**
   * 5초 폴링과 탭 전환 확인. 쓰기 뒤 새로고침과 같은 syncRepoState를 쓴다.
   * graphToken이 바뀔 때만 그래프를 다시 읽고, wip이나 내용 지문만 바뀌었으면 WIP 상세와
   * 열린 WIP diff만 새로 읽는다 (audit-state M1. 그대로 두면 화면의 옛 hunk가 디스크에 없는
   * 내용을 인덱스에 넣는다). get_sync_state는 배지와 충돌 배너에 필요해 매 주기 같이 읽는다.
   * 쓰기가 큐에 있으면 건너뛴다 (CONTRACTS v0.15.2 5번). command가 메인 스레드를 떠나
   * 폴링이 리베이스 중간 상태를 읽을 수 있다. 쓰기가 끝나면 refreshAll이 어차피 돈다.
   * 확인창이 떠 있는 동안은 아직 큐에 없으니 폴링이 계속 돈다
   * (활성 탭 + 창 포커스 조건은 호출 측이 이미 걸어둔다).
   */
  const checkRepoState = useCallback(() => {
    if (
      repo === null ||
      writingRef.current > 0 ||
      loadingRef.current ||
      graphToken.current === ""
    ) {
      return;
    }
    void loadSyncData(repo.path);
    void syncRepoState(repo.path, false).then(({ contentChanged }) => {
      if (contentChanged) {
        dropWipFileText();
        setWipNonce((n) => n + 1);
      }
    });
  }, [repo, loadSyncData, syncRepoState, dropWipFileText]);

  // 자동 새로고침: 활성 탭이고 창이 포커스+가시 상태일 때만 5초마다 경량 폴링
  useEffect(() => {
    if (repo === null || !active) {
      return;
    }
    const timer = window.setInterval(() => {
      if (!document.hasFocus() || document.visibilityState !== "visible") {
        return;
      }
      checkRepoState();
    }, POLL_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [repo, active, checkRepoState]);

  // 비활성 탭은 폴링하지 않으므로, 활성화되는 순간 한 번 확인한다
  useEffect(() => {
    if (!active) {
      return;
    }
    checkRepoState();
  }, [active, checkRepoState]);

  const copySha = useCallback(
    (sha: string) => {
      void copyText(sha).then((ok) => {
        if (ok) {
          showToast(`sha 복사됨: ${shortSha(sha)}`, "info");
          return;
        }
        showError("클립보드에 복사하지 못했습니다.");
      });
    },
    [showToast, showError],
  );

  const handleRowContextMenu = useCallback((sha: string, x: number, y: number) => {
    setMenu({ kind: "commit", sha, x, y });
  }, []);

  /** 툴바 레포명 우클릭 */
  const handleRepoContextMenu = useCallback((x: number, y: number) => {
    setMenu({ kind: "repo", x, y });
  }, []);

  const closeMenu = useCallback(() => setMenu(null), []);

  /** 메뉴 콜백에서 최신 openPath를 쓴다 (정의 순서와 의존성 배열을 얽지 않기 위함) */
  const openPathRef = useRef(openPath);
  openPathRef.current = openPath;

  /** 우클릭한 행의 메시지. 커밋이면 subject, 스태시면 스태시 메시지 */
  const menuMessage = useMemo(() => {
    if (menu === null || menu.kind !== "commit") {
      return "";
    }
    const row = data.rows.find((r) => r.sha === menu.sha);
    if (row !== undefined) {
      return row.subject;
    }
    return data.stashes.find((stash) => stash.sha === menu.sha)?.message ?? "";
  }, [menu, data.rows, data.stashes]);

  const copyPathItems: MenuItem[] = useMemo(() => {
    if (repo === null) {
      return [];
    }
    const path = repo.path;
    const items: MenuItem[] = [
      {
        label: "Copy Path",
        onSelect: () => {
          void copyText(path).then((ok) => {
            if (ok) {
              showToast("경로 복사됨", "info");
              return;
            }
            showError("클립보드에 복사하지 못했습니다.");
          });
        },
      },
      {
        label: "Reveal in Finder",
        onSelect: () => {
          revealPath(path).catch((err: unknown) => showError(errorMessage(err)));
        },
      },
    ];

    // list_remotes / list_worktrees 배선. 사이드바 섹션(ui-sidebar)이 붙기 전에도
    // 이 두 데이터는 여기서 바로 쓸모가 있다
    if (remotes.length > 0) {
      items.push({
        label: "Copy remote URL",
        separatorBefore: true,
        children: remotes.map((remote) => ({
          label: `${remote.name}: ${remote.fetchUrl}`,
          onSelect: () => {
            void copyText(remote.fetchUrl).then((ok) => {
              if (ok) {
                showToast(`${remote.name} URL 복사됨`, "info");
                return;
              }
              showError("클립보드에 복사하지 못했습니다.");
            });
          },
        })),
      });
    }

    const others = worktrees.filter((tree) => !tree.isMain && !tree.isPrunable);
    if (others.length > 0) {
      items.push({
        label: "Open worktree",
        separatorBefore: remotes.length === 0,
        children: others.map((tree) => ({
          label: `${basename(tree.path)}${tree.branch === null ? "" : ` (${tree.branch})`}`,
          title: tree.path,
          onSelect: () => {
            void openPathRef.current(tree.path);
          },
        })),
      });
    }

    return items;
  }, [repo, remotes, worktrees, showToast, showError]);

  const menuItems: MenuItem[] = useMemo(() => {
    if (menu === null) {
      return [];
    }
    if (menu.kind === "repo") {
      return copyPathItems;
    }
    const sha = menu.sha;
    // WIP 의사 행과 스태시 행은 진짜 커밋이 아니라 쓰기 대상이 될 수 없다
    const isCommit = sha !== WIP_SHA && data.rows.some((row) => row.sha === sha);
    const label = shortSha(sha);
    const branch = repo?.headBranch ?? "HEAD";

    const items: MenuItem[] = [];

    if (isCommit) {
      items.push(
        {
          label: `Checkout ${label}`,
          title: "Leaves HEAD detached. Create a branch here to keep new commits.",
          onSelect: () => fire(actions.checkout(sha, false)),
        },
        {
          label: "Create branch here\u2026",
          onSelect: () => openNewBranchPrompt(sha),
        },
        {
          label: "Create tag here\u2026",
          onSelect: () => openNewTagPrompt(sha),
        },
        {
          label: "Cherry-pick",
          separatorBefore: true,
          title: `Apply ${label} on top of ${branch}`,
          onSelect: () => fire(actions.cherryPick([sha], false)),
        },
        {
          label: "Revert",
          title: `Create a commit on ${branch} that undoes ${label}`,
          onSelect: () => fire(actions.revert([sha], false)),
        },
        {
          label: `Reset ${branch} here`,
          separatorBefore: true,
          children: [
            {
              label: "Soft (keep index and working tree)",
              onSelect: () => fire(actions.reset(sha, "soft")),
            },
            {
              label: "Mixed (keep working tree)",
              onSelect: () => fire(actions.reset(sha, "mixed")),
            },
            {
              label: "Hard (discard all changes)",
              danger: true,
              onSelect: () => fire(actions.reset(sha, "hard")),
            },
          ],
        },
        {
          label: "Interactive rebase from here\u2026",
          title: "Reorder, squash or drop the commits above this one",
          onSelect: () => openRebaseEditor(sha),
        },
        {
          label: "Merge into current branch\u2026",
          separatorBefore: true,
          onSelect: () => setDialog({ kind: "merge", source: sha }),
        },
        {
          label: `Rebase ${branch} onto here\u2026`,
          onSelect: () => setDialog({ kind: "rebase", upstream: sha }),
        },
      );
    }

    items.push(
      { label: "Copy sha", separatorBefore: isCommit, onSelect: () => copySha(sha) },
      {
        label: "Copy message",
        disabled: menuMessage === "",
        onSelect: () => {
          void copyText(menuMessage).then((ok) => {
            if (ok) {
              showToast("메시지 복사됨", "info");
              return;
            }
            showError("클립보드에 복사하지 못했습니다.");
          });
        },
      },
    );
    if (remoteUrl !== null) {
      items.push({
        label: remoteUrl.includes("github.com") ? "Open on GitHub" : "Open on Remote",
        onSelect: () => {
          void openUrl(`${remoteUrl}/commit/${sha}`).catch((err: unknown) => {
            showError(errorMessage(err));
          });
        },
      });
    }
    return items;
  }, [
    menu,
    menuMessage,
    remoteUrl,
    copySha,
    showToast,
    showError,
    copyPathItems,
    data.rows,
    repo,
    actions,
    fire,
    openNewBranchPrompt,
    openNewTagPrompt,
    openRebaseEditor,
  ]);

  const previewWidth = useCallback((name: "sidebar" | "detail", width: number) => {
    mainRef.current?.style.setProperty(`--${name}-w`, `${width}px`);
  }, []);

  const commitWidth = useCallback((name: "sidebar" | "detail", width: number) => {
    setLayout((prev) => {
      const next = { ...prev, [name]: width };
      writeLayout(next);
      return next;
    });
  }, []);

  const resetWidth = useCallback(
    (name: "sidebar" | "detail") => {
      previewWidth(name, DEFAULT_LAYOUT[name]);
      commitWidth(name, DEFAULT_LAYOUT[name]);
    },
    [previewWidth, commitWidth],
  );

  const handleToggleSidebar = useCallback(() => {
    setSidebarOpen((prev) => {
      writeFlag(SIDEBAR_KEY, !prev);
      return !prev;
    });
  }, []);

  // 메뉴 View > Toggle Sidebar (⌘B). 활성 탭에만 nonce가 올라온다
  useEffect(() => {
    if (toggleSidebarNonce === 0 || toggleSidebarNonce === lastSidebarNonce.current) {
      return;
    }
    lastSidebarNonce.current = toggleSidebarNonce;
    handleToggleSidebar();
  }, [toggleSidebarNonce, handleToggleSidebar]);

  const toggleTerminal = useCallback(() => setTerminalOpen((prev) => !prev), []);
  const closeTerminal = useCallback(() => setTerminalOpen(false), []);

  // 메뉴 View > Toggle Terminal (⌃`)
  useEffect(() => {
    if (toggleTerminalNonce === 0 || toggleTerminalNonce === lastTerminalNonce.current) {
      return;
    }
    lastTerminalNonce.current = toggleTerminalNonce;
    toggleTerminal();
  }, [toggleTerminalNonce, toggleTerminal]);

  // ⌘W (터미널 포커스): 토글이 아니라 닫기만
  useEffect(() => {
    if (closeTerminalNonce === 0 || closeTerminalNonce === lastCloseTerminalNonce.current) {
      return;
    }
    lastCloseTerminalNonce.current = closeTerminalNonce;
    setTerminalOpen(false);
  }, [closeTerminalNonce]);

  const previewTermHeight = useCallback((height: number) => {
    dockRef.current?.style.setProperty("height", `${height}px`);
  }, []);

  const commitTermHeight = useCallback((height: number) => {
    setTermHeight(height);
    writeTermHeight(height);
  }, []);

  /** ⌘⇧H / 툴바 버튼: HEAD 커밋을 선택하고 중앙으로 스크롤 */
  const goToHead = useCallback(() => {
    if (repo === null) {
      return;
    }
    if (!loadedShas.has(repo.headSha)) {
      showError("HEAD 커밋이 로드 범위 밖입니다. 더 불러오세요.");
      return;
    }
    jumpTo(repo.headSha);
  }, [repo, loadedShas, jumpTo, showError]);

  const handleToggleFilterMode = useCallback(() => setFilterMode((prev) => !prev), []);

  const handleCopyRefName = useCallback(
    (name: string) => {
      void copyText(name).then((ok) => {
        if (ok) {
          showToast(`이름 복사됨: ${name}`, "info");
          return;
        }
        showError("클립보드에 복사하지 못했습니다.");
      });
    },
    [showToast, showError],
  );

  /** 원격 브랜치는 "origin/" 같은 remote 접두를 떼고 링크를 만든다 */
  const handleOpenRefOnRemote = useCallback(
    (entry: RefEntry) => {
      if (remoteUrl === null) {
        return;
      }
      const branch = entry.kind === "remoteBranch" ? entry.name.replace(/^[^/]+\//, "") : entry.name;
      const url =
        entry.kind === "tag"
          ? `${remoteUrl}/releases/tag/${entry.name}`
          : `${remoteUrl}/tree/${branch}`;
      void openUrl(url).catch((err: unknown) => showError(errorMessage(err)));
    },
    [remoteUrl, showError],
  );

  const handleQuickSelect = useCallback(
    (entry: RefEntry) => {
      setQuickOpen(false);
      handleSelectRef(entry.sha);
    },
    [handleSelectRef],
  );

  const closeQuickSwitcher = useCallback(() => setQuickOpen(false), []);

  // 다른 탭으로 넘어가면 이 탭의 오버레이는 접는다
  useEffect(() => {
    if (!active) {
      setQuickOpen(false);
      setMenu(null);
    }
  }, [active]);

  /** ⌘⌥F: 사이드바가 접혀 있으면 펴고 브랜치 필터로 포커스 */
  const focusSidebarFilter = useCallback(() => {
    if (!sidebarOpen) {
      writeFlag(SIDEBAR_KEY, true);
      setSidebarOpen(true);
      // 입력창이 마운트된 다음 프레임에 포커스한다
      window.setTimeout(() => sidebarFilterRef.current?.focus(), 0);
      return;
    }
    const input = sidebarFilterRef.current;
    if (input !== null) {
      input.focus();
      input.select();
    }
  }, [sidebarOpen]);

  const copySelectedMessage = useCallback(() => {
    if (selectedSha === null || selectedSha === WIP_SHA) {
      return;
    }
    const row = data.rows.find((r) => r.sha === selectedSha);
    const message =
      row?.subject ?? data.stashes.find((stash) => stash.sha === selectedSha)?.message ?? "";
    if (message === "") {
      return;
    }
    void copyText(message).then((ok) => {
      if (ok) {
        showToast("메시지 복사됨", "info");
        return;
      }
      showError("클립보드에 복사하지 못했습니다.");
    });
  }, [selectedSha, data.rows, data.stashes, showToast, showError]);

  /** 지금 뷰어가 보여주는 파일의 캐시 키. 늦게 온 응답을 버리는 데 쓴다 */
  const fileKey =
    repo === null || openFile === null || selectedSha === null
      ? null
      : `${selectedSha}\u0000${openFile.area ?? ""}\u0000${openFile.file.path}`;
  const fileKeyRef = useRef(fileKey);
  fileKeyRef.current = fileKey;

  // 다른 커밋을 고르거나 선택을 풀면 열린 파일도 닫는다
  useEffect(() => {
    setOpenFile(null);
  }, [selectedSha]);

  /** 지금 diffText가 어느 파일의 diff인가. 같은 파일을 다시 읽을 때 화면을 비우지 않으려고 쓴다 */
  const diffKeyRef = useRef<string | null>(null);
  const diffTextRef = useRef<string | null>(null);
  diffTextRef.current = diffText;
  const openFileRef = useRef<OpenFile | null>(null);
  openFileRef.current = openFile;

  // 파일이 열리면 그 커밋 기준 unified diff를 읽는다
  useEffect(() => {
    if (repo === null || openFile === null || selectedSha === null) {
      diffKeyRef.current = null;
      setDiffText(null);
      setFileText(null);
      setDiffError(null);
      setDiffLoading(false);
      return;
    }
    let alive = true;
    const key = fileKeyRef.current;
    // 같은 파일을 wipNonce로 다시 읽는 경우(폴링, 쓰기 직후)는 옛 diff를 띄워 둔 채 읽고,
    // 내용이 실제로 달라졌을 때만 바꾼다. 다른 파일을 편집할 때마다 열린 diff가 깜빡이고
    // 줄 선택이 풀리는 것을 막는다
    const soft = key !== null && diffKeyRef.current === key && diffTextRef.current !== null;
    if (!soft) {
      setDiffText(null);
      setFileText(null);
      setDiffError(null);
      setDiffLoading(true);
    }
    const pending =
      openFile.area === null
        ? getFileDiff(repo.path, selectedSha, openFile.file.path, openFile.file.oldPath)
        : getWipFileDiff(repo.path, openFile.file.path, openFile.area);
    pending
      .then((text) => {
        if (!alive) {
          return;
        }
        diffKeyRef.current = key;
        if (soft && text === diffTextRef.current) {
          return;
        }
        if (soft) {
          // 전문 뷰도 옛 내용이다. 비우면 File View가 다시 요청한다
          setFileText(null);
        }
        setDiffText(text);
      })
      .catch((err: unknown) => {
        if (alive) {
          setDiffError(errorMessage(err));
        }
      })
      .finally(() => {
        if (alive) {
          setDiffLoading(false);
        }
      });
    return () => {
      alive = false;
    };
    // wipNonce: 워킹 트리가 바뀌면 열린 WIP diff를 다시 읽는다
  }, [repo, openFile, selectedSha, wipNonce]);

  /** File View/split이 파일 전문을 필요로 할 때만 get_file_content를 부른다 */
  const handleRequestFileText = useCallback(() => {
    if (repo === null || openFile === null || selectedSha === null) {
      return;
    }
    const key = `${selectedSha}\u0000${openFile.area ?? ""}\u0000${openFile.file.path}`;
    const cached = fileTextCache.current.get(key);
    if (cached !== undefined) {
      setFileText(cached);
      return;
    }
    if (fileTextReq.current === key) {
      return;
    }
    fileTextReq.current = key;
    setDiffLoading(true);
    const pending =
      openFile.area === null
        ? getFileContent(repo.path, selectedSha, openFile.file.path)
        : getWipFileContent(repo.path, openFile.file.path);
    pending
      .then((text) => {
        fileTextCache.current.set(key, text);
        if (fileKeyRef.current === key) {
          setFileText(text);
        }
      })
      .catch((err: unknown) => {
        // "binary" / "too large" 같은 Err는 그대로 뷰어에 넘긴다
        if (fileKeyRef.current === key) {
          setDiffError(errorMessage(err));
        }
      })
      .finally(() => {
        if (fileTextReq.current === key) {
          fileTextReq.current = null;
        }
        if (fileKeyRef.current === key) {
          setDiffLoading(false);
        }
      });
  }, [repo, openFile, selectedSha]);

  const isWipSelected = selectedSha === WIP_SHA;

  // WIP 행을 고르면 커밋 상세 대신 워킹 트리 변경 목록을 읽는다 (get_commit_details 호출 없음)
  useEffect(() => {
    if (repo === null || !isWipSelected) {
      setWipDetails(null);
      setWipLoading(false);
      return;
    }
    let alive = true;
    setWipLoading(true);
    getWipDetails(repo.path)
      .then((details) => {
        if (alive) {
          setWipDetails(details);
        }
      })
      .catch((err: unknown) => {
        if (alive) {
          showError(errorMessage(err));
        }
      })
      .finally(() => {
        if (alive) {
          setWipLoading(false);
        }
      });
    return () => {
      alive = false;
    };
  }, [repo, isWipSelected, wipNonce, showError]);

  // 워킹 트리가 깨끗해지면 WIP 행 자체가 사라지므로 선택도 푼다
  useEffect(() => {
    if (isWipSelected && graph !== null && graph.wip === null) {
      setSelectedSha(null);
    }
  }, [isWipSelected, graph]);

  // 폴링으로 목록이 갱신됐는데 열어둔 WIP 파일이 사라졌으면 뷰어를 닫는다
  useEffect(() => {
    if (openFile === null || openFile.area === null || wipDetails === null) {
      return;
    }
    const list = wipDetails[openFile.area];
    if (!list.some((entry) => entry.path === openFile.file.path)) {
      setOpenFile(null);
    }
  }, [wipDetails, openFile]);

  const openCommitFile = useCallback((file: FileChange) => {
    setOpenFile({ file, area: null });
  }, []);

  const openWipFile = useCallback((file: FileChange, area: WipArea) => {
    setOpenFile({ file, area });
  }, []);

  const closeFile = useCallback(() => setOpenFile(null), []);

  /** CommitBox의 Amend 체크가 마지막 커밋 메시지를 채울 때 쓴다 */
  const requestLastMessage = useCallback(async (): Promise<string> => {
    if (repo === null) {
      return "";
    }
    return getLastCommitMessage(repo.path);
  }, [repo]);

  /** 적용 직전 diff 재확인이 도는 중. 그 사이 두 번째 클릭이 같은 패치를 또 보내지 않게 한다 */
  const [patchChecking, setPatchChecking] = useState(false);
  const patchCheckingRef = useRef(false);

  /**
   * 패치를 보내기 직전에 열린 파일의 diff를 다시 읽어 화면의 diff와 그대로 같은지 본다.
   * 폴링(5초) 사이에 파일이 바뀌면 화면의 hunk는 디스크에 없는 내용이다. 인덱스 쪽 적용은
   * 워킹 트리를 보지 않으므로 git apply가 거절하지 못한다 (audit-state M1, audit-patch M3).
   * 달라졌으면 적용하지 않고 diff를 새로 읽게 한 뒤 다시 보라고 알린다
   */
  const guardedApplyPatch = useCallback(
    async (patch: string, cached: boolean, reverse: boolean, scope?: string): Promise<void> => {
      const current = repoRef.current;
      const open = openFileRef.current;
      const shown = diffTextRef.current;
      if (current === null || open === null || open.area === null || shown === null) {
        return;
      }
      if (patchCheckingRef.current) {
        return;
      }
      patchCheckingRef.current = true;
      setPatchChecking(true);
      let fresh: string;
      try {
        fresh = await getWipFileDiff(current.path, open.file.path, open.area);
      } catch (err) {
        showError(errorMessage(err));
        return;
      } finally {
        patchCheckingRef.current = false;
        setPatchChecking(false);
      }
      // 확인하는 사이 다른 파일이나 다른 레포로 옮겨 갔으면 그 패치는 의미가 없다
      if (repoRef.current?.path !== current.path || openFileRef.current !== open) {
        return;
      }
      if (fresh !== diffTextRef.current) {
        fileTextCache.current.clear();
        setWipNonce((n) => n + 1);
        showToast(
          "The file changed since the diff was loaded. The diff was reloaded, review it and try again.",
          "info",
        );
        return;
      }
      await actions.applyPatch(patch, cached, reverse, scope);
    },
    [actions, showError, showToast],
  );

  /**
   * hunk 단위 스테이징은 워킹 트리 diff에서만 된다.
   * 커밋 diff에 주면 과거 커밋에 Stage hunk 버튼이 뜨고, untracked는
   * git diff --no-index 산물이라 a/dev/null 접두 때문에 git apply가 먹지 않는다
   */
  const hunkActions = useMemo(() => {
    const area = openFile?.area ?? null;
    if (area === null || area === "untracked") {
      return null;
    }
    return { area, applyPatch: guardedApplyPatch, busy: actions.busy || patchChecking };
  }, [openFile, actions.busy, guardedApplyPatch, patchChecking]);

  /** WIP 의사 행 클릭. 센티널을 선택으로 넣으면 오른쪽이 WIP 패널로 바뀐다 */
  const selectWip = useCallback(() => setSelectedSha(WIP_SHA), []);


  /**
   * Esc는 한 번에 한 단계만 되돌린다.
   * 오버레이 → diff 패널 닫기 → 검색어 → 선택. 처리했으면 true
   */
  const handleEscape = useCallback((): boolean => {
    if (quickOpen) {
      setQuickOpen(false);
      return true;
    }
    if (menu !== null) {
      setMenu(null);
      return true;
    }
    if (anyOverlayOpen()) {
      // 사이드바/탭 컨텍스트 메뉴와 오버레이는 자기 Esc 핸들러가 닫는다. 여기서 더 나가지 않는다
      return true;
    }
    if (openFile !== null) {
      setOpenFile(null);
      return true;
    }
    if (query !== "") {
      handleClearSearch();
      return true;
    }
    if (selectedSha !== null) {
      setSelectedSha(null);
      return true;
    }
    return false;
  }, [quickOpen, menu, openFile, query, handleClearSearch, selectedSha]);

  // 워크스페이스 단축키. 활성 탭에서만 반응한다 (탭마다 하나씩 등록돼 있다)
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!activeRef.current) {
        return;
      }
      if (event.key === "Escape") {
        // 터미널이나 입력창에서 누른 Esc는 그쪽 것이다 (vim 등)
        if (textFieldFocused()) {
          return;
        }
        if (handleEscape()) {
          event.preventDefault();
        }
        return;
      }
      if (repo === null || (!event.metaKey && !event.ctrlKey)) {
        return;
      }
      // ⌃` 하단 터미널 토글. 백틱은 레이아웃에 따라 key가 달라 물리 키로 본다
      if (event.code === "Backquote") {
        event.preventDefault();
        toggleTerminal();
        return;
      }
      // ⌘⌥F: Option이 끼면 key가 "ƒ"로 바뀌므로 물리 키로 본다
      if (event.altKey) {
        if (event.code === "KeyF") {
          event.preventDefault();
          focusSidebarFilter();
        }
        return;
      }
      if (event.shiftKey) {
        if (event.code === "KeyH") {
          event.preventDefault();
          goToHead();
          return;
        }
        // ⌘⇧F는 v0.18에서 Fetch가 가져갔다 (네이티브 Repository 메뉴와 같은 조합).
        // 필터 모드는 ⌘⇧L로 옮겼다
        if (event.code === "KeyL") {
          event.preventDefault();
          handleToggleFilterMode();
          return;
        }
        if (event.code === "KeyC" && !typingOrSelecting()) {
          event.preventDefault();
          copySelectedMessage();
        }
        return;
      }
      if (event.code === "KeyP") {
        event.preventDefault();
        setQuickOpen(true);
        return;
      }
      if (
        event.code === "KeyC" &&
        selectedSha !== null &&
        selectedSha !== WIP_SHA &&
        !typingOrSelecting()
      ) {
        event.preventDefault();
        copySha(selectedSha);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [
    repo,
    toggleTerminal,
    handleEscape,
    focusSidebarFilter,
    goToHead,
    handleToggleFilterMode,
    copySelectedMessage,
    copySha,
    selectedSha,
  ]);

  /** 필터 모드에서 보여줄 행. 기존 로컬 매치 로직을 그대로 재사용한다 */
  const filteredRows = useMemo(() => {
    if (!filterMode) {
      return [];
    }
    const hits = new Set(matches);
    return data.rows.filter((row) => hits.has(row.sha));
  }, [filterMode, matches, data.rows]);

  /** 전체 매치 수. 전체 검색을 이미 돌린 질의어면 그 결과 수가 더 정확하다 */
  const filterTotal = Math.max(
    filteredRows.length,
    searchCache.current.get(query.trim())?.length ?? 0,
  );

  const toastNode = <ToastStack items={toasts} onClose={dismissToast} />;

  /** 다이얼로그 콤보박스에 채울 ref 이름 목록 */
  const refNames = useMemo(() => refs.map((entry) => entry.name), [refs]);
  const localBranchNames = useMemo(
    () => refs.filter((entry) => entry.kind === "localBranch").map((entry) => entry.name),
    [refs],
  );
  const remoteBranchNames = useMemo(
    () => refs.filter((entry) => entry.kind === "remoteBranch").map((entry) => entry.name),
    [refs],
  );
  const tagNames = useMemo(
    () => refs.filter((entry) => entry.kind === "tag").map((entry) => entry.name),
    [refs],
  );

  if (repo === null) {
    return (
      <div className="workspace">
        {banner}
        <WelcomeScreen
          recents={recents}
          opening={opening}
          onOpen={handleBrowse}
          onOpenPath={openPath}
          onRemoveRecent={removeRecent}
        />
        {toastNode}
      </div>
    );
  }

  return (
    <div className="workspace">
      <Toolbar
        repo={repo}
        actions={actions}
        sync={syncState}
        onCreateBranch={() => openNewBranchPrompt(null)}
        onOpenStashDialog={openStashPrompt}
        sidebarOpen={sidebarOpen}
        onToggleSidebar={handleToggleSidebar}
        onGoToHead={goToHead}
        terminalOpen={terminalOpen}
        onToggleTerminal={toggleTerminal}
        onRepoContextMenu={handleRepoContextMenu}
        search={
          <SearchBox
            query={query}
            matchCount={matches.length}
            matchPosition={matches.length === 0 ? 0 : matchIndex + 1}
            searching={searching}
            exhausted={searchExhausted}
            inputRef={searchInputRef}
            filterMode={filterMode}
            onToggleFilterMode={handleToggleFilterMode}
            onChange={setQuery}
            onNext={handleNextMatch}
            onPrev={handlePrevMatch}
            onClear={handleClearSearch}
          />
        }
        commitCount={data.totalLoaded}
        hasMore={data.hasMore}
        loading={graphLoading}
        onRefresh={manualRefresh}
        updateTag={update.tag}
        onOpenRelease={update.onOpenRelease}
        appVersion={APP_VERSION}
        checkingUpdate={update.checking}
        onCheckUpdates={update.onCheck}
      />
      {banner}
      {/* 진행 중인 머지/리베이스가 있으면 툴바 바로 아래에 붙는다.
          Continue 활성 조건이 files.length === 0 이라 해결 직후 get_conflicts를
          다시 읽어야 한다. refreshAll이 loadSyncData로 그걸 보장한다 */}
      <ConflictPanel
        pending={syncState?.pending ?? null}
        files={conflicts}
        actions={actions}
        onOpenFile={openConflictFile}
      />
      {graphLoading && <div className="progress" role="progressbar" aria-label="Loading graph" />}

      <div
        className="main"
        ref={mainRef}
        style={
          {
            "--sidebar-w": `${layout.sidebar}px`,
            "--detail-w": `${layout.detail}px`,
          } as CSSProperties
        }
      >
        {sidebarOpen && (
          <>
            <BranchSidebar
              refs={refs}
              stashes={data.stashes}
              remotes={remotes}
              worktrees={worktrees}
              syncState={syncState}
              actions={actions}
              onRequestDialog={handleSidebarDialog}
              onOpenWorktree={openPath}
              onRefDragStateChange={handleRefDragStateChange}
              loading={refsLoading}
              selectedSha={selectedSha}
              onSelectRef={handleSelectRef}
              onCopyRefName={handleCopyRefName}
              onOpenRefOnRemote={remoteUrl === null ? undefined : handleOpenRefOnRemote}
              filterInputRef={sidebarFilterRef}
            />
            <SplitHandle
              label="사이드바 폭 조절"
              getWidth={() => layout.sidebar}
              min={SIDEBAR_MIN}
              max={() => SIDEBAR_MAX}
              onPreview={(width) => previewWidth("sidebar", width)}
              onCommit={(width) => commitWidth("sidebar", width)}
              onReset={() => resetWidth("sidebar")}
            />
          </>
        )}
        <div className="graph-area">
          {openFile !== null ? (
            <DiffPanel
              file={openFile.file}
              badge={openFile.area ?? undefined}
              hunkActions={hunkActions}
              diffText={diffText}
              fileText={fileText}
              onRequestFileText={handleRequestFileText}
              loading={diffLoading}
              error={diffError}
              onClose={closeFile}
            />
          ) : filterMode ? (
            <FilterResults
              rows={filteredRows}
              query={query}
              selectedSha={selectedSha}
              onSelect={setSelectedSha}
              total={filterTotal}
              hasMore={data.hasMore}
              onLoadMore={handleLoadMore}
            />
          ) : (
            <GraphView
              data={data}
              onRowDragOver={handleRowDragOver}
              onRowDrop={handleRowDrop}
              dropTargetSha={dropTargetSha}
              pendingSha={syncState?.pending == null ? null : repo.headSha}
              selectedSha={selectedSha}
              onSelect={setSelectedSha}
              onLoadMore={handleLoadMore}
              loading={graphLoading}
              showTags={prefs.showTags}
              scrollTarget={scrollTarget}
              onRowDoubleClick={copySha}
              onRowContextMenu={handleRowContextMenu}
              onSelectWip={selectWip}
              highlightQuery={query}
              hoverHighlight={prefs.hoverHighlight}
              dateMode={prefs.dateMode}
            />
          )}
        </div>
        {selectedSha !== null && (
          <SplitHandle
            label="상세 패널 폭 조절"
            getWidth={() => layout.detail}
            min={DETAIL_MIN}
            max={detailMax}
            invert
            onPreview={(width) => previewWidth("detail", width)}
            onCommit={(width) => commitWidth("detail", width)}
            onReset={() => resetWidth("detail")}
          />
        )}
        {isWipSelected && (
          <WipDetailPanel
            actions={actions}
            repoPath={repo.path}
            onRequestLastMessage={requestLastMessage}
            details={wipDetails}
            loading={wipLoading}
            onOpenFile={openWipFile}
            openFile={
              openFile === null || openFile.area === null
                ? null
                : { path: openFile.file.path, area: openFile.area }
            }
          />
        )}
        {selectedSha !== null && !isWipSelected && (
          <CommitDetailPanel
            key={selectedSha}
            repoPath={repo.path}
            sha={selectedSha}
            isStash={data.stashes.some((stash) => stash.sha === selectedSha)}
            onSelectSha={setSelectedSha}
            onError={showError}
            onOpenFile={openCommitFile}
            openFilePath={openFile === null || openFile.area !== null ? null : openFile.file.path}
          />
        )}
      </div>

      <div
        className={terminalOpen ? "term-dock" : "term-dock collapsed"}
        ref={dockRef}
        style={{ height: terminalOpen ? `${termHeight}px` : 0 }}
      >
        {/* 접힘 상태에서는 빈 공간 위에 드래그 바만 뜨지 않게 핸들도 감춘다 */}
        {terminalOpen && (
          <SplitHandle
            axis="y"
            label="터미널 높이 조절"
            getWidth={() => termHeight}
            min={TERM_MIN}
            max={termMax}
            invert
            onPreview={previewTermHeight}
            onCommit={commitTermHeight}
            onReset={() => {
              previewTermHeight(DEFAULT_TERM_HEIGHT);
              commitTermHeight(DEFAULT_TERM_HEIGHT);
            }}
          />
        )}
        {/* 헤더(레포 경로 + ×)는 Terminal이 직접 그린다. 여기서 또 두지 않는다.
            탭이 살아있는 동안 언마운트하지 않는다 (PTY 세션 유지) — visible로만 토글 */}
        <Terminal
          repoPath={repo.path}
          visible={terminalOpen}
          onClose={closeTerminal}
          onSession={handleTermSession}
        />
      </div>

      <footer className="statusbar">
        <span>
          {formatCount(data.totalLoaded)} commits{data.hasMore ? "+" : ""}
        </span>
        <span>HEAD {shortSha(repo.headSha)}</span>
        {syncState !== null && (syncState.ahead > 0 || syncState.behind > 0) && (
          <span title={syncState.upstream ?? "no upstream"}>
            {syncState.ahead > 0 && `\u2191${syncState.ahead}`}
            {syncState.ahead > 0 && syncState.behind > 0 ? " " : ""}
            {syncState.behind > 0 && `\u2193${syncState.behind}`}
          </span>
        )}
        {syncState?.pending != null && (
          <span className="sb-pending">
            {syncState.pending.kind}
            {syncState.pending.progress === null ? "" : ` ${syncState.pending.progress}`}
            {syncState.pending.conflictCount > 0
              ? `, ${syncState.pending.conflictCount} conflicted`
              : ""}
          </span>
        )}
        {data.wip !== null && (
          <span>
            WIP {data.wip.changedFiles} changed ({data.wip.stagedFiles} staged)
          </span>
        )}
        {graphLoading && <span>Loading…</span>}
        <span className="sb-path" title={repo.path}>
          {repo.path}
        </span>
      </footer>

      {menu !== null && (
        <ContextMenu x={menu.x} y={menu.y} items={menuItems} onClose={closeMenu} />
      )}

      <QuickSwitcher
        open={quickOpen}
        refs={refs}
        onSelect={handleQuickSelect}
        onClose={closeQuickSwitcher}
      />

      {/* 파괴적 작업 확인. 액션 계층이 넘긴 ConfirmSpec을 그대로 그린다 (안전 계약 6번) */}
      {pendingConfirm !== null && (
        <ConfirmDialog
          open
          spec={pendingConfirm.spec}
          onConfirm={() => settleConfirm(true)}
          onCancel={() => settleConfirm(false)}
        />
      )}

      <CreateBranchDialog
        open={dialog?.kind === "createBranch"}
        onClose={closeDialog}
        refs={refNames}
        defaultStartPoint={
          dialog?.kind === "createBranch" && dialog.startPoint !== null ? dialog.startPoint : "HEAD"
        }
        existingNames={localBranchNames}
        onSubmit={(name, startPoint, checkout) => {
          closeDialog();
          fire(actions.createBranch(name, startPoint, checkout));
        }}
      />

      <RenameBranchDialog
        open={dialog?.kind === "renameBranch"}
        onClose={closeDialog}
        branch={dialog?.kind === "renameBranch" ? dialog.branch : ""}
        existingNames={localBranchNames}
        onSubmit={(from, to) => {
          closeDialog();
          fire(actions.renameBranch(from, to));
        }}
      />

      <CreateTagDialog
        open={dialog?.kind === "createTag"}
        onClose={closeDialog}
        refs={refNames}
        defaultTarget={
          dialog?.kind === "createTag" && dialog.target !== null ? dialog.target : "HEAD"
        }
        existingNames={tagNames}
        onSubmit={(name, target, message) => {
          closeDialog();
          fire(actions.createTag(name, target, message));
        }}
      />

      <ResetBranchDialog
        open={dialog?.kind === "reset"}
        onClose={closeDialog}
        target={dialog?.kind === "reset" ? dialog.target : "HEAD"}
        branch={repo.headBranch}
        onSubmit={(target, mode) => {
          closeDialog();
          fire(actions.reset(target, mode));
        }}
      />

      <MergeOptionsDialog
        open={dialog?.kind === "merge"}
        onClose={closeDialog}
        source={dialog?.kind === "merge" ? dialog.source : ""}
        target={repo.headBranch}
        onSubmit={(source, opts) => {
          closeDialog();
          fire(actions.merge(source, opts));
        }}
      />

      <RebaseOptionsDialog
        open={dialog?.kind === "rebase"}
        onClose={closeDialog}
        upstream={dialog?.kind === "rebase" ? dialog.upstream : ""}
        refs={refNames}
        branch={repo.headBranch}
        onSubmit={(upstream, onto) => {
          closeDialog();
          // autostash는 액션 계층이 항상 켠다. 다이얼로그의 체크는 표시용이다
          fire(actions.rebase(upstream, onto));
        }}
      />

      <SetUpstreamDialog
        open={dialog?.kind === "setUpstream"}
        onClose={closeDialog}
        branch={dialog?.kind === "setUpstream" ? dialog.branch : repo.headBranch}
        remoteBranches={remoteBranchNames}
        currentUpstream={syncState?.upstream ?? null}
        onSubmit={(branch, upstream) => {
          closeDialog();
          fire(actions.setUpstream(branch, upstream));
        }}
      />

      <RemoteDialog
        open={dialog?.kind === "remote"}
        onClose={closeDialog}
        remote={dialog?.kind === "remote" ? dialog.remote : null}
        existingNames={remotes.map((entry) => entry.name)}
        onSubmit={(name, url, originalName) => {
          closeDialog();
          if (originalName === null) {
            fire(actions.addRemote(name, url));
            return;
          }
          // 이름과 URL이 같이 바뀔 수 있다. 이름을 먼저 바꾸고 URL을 새 이름에 건다
          // (쓰기는 직렬 큐라 이 순서가 보장된다)
          if (originalName !== name) {
            fire(actions.renameRemote(originalName, name));
          }
          fire(actions.setRemoteUrl(name, url));
        }}
      />

      <AddWorktreeDialog
        open={dialog?.kind === "addWorktree"}
        onClose={closeDialog}
        onPickDirectory={pickDirectory}
        refs={refNames}
        existingBranches={localBranchNames}
        onSubmit={(dir, branch, createBranch) => {
          closeDialog();
          fire(actions.addWorktree(dir, branch, createBranch));
        }}
      />

      <StashDialog
        open={dialog?.kind === "stash"}
        onClose={closeDialog}
        onSubmit={(opts) => {
          closeDialog();
          fire(actions.stashPush(opts));
        }}
      />

      {dialog?.kind === "stashBranch" && (
        <PromptDialog
          open
          title="Create branch from stash"
          label="Branch name"
          placeholder="fix/from-stash"
          confirmLabel="Create"
          validate={(value) => (value.trim() === "" ? "Enter a name." : refNameProblem(value))}
          onSubmit={(name) => {
            const stashRef = dialog.ref;
            closeDialog();
            fire(actions.stashBranch(stashRef, name.trim()));
          }}
          onCancel={closeDialog}
        />
      )}

      {rebase !== null && (
        <RebaseEditor
          open
          onClose={closeRebaseEditor}
          base={rebase.base}
          steps={rebase.steps}
          busy={actions.busy}
          onSubmit={(steps) => {
            const base = rebase.base;
            closeRebaseEditor();
            // steps는 이미 todo 순서(위가 과거)로 돌아온다. 다시 뒤집지 않는다
            fire(actions.rebaseInteractive(base, steps));
          }}
        />
      )}

      {toastNode}
    </div>
  );
}
