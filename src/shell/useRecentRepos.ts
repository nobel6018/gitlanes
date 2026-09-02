// 최근 레포 목록. 탭마다 훅 인스턴스가 생기므로 모듈 레벨 스토어 하나를 공유한다.
// 목록이 바뀔 때마다 네이티브 File > Open Recent 서브메뉴도 다시 만든다.
import { useCallback, useEffect, useState } from "react";
import { RECENT_REPOS_KEY } from "../constants";
import { setRecentRepos } from "./api";

const MAX_RECENTS = 10;

function read(): string[] {
  try {
    const raw = localStorage.getItem(RECENT_REPOS_KEY);
    if (!raw) {
      return [];
    }
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.filter((p): p is string => typeof p === "string").slice(0, MAX_RECENTS);
  } catch {
    return [];
  }
}

function write(paths: string[]): void {
  try {
    localStorage.setItem(RECENT_REPOS_KEY, JSON.stringify(paths));
  } catch {
    // localStorage 접근 실패는 무시한다 (기능 저하만 발생)
  }
}

/** 네이티브 메뉴 동기화. Tauri가 아니면 조용히 실패한다 */
function syncNativeMenu(paths: string[]): void {
  setRecentRepos(paths).catch(() => {
    // 하네스(브라우저)에는 메뉴가 없다
  });
}

let current: string[] = read();
const listeners = new Set<(paths: string[]) => void>();

function publish(next: string[]): void {
  current = next;
  write(next);
  syncNativeMenu(next);
  for (const listener of listeners) {
    listener(next);
  }
}

export interface RecentRepos {
  recents: string[];
  addRecent: (path: string) => void;
  removeRecent: (path: string) => void;
  /** 메뉴의 Clear Menu와 웰컴 화면이 함께 쓴다 */
  clearRecents: () => void;
}

export function useRecentRepos(): RecentRepos {
  const [recents, setRecents] = useState<string[]>(current);

  useEffect(() => {
    listeners.add(setRecents);
    // 구독 사이에 다른 탭이 목록을 바꿨을 수 있다
    setRecents(current);
    return () => {
      listeners.delete(setRecents);
    };
  }, []);

  const addRecent = useCallback((path: string) => {
    publish([path, ...current.filter((p) => p !== path)].slice(0, MAX_RECENTS));
  }, []);

  const removeRecent = useCallback((path: string) => {
    publish(current.filter((p) => p !== path));
  }, []);

  const clearRecents = useCallback(() => {
    publish([]);
  }, []);

  return { recents, addRecent, removeRecent, clearRecents };
}
