// 하단 내장 터미널. xterm.js + rust-core의 PTY(term_* command).
// 계약: CONTRACTS.md v0.16 "내장 터미널". repoPath당 PTY 1개를 유지하고,
// visible=false에서도 언마운트하지 않는다(display:none) — 스크롤백과 셸 상태를 살려둔다.
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import type { ITheme } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { UnlistenFn } from "@tauri-apps/api/event";
import { LANE_COLORS } from "../constants";
import "@xterm/xterm/css/xterm.css";
import "./terminal.css";

export interface TerminalProps {
  repoPath: string;
  visible: boolean;
  onClose: () => void;
}

type Status = "idle" | "opening" | "ready" | "exited" | "unavailable";

/** PTY가 열린 직후의 출력이 listen 등록 전에 지나갔을 때 프롬프트를 다시 그리게 하는 대기시간(ms) */
const PROMPT_NUDGE_MS = 400;

/** xterm은 CSS 변수를 못 받는다. 컨테이너에서 실제 색을 읽어 ITheme으로 넘긴다 */
function readTheme(host: HTMLElement): ITheme {
  const style = getComputedStyle(host);
  const read = (name: string, fallback: string) => style.getPropertyValue(name).trim() || fallback;
  const bg = read("--bg-content", "#1C1E23");
  const fg = read("--fg-1", "#D0D3D9");
  const accent = read("--accent", "#3D6DA8");
  const red = read("--deleted", "#DE7373");
  const green = read("--added", "#54C08A");
  const yellow = read("--modified", "#D4B455");
  return {
    background: bg,
    foreground: fg,
    cursor: accent,
    cursorAccent: bg,
    selectionBackground: "rgba(61, 109, 168, 0.45)",
    black: bg,
    red,
    green,
    yellow,
    blue: LANE_COLORS[4],
    magenta: LANE_COLORS[6],
    cyan: LANE_COLORS[0],
    white: fg,
    brightBlack: read("--fg-2", "#93979F"),
    brightRed: "#E88A8A",
    brightGreen: "#6FD3A2",
    brightYellow: "#E5C86B",
    brightBlue: "#93AEEB",
    brightMagenta: "#C4A6E8",
    brightCyan: "#6CCBEB",
    brightWhite: "#F0F2F5",
  };
}

