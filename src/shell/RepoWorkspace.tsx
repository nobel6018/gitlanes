// 탭 하나의 작업 공간. 레포/그래프/선택/검색/사이드바 상태를 전부 여기서 들고 있다.
// App은 이 컴포넌트를 탭마다 하나씩 마운트해두고 활성 탭만 보여준다.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import { GraphView } from "../graph";
import { COMMITS_PER_PAGE, WIP_SHA } from "../constants";
import type {
  FileChange,
  OpResult,
  PullMode,
  SyncState,
  GraphData,
  RefEntry,
  RepoInfo,
  SearchMatch,
  WipArea,
  WipDetails,
  WipInfo,
} from "../types";
import {
  errorMessage,
  getFileContent,
  getFileDiff,
  getRemoteUrl,
  getSyncState,
  getWipDetails,
  getWipFileContent,
  getWipFileDiff,
  gitCheckout,
  gitCreateBranch,
  gitDeleteBranch,
  gitFetch,
  gitMerge,
  gitPull,
  gitPush,
  gitStashPop,
  gitStashPush,
  getRepoState,
  listRefs,
  loadGraph,
  openInTerminal,
  openRepo,
  revealPath,
  searchCommits,
} from "./api";
import { copyText } from "./clipboard";
import { BranchSidebar } from "./BranchSidebar";
import { CommitDetailPanel } from "./CommitDetailPanel";
import { ContextMenu } from "./ContextMenu";
import type { MenuItem } from "./ContextMenu";
import { ConflictBanner } from "./ConflictBanner";
import { ConfirmDialog, PromptDialog } from "./Dialogs";
import { DiffPanel } from "./DiffPanel";
import { WipDetailPanel } from "./WipDetailPanel";
import { FilterResults } from "./FilterResults";
import { QuickSwitcher } from "./QuickSwitcher";
import {
  DEFAULT_LAYOUT,
  DETAIL_MIN,
  detailMax,
  readLayout,
  SIDEBAR_MAX,
  SIDEBAR_MIN,
  writeLayout,
} from "./layout";
import type { LayoutWidths } from "./layout";
import { SearchBox } from "./SearchBox";
import { SplitHandle } from "./SplitHandle";
import { Toast } from "./Toast";
import { Toolbar } from "./Toolbar";
import { WelcomeScreen } from "./WelcomeScreen";
import { useRecentRepos } from "./useRecentRepos";
import { APP_VERSION } from "./version";
import { formatCount, shortSha } from "./format";

const SHOW_TAGS_KEY = "gitlanes.showTags";
const SIDEBAR_KEY = "gitlanes.sidebar";
const DATE_MODE_KEY = "gitlanes.dateMode";

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

interface ToastState {
  id: number;
  message: string;
  tone: "error" | "info";
  durationMs?: number;
  copyable?: boolean;
}

/** git 오류는 읽을 게 많아 오래 띄운다 */
const OP_ERROR_MS = 12_000;

/** 한 번에 하나만 뜨는 모달. 확인형과 입력형 두 가지 */
type DialogState =
  | {
      kind: "confirm";
      title: string;
      body: string;
      confirmLabel: string;
      danger?: boolean;
      onConfirm: () => void;
    }
  | {
      kind: "prompt";
      title: string;
      label: string;
      placeholder: string;
      defaultValue?: string;
      confirmLabel: string;
      validate?: (value: string) => string | null;
      /** 추가 컨트롤. 지금은 스태시의 untracked 체크박스 하나뿐 */
      extra?: "untracked";
      onSubmit: (value: string) => void;
    };

/** 결과 토스트에 쓸 한 줄. git은 stdout이 비고 stderr에만 쓰는 경우가 많다 */
function summarizeOp(result: OpResult, label: string): string {
  const lines = `${result.stdout}\n${result.stderr}`
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
  return lines.length === 0 ? `${label} 완료` : lines[lines.length - 1];
}

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

/** 그래프 DATE 컬럼 표시 모드 */
type DateMode = "absolute" | "relative";

function readDateMode(): DateMode {
  try {
    return localStorage.getItem(DATE_MODE_KEY) === "relative" ? "relative" : "absolute";
  } catch {
    return "absolute";
  }
}

