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

function sameWip(a: WipInfo | null, b: WipInfo | null): boolean {
  if (a === null || b === null) {
    return a === b;
  }
  return a.changedFiles === b.changedFiles && a.stagedFiles === b.stagedFiles;
}

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
  /** 사이드바에서 ref 드래그가 진행 중인가. 그래프 드롭 타깃을 켜는 조건 */
  const [refDrag, setRefDrag] = useState<RefDragPayload | null>(null);
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
  /**
   * 하단 터미널의 PTY 세션 id. Terminal.tsx가 자기 세션을 안에서만 들고 있어
   * 아직 위로 올라오지 않는다. onSession prop이 생기면 여기에 채운다.
   * 그때까지 인증 핸드오프는 클립보드 폴백으로 동작한다.
   */
  const termSessionRef = useRef<string | null>(null);
  /** 진행 중인 sync/conflict 요청 번호. 늦게 온 응답을 버린다 */
  const syncReq = useRef(0);
  /** Repository 메뉴 카운터의 직전 값 */
  const lastRepoCommands = useRef<RepoCommandNonces>(NO_REPO_COMMANDS);

  const data: GraphData = graph ?? EMPTY_GRAPH;
  repoRef.current = repo;
  activeRef.current = active;
  rowCount.current = data.rows.length;
  loadingRef.current = graphLoading;
  wipRef.current = data.wip;

  /**
   * 인증 핸드오프 핸들러를 토스트마다 붙여 준다.
   * runInTerminal은 아래에서 정의되지만 콜백 안에서만 쓰이므로 ref로 지연 참조한다
   */
  const runInTerminalRef = useRef<(command: string[]) => void>(() => undefined);

  /** 액션 계층이 주는 ToastSpec을 스택에 쌓는다 */
  const pushToast = useCallback((spec: ToastSpec) => {
    toastSeq.current += 1;
    const id = toastSeq.current;
    const item: ToastItem = {
      id,
      ...spec,
      onRunInTerminal: (command) => runInTerminalRef.current(command),
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
    setGraphLoading(true);
    loadGraph(repo.path, page.limit, page.skip)
      .then((loaded) => {
        if (graphReq.current !== reqId) {
          return;
        }
        if (page.skip === 0) {
          graphToken.current = loaded.graphToken;
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
        addRecent(info.path);
        setSelectedSha(null);
        setScrollTarget(null);
        setQuery("");
        lastQuery.current = "";
        setSearchExhausted(false);
        searchCache.current.clear();
        fileTextCache.current.clear();
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

  // 사이드바 Remotes/Worktrees 섹션과 동기화 배지의 초기 데이터.
  // reloadKey가 오를 때(=쓰기 직후) 다시 읽어 remote 추가/워크트리 생성이 바로 보이게 한다
  useEffect(() => {
    if (repo === null) {
      setRemotes([]);
      setWorktrees([]);
      setSyncState(null);
      setConflicts([]);
      return;
    }
    const path = repo.path;
    listRemotes(path)
      .then(setRemotes)
      .catch(() => setRemotes([]));
    listWorktrees(path)
      .then(setWorktrees)
      .catch(() => setWorktrees([]));
    void loadSyncData(path);
  }, [repo, reloadKey, loadSyncData]);


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

  // ════════════════════════════════════════════════════════
  // v0.18 쓰기 액션 배선
  // ════════════════════════════════════════════════════════

  /**
   * 쓰기 직후 전체 새로고침. 폴링(5초)을 기다리지 않는다.
   * load_graph(skip=0, 현재 깊이 유지) + list_refs + get_sync_state + WIP 재로드.
   * 그래프/refs는 효과 기반이라 reloadFromStart가 트리거만 걸고,
   * await는 sync/conflict까지만 기다린다.
   */
  const refreshAll = useCallback(async () => {
    const current = repoRef.current;
    searchCache.current.clear();
    fileTextCache.current.clear();
    setWipNonce((n) => n + 1);
    reloadFromStart();
    if (current === null) {
      return;
    }
    await loadSyncData(current.path);
  }, [reloadFromStart, loadSyncData]);

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

  /**
   * 인증 핸드오프. 비대화식 git은 패스프레이즈를 물을 수 없으므로
   * 같은 명령을 내장 PTY에 그대로 넘겨 사용자가 직접 답하게 한다.
   *
   * Terminal.tsx가 세션 id를 위로 올려주지 않아(onSession prop 미구현)
   * 지금은 클립보드 폴백으로 동작한다. termSessionRef가 채워지면 자동으로 직접 실행으로 바뀐다.
   */
  const runInTerminal = useCallback(
    (command: string[]) => {
      const line = formatCommand(command);
      setTerminalOpen(true);
      const id = termSessionRef.current;
      if (id !== null) {
        termWrite(id, `${line}\n`).catch((err: unknown) => showError(errorMessage(err)));
        return;
      }
      void copyText(line).then((ok) => {
        showToast(
          ok
            ? "Command copied. Paste it into the terminal below and answer the prompt."
            : `Run this in the terminal below: ${line}`,
          "info",
          { durationMs: 10_000, copyable: true },
        );
      });
    },
    [showToast, showError],
  );

  runInTerminalRef.current = runInTerminal;

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

  const doFetch = useCallback(() => fire(actions.fetch()), [actions, fire]);
  const doPull = useCallback(() => fire(actions.pull("merge")), [actions, fire]);
  const doPush = useCallback(() => fire(actions.push()), [actions, fire]);
  const doStashPop = useCallback(
    () => fire(actions.stashApply(TOP_STASH, true)),
    [actions, fire],
  );

  /**
   * ⌘Enter(Commit). 커밋 메시지는 CommitBox(ui-wip)가 들고 있어 여기서 바로 커밋할 수 없다.
   * WIP 행을 선택해 커밋 상자를 띄우는 데까지가 셸의 몫이다.
   * TODO(통합): WipDetailPanel에 focusCommitNonce prop이 생기면 여기서 같이 올린다.
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
      setRefDrag(null);
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

  const handleRefDragStateChange = useCallback((payload: RefDragPayload | null) => {
    setRefDrag(payload);
    if (payload === null) {
      setDropTargetSha(null);
    }
  }, []);

  // Repository 메뉴(menu:fetch 등). App이 활성 탭의 카운터만 올린다
  useEffect(() => {
    const prev = lastRepoCommands.current;
    lastRepoCommands.current = repoCommands;
    if (repo === null) {
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
      if (!event.shiftKey) {
        // ⌘Enter = Commit. 커밋 메시지를 치는 중에도 먹어야 한다
        if (event.code === "Enter" || event.code === "NumpadEnter") {
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
    reloadFromStart();
  }, [refreshNonce, reloadFromStart]);

  /**
   * refs 지문/wip이 바뀌었으면 전체 리로드. 폴링과 탭 전환이 함께 쓴다.
   * get_sync_state는 배지와 충돌 배너에 필요해 지문과 무관하게 매 주기 같이 읽는다
   * (활성 탭 + 창 포커스 조건은 호출 측이 이미 걸어둔다).
   */
  const checkRepoState = useCallback(() => {
    if (repo === null || loadingRef.current || graphToken.current === "") {
      return;
    }
    void loadSyncData(repo.path);
    getRepoState(repo.path)
      .then((state) => {
        const wipChanged = !sameWip(state.wip, wipRef.current);
        if (state.graphToken !== graphToken.current || wipChanged) {
          searchCache.current.clear();
          if (wipChanged) {
            // 워킹 트리 파일은 내용이 바뀌었을 수 있으니 캐시를 버리고 다시 읽는다
            fileTextCache.current.clear();
            setWipNonce((n) => n + 1);
          }
          reloadFromStart();
        }
      })
      .catch(() => {
        // 폴링 실패는 조용히 넘긴다. 다음 주기에 다시 시도한다
      });
  }, [repo, reloadFromStart, loadSyncData]);

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

  // 파일이 열리면 그 커밋 기준 unified diff를 읽는다
  useEffect(() => {
    if (repo === null || openFile === null || selectedSha === null) {
      setDiffText(null);
      setFileText(null);
      setDiffError(null);
      setDiffLoading(false);
      return;
    }
    let alive = true;
    setDiffText(null);
    setFileText(null);
    setDiffError(null);
    setDiffLoading(true);
    const pending =
      openFile.area === null
        ? getFileDiff(repo.path, selectedSha, openFile.file.path, openFile.file.oldPath)
        : getWipFileDiff(repo.path, openFile.file.path, openFile.area);
    pending
      .then((text) => {
        if (alive) {
          setDiffText(text);
        }
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
    return { area, applyPatch: actions.applyPatch, busy: actions.busy };
  }, [openFile, actions]);

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
        onRefresh={reloadFromStart}
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
              dropTargetSha={refDrag === null ? null : dropTargetSha}
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
        <Terminal repoPath={repo.path} visible={terminalOpen} onClose={closeTerminal} />
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
