import { useCallback, useEffect, useRef, useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { GraphView } from "./graph";
import { COMMITS_PER_PAGE } from "./constants";
import type { GraphData, RepoInfo } from "./types";
import { errorMessage, loadGraph, openRepo } from "./shell/api";
import { CommitDetailPanel } from "./shell/CommitDetailPanel";
import { Toast } from "./shell/Toast";
import { Toolbar } from "./shell/Toolbar";
import { WelcomeScreen } from "./shell/WelcomeScreen";
import { useRecentRepos } from "./shell/useRecentRepos";
import { formatCount, shortSha } from "./shell/format";
import "./shell/shell.css";

const SHOW_TAGS_KEY = "gitlanes.showTags";

function readShowTags(): boolean {
  try {
    return localStorage.getItem(SHOW_TAGS_KEY) !== "0";
  } catch {
    return true;
  }
}

interface ToastState {
  id: number;
  message: string;
}

export default function App() {
  const [repo, setRepo] = useState<RepoInfo | null>(null);
  const [graph, setGraph] = useState<GraphData | null>(null);
  const [limit, setLimit] = useState(COMMITS_PER_PAGE);
  const [reloadKey, setReloadKey] = useState(0);
  const [graphLoading, setGraphLoading] = useState(false);
  const [opening, setOpening] = useState(false);
  const [selectedSha, setSelectedSha] = useState<string | null>(null);
  const [showTags, setShowTags] = useState<boolean>(readShowTags);
  const [toast, setToast] = useState<ToastState | null>(null);

  const { recents, addRecent, removeRecent } = useRecentRepos();
  const toastSeq = useRef(0);
  const graphReq = useRef(0);

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
      .then((data) => {
        if (graphReq.current === reqId) {
          setGraph(data);
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

  const openPath = useCallback(
    async (path: string) => {
      setOpening(true);
      try {
        const info = await openRepo(path);
        addRecent(info.path);
        setSelectedSha(null);
        setGraph(null);
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

  const handleLoadMore = useCallback(() => {
    if (graphLoading) {
      return;
    }
    setLimit((prev) => prev + COMMITS_PER_PAGE);
  }, [graphLoading]);

  const handleRefresh = useCallback(() => setReloadKey((k) => k + 1), []);

  const handleToggleTags = useCallback(() => {
    setShowTags((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(SHOW_TAGS_KEY, next ? "1" : "0");
      } catch {
        // localStorage 실패는 무시 (설정만 휘발)
      }
      return next;
    });
  }, []);

  const toastNode =
    toast === null ? null : <Toast key={toast.id} message={toast.message} onClose={dismissToast} />;

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

  const data: GraphData = graph ?? { rows: [], totalLoaded: 0, hasMore: false, laneCount: 0 };

  return (
    <div className="app">
      <Toolbar
        repo={repo}
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
        <div className="graph-area">
          <GraphView
            data={data}
            selectedSha={selectedSha}
            onSelect={setSelectedSha}
            onLoadMore={handleLoadMore}
            loading={graphLoading}
            showTags={showTags}
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
        {graphLoading && <span>Loading…</span>}
        <span className="sb-path" title={repo.path}>
          {repo.path}
        </span>
      </footer>

      {toastNode}
    </div>
  );
}
