// 폴더 드래그&드롭. Tauri에서는 webview의 onDragDropEvent를,
// 브라우저 하네스에서는 HTML5 이벤트를 쓴다 (경로를 얻을 수 없어 isOver만 동작).
// 계약: useDropZone(onDropPaths) -> { isOver: boolean }
import { useEffect, useRef, useState } from "react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import type { UnlistenFn } from "@tauri-apps/api/event";

function isTauri(): boolean {
  return typeof (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ !== "undefined";
}

export function useDropZone(onDropPaths: (paths: string[]) => void): { isOver: boolean } {
  const [isOver, setIsOver] = useState(false);
  // 콜백이 매 렌더 새로 와도 구독은 한 번만 걸도록 ref로 우회한다
  const handlerRef = useRef(onDropPaths);
  handlerRef.current = onDropPaths;

  useEffect(() => {
    let disposed = false;
    let unlisten: UnlistenFn | null = null;
    let removeFallback: (() => void) | null = null;

    /** 브라우저 폴백: 경로를 못 얻으니 파일명만 로그하고 isOver만 유지 */
    function installFallback(): () => void {
      let depth = 0;

      const onDragEnter = (event: DragEvent) => {
        event.preventDefault();
        depth += 1;
        setIsOver(true);
      };
      const onDragOver = (event: DragEvent) => {
        // preventDefault 없으면 drop 이벤트가 오지 않는다
        event.preventDefault();
      };
      const onDragLeave = (event: DragEvent) => {
        event.preventDefault();
        depth = Math.max(0, depth - 1);
        if (depth === 0) {
          setIsOver(false);
        }
      };
      const onDrop = (event: DragEvent) => {
        event.preventDefault();
        depth = 0;
        setIsOver(false);
        const names = Array.from(event.dataTransfer?.files ?? []).map((file) => file.name);
        if (names.length > 0) {
          // 브라우저는 절대 경로를 주지 않는다. Tauri에서만 실제 열기가 동작한다
          console.log("[useDropZone] HTML5 drop (paths unavailable):", names.join(", "));
        }
      };

      window.addEventListener("dragenter", onDragEnter);
      window.addEventListener("dragover", onDragOver);
      window.addEventListener("dragleave", onDragLeave);
      window.addEventListener("drop", onDrop);

      return () => {
        window.removeEventListener("dragenter", onDragEnter);
        window.removeEventListener("dragover", onDragOver);
        window.removeEventListener("dragleave", onDragLeave);
        window.removeEventListener("drop", onDrop);
      };
    }

    if (isTauri()) {
      let webview: ReturnType<typeof getCurrentWebview> | null = null;
      try {
        webview = getCurrentWebview();
      } catch {
        webview = null;
      }
      if (webview !== null) {
        webview
          .onDragDropEvent((event) => {
            const payload = event.payload;
            if (payload.type === "enter" || payload.type === "over") {
              setIsOver(true);
              return;
            }
            if (payload.type === "leave") {
              setIsOver(false);
              return;
            }
            setIsOver(false);
            if (payload.paths.length > 0) {
              handlerRef.current(payload.paths);
            }
          })
          .then((fn) => {
            if (disposed) {
              fn();
            } else {
              unlisten = fn;
            }
          })
          .catch(() => {
            // 구독 실패(capability 누락 등)면 HTML5 폴백으로 내려간다
            if (!disposed && removeFallback === null) {
              removeFallback = installFallback();
            }
          });
      } else if (removeFallback === null) {
        removeFallback = installFallback();
      }
    } else {
      removeFallback = installFallback();
    }

    return () => {
      disposed = true;
      if (unlisten !== null) {
        unlisten();
        unlisten = null;
      }
      if (removeFallback !== null) {
        removeFallback();
        removeFallback = null;
      }
    };
  }, []);

  return { isOver };
}
