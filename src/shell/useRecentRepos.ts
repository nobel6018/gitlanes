import { useCallback, useState } from "react";
import { RECENT_REPOS_KEY } from "../constants";

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

export interface RecentRepos {
  recents: string[];
  addRecent: (path: string) => void;
  removeRecent: (path: string) => void;
}

export function useRecentRepos(): RecentRepos {
  const [recents, setRecents] = useState<string[]>(read);

  const addRecent = useCallback((path: string) => {
    setRecents((prev) => {
      const next = [path, ...prev.filter((p) => p !== path)].slice(0, MAX_RECENTS);
      write(next);
      return next;
    });
  }, []);

  const removeRecent = useCallback((path: string) => {
    setRecents((prev) => {
      const next = prev.filter((p) => p !== path);
      write(next);
      return next;
    });
  }, []);

  return { recents, addRecent, removeRecent };
}