export function Terminal({ repoPath, visible, onClose }: TerminalProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<XTerm | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const idRef = useRef<string | null>(null);
  const unlistenRef = useRef<UnlistenFn[]>([]);
  const openingRef = useRef(false);
  const disposedRef = useRef(false);
  const exitedRef = useRef(false);
  const sawDataRef = useRef(false);
  const nudgeRef = useRef<number | null>(null);
  const [status, setStatus] = useState<Status>("idle");

  /** 현재 세션의 이벤트 구독을 모두 해제한다 */
  const dropListeners = useCallback(() => {
    for (const unlisten of unlistenRef.current) {
      unlisten();
    }
    unlistenRef.current = [];
  }, []);

  const closeSession = useCallback(() => {
    dropListeners();
    if (nudgeRef.current !== null) {
      window.clearTimeout(nudgeRef.current);
      nudgeRef.current = null;
    }
    const id = idRef.current;
    idRef.current = null;
    if (id !== null) {
      // 실패해도 할 수 있는 게 없다 (앱 종료 시 rust가 전부 kill 한다)
      void invoke("term_close", { id }).catch(() => undefined);
    }
  }, [dropListeners]);

  const openSession = useCallback(async () => {
    const term = termRef.current;
    if (term === null || openingRef.current || idRef.current !== null) {
      return;
    }
    openingRef.current = true;
    exitedRef.current = false;
    sawDataRef.current = false;
    setStatus("opening");
    try {
      fitRef.current?.fit();
      const id = await invoke<string>("term_open", {
        path: repoPath,
        cols: term.cols,
        rows: term.rows,
      });
      if (disposedRef.current) {
        void invoke("term_close", { id }).catch(() => undefined);
        return;
      }
      idRef.current = id;
      const onData = await listen<string>(`term:data:${id}`, (event) => {
        sawDataRef.current = true;
        termRef.current?.write(event.payload);
      });
      const onExit = await listen<number>(`term:exit:${id}`, (event) => {
        exitedRef.current = true;
        dropListeners();
        idRef.current = null;
        setStatus("exited");
        termRef.current?.write(
          `\r\n\x1b[2m[process exited: ${event.payload}] press Enter to restart\x1b[0m\r\n`,
        );
      });
      if (disposedRef.current) {
        onData();
        onExit();
        void invoke("term_close", { id }).catch(() => undefined);
        return;
      }
      unlistenRef.current.push(onData, onExit);
      setStatus("ready");
      // listen 등록 전에 첫 프롬프트가 지나갔을 수 있다. 아무 출력도 없으면 Enter로 한 번 깨운다
      nudgeRef.current = window.setTimeout(() => {
        nudgeRef.current = null;
        if (!sawDataRef.current && idRef.current !== null) {
          void invoke("term_write", { id: idRef.current, data: "\r" }).catch(() => undefined);
        }
      }, PROMPT_NUDGE_MS);
    } catch {
      // 하네스(비Tauri)에는 term_open이 없다
      if (!disposedRef.current) {
        setStatus("unavailable");
      }
    } finally {
      openingRef.current = false;
    }
  }, [repoPath, dropListeners]);

  // 최신 콜백을 ref로 들고 있어 xterm 인스턴스 생성 효과의 의존성을 비워 둔다
  // (repoPath가 바뀌어도 인스턴스는 유지하고 세션만 갈아 끼운다)
  const openRef = useRef(openSession);
  openRef.current = openSession;
  const closeRef = useRef(closeSession);
  closeRef.current = closeSession;

  // xterm 인스턴스는 마운트당 하나. 세션이 바뀌어도 재사용한다
  useLayoutEffect(() => {
    const host = hostRef.current;
    if (host === null) {
      return;
    }
    disposedRef.current = false;
    const term = new XTerm({
      fontFamily: 'ui-monospace, "SF Mono", SFMono-Regular, Menlo, Consolas, monospace',
      fontSize: 12.5,
      lineHeight: 1.2,
      cursorBlink: true,
      scrollback: 5000,
      allowProposedApi: true,
      theme: readTheme(host),
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.loadAddon(new WebLinksAddon());
    term.open(host);
    termRef.current = term;
    fitRef.current = fit;

    term.onData((data) => {
      const id = idRef.current;
      if (id === null) {
        // 종료된 세션에서 Enter를 누르면 새 세션을 연다
        if (exitedRef.current && (data === "\r" || data === "\n")) {
          term.reset();
          void openRef.current();
        }
        return;
      }
      void invoke("term_write", { id, data }).catch(() => undefined);
    });

    term.onResize(({ cols, rows }) => {
      const id = idRef.current;
      if (id !== null) {
        void invoke("term_resize", { id, cols, rows }).catch(() => undefined);
      }
    });

    return () => {
      disposedRef.current = true;
      closeRef.current();
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
  }, []);

  // 컨테이너 크기 변화 → fit (fit이 term.onResize를 거쳐 term_resize를 보낸다)
  useEffect(() => {
    const host = hostRef.current;
    if (host === null || typeof ResizeObserver === "undefined") {
      return;
    }
    const observer = new ResizeObserver(() => {
      if (host.clientHeight > 0 && host.clientWidth > 0) {
        try {
          fitRef.current?.fit();
        } catch {
          // 숨겨진 동안의 fit 실패는 무시
        }
      }
    });
    observer.observe(host);
    return () => observer.disconnect();
  }, []);

  // 보이게 되면 세션을 열고(없으면) 크기를 맞춘 뒤 포커스
  useEffect(() => {
    if (!visible) {
      return;
    }
    if (idRef.current === null && status !== "opening" && status !== "unavailable") {
      void openSession();
    }
    const raf = requestAnimationFrame(() => {
      try {
        fitRef.current?.fit();
      } catch {
        // 무시
      }
      termRef.current?.focus();
    });
    return () => cancelAnimationFrame(raf);
  }, [visible, status, openSession]);

  // repoPath가 바뀌면 이전 PTY는 버린다 (repoPath당 1개)
  const pathRef = useRef(repoPath);
  useEffect(() => {
    if (pathRef.current === repoPath) {
      return;
    }
    pathRef.current = repoPath;
    closeSession();
    termRef.current?.reset();
    setStatus("idle");
  }, [repoPath, closeSession]);

  // 터미널이 포커스를 가진 동안의 키 입력이 셸 전역 단축키로 새지 않게 한다.
  // ⌘ 조합과 터미널 토글(⌃`)만 통과시킨다
  useEffect(() => {
    const host = hostRef.current;
    if (host === null) {
      return;
    }
    const guard = (event: KeyboardEvent) => {
      if (event.metaKey) {
        return;
      }
      if (event.ctrlKey && event.key === "`") {
        return;
      }
      event.stopPropagation();
    };
    host.addEventListener("keydown", guard, true);
    return () => host.removeEventListener("keydown", guard, true);
  }, []);

  return (
    <div className="term-root" style={visible ? undefined : { display: "none" }}>
      <div className="term-head">
        <span className="term-label">Terminal</span>
        <span className="term-path mono" title={repoPath}>
          {repoPath}
        </span>
        {status === "exited" && <span className="term-note">exited</span>}
        <button className="term-close" onClick={onClose} title="Close terminal" aria-label="Close terminal">
          ×
        </button>
      </div>
      {status === "unavailable" ? (
        <div className="term-unavailable">터미널은 앱에서만 동작합니다.</div>
      ) : null}
      <div
        className={status === "unavailable" ? "term-body hidden" : "term-body"}
        ref={hostRef}
      />
    </div>
  );
}
