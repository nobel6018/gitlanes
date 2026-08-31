import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { GraphView } from "./graph";
import { COMMITS_PER_PAGE } from "./constants";
import type { GraphData, RefEntry, RepoInfo } from "./types";
import { errorMessage, getStartupRepo, listRefs, loadGraph, openRepo } from "./shell/api";
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
};

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
  const [limit, setLimit] = useState(COMMITS_PER_PAGE);
  const [reloadKey, setReloadKey] = useState(0);
  const [graphLoading, setGraphLoading] = useState(false);
  const [opening, setOpening] = useState(false);
  const [selectedSha, setSelectedSha] = useState<string | null>(null);
  const [scrollTarget, setScrollTarget] = useState<ScrollTarget | null>(null);
  const [showTags, setShowTags] = useState<boolean>(() => readFlag(SHOW_TAGS_KEY, true));
  const [sidebarOpen, setSidebarOpen] = useState<boolean>(() => readFlag(SIDEBAR_KEY, true));
  const [query, setQuery] = useState("");
  const [matchIndex, setMatchIndex] = useState(0);
  const [toast, setToast] = useState<ToastState | null>(null);
  const [booting, setBooting] = useState(true);

  const { recents, addRecent, removeRecent } = useRecentRepos();
  const toastSeq = useRef(0);
  const graphReq = useRef(0);
  const refsReq = useRef(0);
  const scrollSeq = useRef(0);
  const startupDone = useRef(false);
  const lastQuery = useRef("");
  const searchInputRef = useRef<HTMLInputElement | null>(null);

  const data: GraphData = graph ?? EMPTY_GRAPH;

  const showError = useCallback((message: string) => {
    toastSeq.current += 1;
    setToast({ id: toastSeq.current, message });
  }, []);

  const dismissToast = useCallback(() => setToast(null), []);

  // 레포/limit/새로고침 키가 바뀌면 그래프를 다시 가져온다.
  // graphReq로 뒤늦게 도착한 이전 요청 응답을 버린다.
  useEffect(() => {
    if (repo === null) {
      setGraph(null);
      return;
    }
    const reqId = graphReq.current + 1;
    graphReq.current = reqId;
    setGraphLoading(true);
    loadGraph(repo.path, limit)
      .then((loaded) => {
        if (graphReq.current === reqId) {
          setGraph(loaded);
        }
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
  }, [repo, limit, reloadKey, showError]);

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
        setGraph(null);
        setRefs([]);
        setLimit(COMMITS_PER_PAGE);
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
    if (matches.length > 0) {
      jumpTo(matches[0]);
    }
  }, [query, matches, jumpTo]);

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

  const handleNextMatch = useCallback(() => gotoMatch(matchIndex + 1), [gotoMatch, matchIndex]);
  const handlePrevMatch = useCallback(() => gotoMatch(matchIndex - 1), [gotoMatch, matchIndex]);

  const handleClearSearch = useCallback(() => {
    setQuery("");
    setMatchIndex(0);
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
    if (graphLoading) {
      return;
    }
    setLimit((prev) => prev + COMMITS_PER_PAGE);
  }, [graphLoading]);

  const handleRefresh = useCallback(() => setReloadKey((k) => k + 1), []);

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
    toast === null ? null : <Toast key={toast.id} message={toast.message} onClose={dismissToast} />;

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
        onRefresh={handleRefresh}
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
          />
        </div>
        {selectedSha !== null && (
          <CommitDetailPanel
            key={selectedSha}
            repoPath={repo.path}
            sha={selectedSha}
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