/** 입력창에 포커스가 있거나 텍스트가 선택돼 있으면 브라우저 기본 복사를 방해하지 않는다 */
function typingOrSelecting(): boolean {
  const selection = window.getSelection()?.toString() ?? "";
  if (selection !== "") {
    return true;
  }
  const el = document.activeElement;
  if (el === null) {
    return false;
  }
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    return true;
  }
  return el instanceof HTMLElement && el.isContentEditable;
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
  const [showTags, setShowTags] = useState<boolean>(() => readFlag(SHOW_TAGS_KEY, true));
  const [sidebarOpen, setSidebarOpen] = useState<boolean>(() => readFlag(SIDEBAR_KEY, true));
  const [query, setQuery] = useState("");
  const [matchIndex, setMatchIndex] = useState(0);
  const [searching, setSearching] = useState(false);
  const [searchExhausted, setSearchExhausted] = useState(false);
  const [toast, setToast] = useState<ToastState | null>(null);
  const [remoteUrl, setRemoteUrl] = useState<string | null>(null);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [layout, setLayout] = useState<LayoutWidths>(readLayout);
  const [dateMode, setDateMode] = useState<DateMode>(readDateMode);
  /** upstream 대비 ahead/behind + stash 개수 (툴바 배지) */
  const [syncState, setSyncState] = useState<SyncState | null>(null);
  /** 실행 중인 쓰기 작업 id. null이 아니면 모든 작업 버튼을 잠근다 */
  const [busyOp, setBusyOp] = useState<string | null>(null);
  const [conflicts, setConflicts] = useState<string[]>([]);
  const [dialog, setDialog] = useState<DialogState | null>(null);
  /** 스태시 다이얼로그의 "Include untracked" 체크 상태 */
  const [stashUntracked, setStashUntracked] = useState(true);
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
  /** 쓰기 작업 동시 실행 잠금. setBusyOp보다 먼저 보이는 값이 필요하다 */
  const busyRef = useRef<string | null>(null);
  /** 다이얼로그를 연 시점이 아니라 확인을 누른 시점의 체크 상태를 읽는다 */
  const stashUntrackedRef = useRef(true);
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

  const data: GraphData = graph ?? EMPTY_GRAPH;
  stashUntrackedRef.current = stashUntracked;
  activeRef.current = active;
  rowCount.current = data.rows.length;
  loadingRef.current = graphLoading;
  wipRef.current = data.wip;

  const showToast = useCallback(
    (
      message: string,
      tone: "error" | "info",
      options?: { durationMs?: number; copyable?: boolean },
    ) => {
      toastSeq.current += 1;
      setToast({ id: toastSeq.current, message, tone, ...options });
    },
    [],
  );

  /** git stderr는 원문 그대로, 길게, 복사 가능하게 보여준다 */
  const showOpError = useCallback(
    (message: string) => showToast(message, "error", { durationMs: OP_ERROR_MS, copyable: true }),
    [showToast],
  );

  const showError = useCallback(
    (message: string) => showToast(message, "error"),
    [showToast],
  );

  const dismissToast = useCallback(() => setToast(null), []);

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

  const loadSyncState = useCallback(() => {
    if (repo === null) {
      return;
    }
    getSyncState(repo.path)
      .then((state) => setSyncState(state))
      .catch(() => {
        // upstream이 없거나 조회에 실패하면 배지를 숨긴다
        setSyncState(null);
      });
  }, [repo]);

  // 레포를 열거나 새로고침할 때마다 ↑↓ 배지를 다시 읽는다
  useEffect(() => {
    if (repo === null) {
      setSyncState(null);
      return;
    }
    loadSyncState();
  }, [repo, reloadKey, loadSyncState]);

  /** refs 지문/wip이 바뀌었으면 전체 리로드. 폴링과 탭 전환이 함께 쓴다 */
  const checkRepoState = useCallback(() => {
    if (repo === null || loadingRef.current || graphToken.current === "") {
      return;
    }
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
  }, [repo, reloadFromStart]);

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
      // ↑↓ 배지는 원격이 움직이면 바뀌므로 폴링 주기마다 다시 읽는다
      loadSyncState();
    }, POLL_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [repo, active, checkRepoState, loadSyncState]);

  // 비활성 탭은 폴링하지 않으므로, 활성화되는 순간 한 번 확인한다
  useEffect(() => {
    if (!active) {
      return;
    }
    checkRepoState();
  }, [active, checkRepoState]);

  // ── 쓰기 작업 (v0.15) ────────────────────────────────────────────

  const closeDialog = useCallback(() => setDialog(null), []);

  /**
   * 쓰기 작업 공통 실행기. 한 번에 하나만 돌리고, 끝나면 그래프/refs/배지를 갱신한다.
   * git이 실패해도 예외가 아니라 ok=false로 오므로 stderr를 그대로 보여준다.
   */
  const runOp = useCallback(
    async (id: string, label: string, run: (path: string) => Promise<OpResult>) => {
      if (repo === null || busyRef.current !== null) {
        return;
      }
      busyRef.current = id;
      setBusyOp(id);
      try {
        const result = await run(repo.path);
        setConflicts(result.conflicts);
        if (result.ok) {
          showToast(summarizeOp(result, label), "info");
        } else {
          const detail = (result.stderr.trim() || result.stdout.trim()) === ""
            ? "git이 실패했습니다."
            : (result.stderr.trim() || result.stdout.trim());
          const hint = /non-fast-forward|rejected|fetch first/i.test(result.stderr)
            ? "\n\nPull 후 다시 시도하세요."
            : "";
          showOpError(`${label} 실패\n${detail}${hint}`);
        }
      } catch (err) {
        showOpError(`${label} 실패\n${errorMessage(err)}`);
      } finally {
        busyRef.current = null;
        setBusyOp(null);
        reloadFromStart();
        loadSyncState();
      }
    },
    [repo, showToast, showOpError, reloadFromStart, loadSyncState],
  );

  const validateBranchName = useCallback(
    (value: string): string | null => {
      const name = value.trim();
      if (name === "") {
        return "이름을 입력하세요.";
      }
      if (/\s/.test(name)) {
        return "공백은 쓸 수 없습니다.";
      }
      if (name.includes("..")) {
        return '".."는 쓸 수 없습니다.';
      }
      if (name.startsWith("-")) {
        return '"-"로 시작할 수 없습니다.';
      }
      if (refs.some((entry) => entry.kind === "localBranch" && entry.name === name)) {
        return "이미 있는 브랜치입니다.";
      }
      return null;
    },
    [refs],
  );

  /** startPoint가 null이면 현재 HEAD에서 만든다 */
  const promptNewBranch = useCallback(
    (startPoint: string | null) => {
      setDialog({
        kind: "prompt",
        title: startPoint === null ? "New branch" : `New branch from ${startPoint}`,
        label: "Branch name",
        placeholder: "feat/my-change",
        confirmLabel: "Create",
        validate: validateBranchName,
        onSubmit: (value) => {
          const name = value.trim();
          void runOp("branch", `Create branch ${name}`, (path) =>
            gitCreateBranch(path, name, startPoint, true),
          );
        },
      });
    },
    [validateBranchName, runOp],
  );

  const handleFetch = useCallback(
    (prune: boolean) => {
      void runOp("fetch", prune ? "Fetch & prune" : "Fetch", (path) =>
        gitFetch(path, null, prune),
      );
    },
    [runOp],
  );

  const handlePull = useCallback(
    (mode: PullMode) => {
      const start = () => {
        void runOp("pull", `Pull (${mode})`, (path) => gitPull(path, mode));
      };
      if (mode === "ff-only") {
        start();
        return;
      }
      setDialog({
        kind: "confirm",
        title: mode === "merge" ? "Pull (merge)" : "Pull (rebase)",
        body:
          mode === "merge"
            ? "원격 변경을 현재 브랜치에 머지합니다. 충돌이 날 수 있습니다."
            : "현재 브랜치를 원격 위로 리베이스합니다. 충돌이 날 수 있습니다.",
        confirmLabel: "Pull",
        onConfirm: start,
      });
    },
    [runOp],
  );

  const handlePush = useCallback(() => {
    if (repo === null) {
      return;
    }
    const branch = syncState?.branch ?? repo.headBranch;
    const upstream = syncState?.upstream ?? null;
    const ahead = syncState?.ahead ?? 0;
    const setUpstream = upstream === null;
    setDialog({
      kind: "confirm",
      title: "Push",
      body: setUpstream
        ? `upstream이 없습니다. origin/${branch}에 upstream을 설정하며 푸시합니다.`
        : `${upstream}으로 커밋 ${ahead}개를 푸시합니다.`,
      confirmLabel: "Push",
      onConfirm: () => {
        void runOp("push", "Push", (path) => gitPush(path, setUpstream, false));
      },
    });
  }, [repo, syncState, runOp]);

  const handleStash = useCallback(() => {
    setDialog({
      kind: "prompt",
      title: "Stash changes",
      label: "Message (선택)",
      placeholder: "WIP",
      confirmLabel: "Stash",
      extra: "untracked",
      onSubmit: (value) => {
        const message = value.trim();
        const untracked = stashUntrackedRef.current;
        void runOp("stash", "Stash", (path) =>
          gitStashPush(path, message === "" ? null : message, untracked),
        );
      },
    });
  }, [runOp]);

  const handleStashPop = useCallback(() => {
    setDialog({
      kind: "confirm",
      title: "Pop stash",
      body: "가장 최근 스태시를 워킹 트리에 적용합니다. 충돌이 날 수 있습니다.",
      confirmLabel: "Pop",
      onConfirm: () => {
        void runOp("pop", "Stash pop", (path) => gitStashPop(path));
      },
    });
  }, [runOp]);

  const handleCheckout = useCallback(
    (target: string) => {
      void runOp("checkout", `Checkout ${target}`, (path) => gitCheckout(path, target));
    },
    [runOp],
  );

  const handleOpenTerminal = useCallback(() => {
    if (repo === null) {
      return;
    }
    openInTerminal(repo.path).catch((err: unknown) => showError(errorMessage(err)));
  }, [repo, showError]);

  /**
   * 브랜치 삭제. 미머지라 실패하면 stderr를 보여주고 강제 삭제를 한 번 더 확인한다.
   * 재귀 호출이 있어 useCallback 대신 일반 함수로 둔다 (다이얼로그 콜백이 호출 시점에 잡는다)
   */
  async function deleteBranch(name: string, force: boolean): Promise<void> {
    if (repo === null || busyRef.current !== null) {
      return;
    }
    busyRef.current = "delete";
    setBusyOp("delete");
    try {
      const result = await gitDeleteBranch(repo.path, name, force);
      if (result.ok) {
        showToast(summarizeOp(result, `Delete ${name}`), "info");
        return;
      }
      showOpError(`브랜치 삭제 실패\n${(result.stderr.trim() || result.stdout.trim())}`);
      if (!force) {
        setDialog({
          kind: "confirm",
          danger: true,
          title: "강제 삭제",
          body: `${name}은 아직 머지되지 않았습니다. 강제로 삭제하면 되돌릴 수 없습니다.`,
          confirmLabel: "강제 삭제",
          onConfirm: () => {
            void deleteBranch(name, true);
          },
        });
      }
    } catch (err) {
      showOpError(`브랜치 삭제 실패\n${errorMessage(err)}`);
    } finally {
      busyRef.current = null;
      setBusyOp(null);
      reloadFromStart();
      loadSyncState();
    }
  }

  const confirmDeleteBranch = useCallback((entry: RefEntry) => {
    setDialog({
      kind: "confirm",
      danger: true,
      title: "Delete branch",
      body: `로컬 브랜치 ${entry.name}을 삭제합니다.`,
      confirmLabel: "Delete",
      onConfirm: () => {
        void deleteBranch(entry.name, false);
      },
    });
    // deleteBranch는 렌더마다 새로 만들어지지만 호출은 확인 버튼을 누른 시점에 일어난다
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const confirmMerge = useCallback(
    (entry: RefEntry) => {
      setDialog({
        kind: "confirm",
        title: "Merge",
        body: `${entry.name}을 현재 브랜치로 머지합니다. 충돌이 날 수 있습니다.`,
        confirmLabel: "Merge",
        onConfirm: () => {
          void runOp("merge", `Merge ${entry.name}`, (path) => gitMerge(path, entry.name));
        },
      });
    },
    [runOp],
  );

  const handlePushBranch = useCallback(
    (entry: RefEntry) => {
      if (entry.isHead) {
        handlePush();
        return;
      }
      showToast(`${entry.name}을 체크아웃한 뒤 푸시하세요.`, "info");
    },
    [handlePush, showToast],
  );

  const dismissConflicts = useCallback(() => setConflicts([]), []);

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
    return [
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
      {
        label: "Open in Terminal",
        onSelect: () => {
          openInTerminal(path).catch((err: unknown) => showError(errorMessage(err)));
        },
      },
    ];
  }, [repo, showToast, showError]);

  const menuItems: MenuItem[] = useMemo(() => {
    if (menu === null) {
      return [];
    }
    if (menu.kind === "repo") {
      return copyPathItems;
    }
    const sha = menu.sha;
    const items: MenuItem[] = [
      { label: "Copy sha", onSelect: () => copySha(sha) },
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
    ];
    const row = data.rows.find((r) => r.sha === sha);
    if (row !== undefined) {
      items.push({
        label: "Create branch here…",
        separatorBefore: true,
        disabled: busyOp !== null,
        onSelect: () => promptNewBranch(sha),
      });
      for (const ref of row.refs) {
        if (ref.kind === "localBranch" && !ref.isHead) {
          items.push({
            label: `Checkout ${ref.name}`,
            disabled: busyOp !== null,
            onSelect: () => handleCheckout(ref.name),
          });
        }
      }
    }
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
    busyOp,
    promptNewBranch,
    handleCheckout,
  ]);

  const handleToggleTags = useCallback(() => {
    setShowTags((prev) => {
      writeFlag(SHOW_TAGS_KEY, !prev);
      return !prev;
    });
  }, []);

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

  const handleToggleDateMode = useCallback(() => {
    setDateMode((prev) => {
      const next: DateMode = prev === "absolute" ? "relative" : "absolute";
      try {
        localStorage.setItem(DATE_MODE_KEY, next);
      } catch {
        // 저장 실패는 무시 (이번 세션에만 적용)
      }
      return next;
    });
  }, []);

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
        if (handleEscape()) {
          event.preventDefault();
        }
        return;
      }
      if (repo === null || (!event.metaKey && !event.ctrlKey)) {
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
        if (event.code === "KeyF") {
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

  const toastNode =
    toast === null ? null : (
      <Toast
        key={toast.id}
        message={toast.message}
        tone={toast.tone}
        durationMs={toast.durationMs}
        copyable={toast.copyable}
        onClose={dismissToast}
      />
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
        sidebarOpen={sidebarOpen}
        onToggleSidebar={handleToggleSidebar}
        onGoToHead={goToHead}
        syncState={syncState}
        busyOp={busyOp}
        onFetch={handleFetch}
        onPull={handlePull}
        onPush={handlePush}
        onNewBranch={() => promptNewBranch(null)}
        onStash={handleStash}
        onStashPop={handleStashPop}
        onOpenTerminal={handleOpenTerminal}
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
        showTags={showTags}
        onToggleTags={handleToggleTags}
        onRefresh={reloadFromStart}
        updateTag={update.tag}
        onOpenRelease={update.onOpenRelease}
        appVersion={APP_VERSION}
        checkingUpdate={update.checking}
        onCheckUpdates={update.onCheck}
      />
      {banner}
      {conflicts.length > 0 && (
        <ConflictBanner files={conflicts} onDismiss={dismissConflicts} onOpenWip={selectWip} />
      )}
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
              loading={refsLoading}
              selectedSha={selectedSha}
              onSelectRef={handleSelectRef}
              onCopyRefName={handleCopyRefName}
              onOpenRefOnRemote={remoteUrl === null ? undefined : handleOpenRefOnRemote}
              filterInputRef={sidebarFilterRef}
              syncState={syncState ?? undefined}
              onCheckout={(entry) => handleCheckout(entry.name)}
              onCreateBranchFrom={(entry) => promptNewBranch(entry.name)}
              onDeleteBranch={confirmDeleteBranch}
              onMergeIntoCurrent={confirmMerge}
              onPushBranch={handlePushBranch}
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
              selectedSha={selectedSha}
              onSelect={setSelectedSha}
              onLoadMore={handleLoadMore}
              loading={graphLoading}
              showTags={showTags}
              scrollTarget={scrollTarget}
              onRowDoubleClick={copySha}
              onRowContextMenu={handleRowContextMenu}
              onSelectWip={selectWip}
              highlightQuery={query}
              dateMode={dateMode}
              onToggleDateMode={handleToggleDateMode}
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

      <footer className="statusbar">
        <span>
          {formatCount(data.totalLoaded)} commits{data.hasMore ? "+" : ""}
        </span>
        <span>HEAD {shortSha(repo.headSha)}</span>
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

      {dialog !== null && dialog.kind === "confirm" && (
        <ConfirmDialog
          open
          title={dialog.title}
          body={dialog.body}
          confirmLabel={dialog.confirmLabel}
          danger={dialog.danger}
          onConfirm={() => {
            const run = dialog.onConfirm;
            setDialog(null);
            run();
          }}
          onCancel={closeDialog}
        />
      )}
      {dialog !== null && dialog.kind === "prompt" && (
        <PromptDialog
          open
          title={dialog.title}
          label={dialog.label}
          placeholder={dialog.placeholder}
          defaultValue={dialog.defaultValue}
          validate={dialog.validate}
          confirmLabel={dialog.confirmLabel}
          extra={
            dialog.extra !== "untracked" ? undefined : (
              <label className="dlg-check-row">
                <input
                  type="checkbox"
                  checked={stashUntracked}
                  onChange={(e) => setStashUntracked(e.currentTarget.checked)}
                />
                Include untracked files
              </label>
            )
          }
          onSubmit={(value: string) => {
            const run = dialog.onSubmit;
            setDialog(null);
            run(value);
          }}
          onCancel={closeDialog}
        />
      )}

      <QuickSwitcher
        open={quickOpen}
        refs={refs}
        onSelect={handleQuickSelect}
        onClose={closeQuickSwitcher}
      />

      {toastNode}
    </div>
  );
}
