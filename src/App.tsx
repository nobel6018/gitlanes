import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { GraphView } from "./graph";
import { COMMITS_PER_PAGE } from "./constants";
import type { GraphData, RefEntry, RepoInfo, SearchMatch, WipInfo } from "./types";
import {
  errorMessage,
  getRepoState,
  getStartupRepo,
  listRefs,
  loadGraph,
  openRepo,
  searchCommits,
} from "./shell/api";
import { copyText } from "./shell/clipboard";
import { BranchSidebar } from "./shell/BranchSidebar";
import { CommitDetailPanel } from "./shell/CommitDetailPanel";
import { SearchBox } from "./shell/SearchBox";
import { Toast } from "./shell/Toast";
import { Toolbar } from "./shell/Toolbar";
import { WelcomeScreen } from "./shell/WelcomeScreen";
import { useRecentRepos } from "./shell/useRecentRepos";
import { formatCount, shortSha } from "./shell/format";
import "./shell/shell.css";

const SHOW_TAGS_KEY = "gitlanes.showTags";
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
}

/** nonce가 바뀔 때마다 GraphView가 해당 행을 뷰포트 중앙으로 스크롤한다 */
interface ScrollTarget {
  sha: string;
  nonce: number;
}

export default function App() {
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
  const [booting, setBooting] = useState(true);

  const { recents, addRecent, removeRecent } = useRecentRepos();
  const toastSeq = useRef(0);
  const graphReq = useRef(0);
  const graphToken = useRef("");
  const refsReq = useRef(0);
  const scrollSeq = useRef(0);
  const startupDone = useRef(false);
  const lastQuery = useRef("");
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  /** query -> search_commits 결과. Enter 연타에 재호출하지 않는다 */
  const searchCache = useRef(new Map<string, SearchMatch[]>());
  /** append 완료 후 점프할 sha */
  const pendingJump = useRef<string | null>(null);
  const rowCount = useRef(0);
  const loadingRef = useRef(false);
  const wipRef = useRef<WipInfo | null>(null);

  const data: GraphData = graph ?? EMPTY_GRAPH;
  rowCount.current = data.rows.length;
  loadingRef.current = graphLoading;
  wipRef.current = data.wip;

  const showToast = useCallback((message: string, tone: "error" | "info") => {
    toastSeq.current += 1;
    setToast({ id: toastSeq.current, message, tone });
  }, []);

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
        pendingJump.current = null;
        setGraph(null);
        setRefs([]);
        setPage(FIRST_PAGE);
        graphToken.current = "";
        setRepo(info);
      } catch (err) {
        showError(errorMessage(err));
      } finally {
        setOpening(false);
      }
    },
    [addRecent, showError],
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

  // 시작 레포(CLI 인자/환경변수)를 마운트 시 1회만 확인한다.
  // ref 가드로 StrictMode 이중 실행에서도 open_repo가 두 번 나가지 않는다.
  useEffect(() => {
    if (startupDone.current) {
      return;
    }
    startupDone.current = true;
    getStartupRepo()
      .then((path) => {
        if (path !== null && path !== "") {
          return openPath(path);
        }
        return undefined;
      })
      .catch((err: unknown) => {
        showError(errorMessage(err));
      })
      .finally(() => {
        setBooting(false);
      });
  }, [openPath, showError]);

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
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "f") {
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

  // 자동 새로고침: 창이 포커스+가시 상태이고 로딩 중이 아닐 때만 5초마다 경량 폴링
  useEffect(() => {
    if (repo === null) {
      return;
    }
    const path = repo.path;
    const timer = window.setInterval(() => {
      if (!document.hasFocus() || document.visibilityState !== "visible") {
        return;
      }
      if (loadingRef.current) {
        return;
      }
      getRepoState(path)
        .then((state) => {
          if (state.graphToken !== graphToken.current || !sameWip(state.wip, wipRef.current)) {
            searchCache.current.clear();
            reloadFromStart();
          }
        })
        .catch(() => {
          // 폴링 실패는 조용히 넘긴다. 다음 주기에 다시 시도한다
        });
    }, POLL_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [repo, reloadFromStart]);

  /** 그래프 행 더블클릭 시 그 행의 sha를 복사한다 */
  const handleRowDoubleClick = useCallback(
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

  const handleToggleTags = useCallback(() => {
    setShowTags((prev) => {
      writeFlag(SHOW_TAGS_KEY, !prev);
      return !prev;
    });
  }, []);

  const handleToggleSidebar = useCallback(() => {
    setSidebarOpen((prev) => {
      writeFlag(SIDEBAR_KEY, !prev);
      return !prev;
    });
  }, []);

  const toastNode =
    toast === null ? null : (
      <Toast key={toast.id} message={toast.message} tone={toast.tone} onClose={dismissToast} />
    );

  if (repo === null && booting) {
    return (
      <div className="app">
        <div className="welcome">
          <div className="panel-empty">Loading…</div>
        </div>
        {toastNode}
      </div>
    );
  }

  if (repo === null) {
    return (
      <div className="app">
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
    <div className="app">
      <Toolbar
        repo={repo}
        sidebarOpen={sidebarOpen}
        onToggleSidebar={handleToggleSidebar}
        search={
          <SearchBox
            query={query}
            matchCount={matches.length}
            matchPosition={matches.length === 0 ? 0 : matchIndex + 1}
            searching={searching}
            exhausted={searchExhausted}
            inputRef={searchInputRef}
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
        onOpen={handleBrowse}
        onRefresh={reloadFromStart}
      />
      {graphLoading && <div className="progress" role="progressbar" aria-label="Loading graph" />}

      <div className="main">
        {sidebarOpen && (
          <BranchSidebar
            refs={refs}
            loading={refsLoading}
            selectedSha={selectedSha}
            onSelectRef={handleSelectRef}
          />
        )}
        <div className="graph-area">
          <GraphView
            data={data}
            selectedSha={selectedSha}
            onSelect={setSelectedSha}
            onLoadMore={handleLoadMore}
            loading={graphLoading}
            showTags={showTags}
            scrollTarget={scrollTarget}
            onRowDoubleClick={handleRowDoubleClick}
          />
        </div>
        {selectedSha !== null && (
          <CommitDetailPanel
            key={selectedSha}
            repoPath={repo.path}
            sha={selectedSha}
            isStash={data.stashes.some((stash) => stash.sha === selectedSha)}
            onSelectSha={setSelectedSha}
            onError={showError}
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

      {toastNode}
    </div>
  );
}
