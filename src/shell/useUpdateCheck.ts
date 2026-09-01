import { useEffect, useState } from "react";
import { APP_VERSION, compareVersions, fetchLatestTag } from "./version";

export interface UpdateInfo {
  /** 최신 릴리스 태그 ("v0.4.0") */
  tag: string;
}

/**
 * 시작 시 1회 GitHub 최신 릴리스를 확인한다.
 * 실패(오프라인, rate limit, 릴리스 없음)는 조용히 무시하고 null을 유지한다.
 */
export function useUpdateCheck(): UpdateInfo | null {
  const [update, setUpdate] = useState<UpdateInfo | null>(null);

  useEffect(() => {
    let alive = true;
    void fetchLatestTag().then((tag) => {
      if (!alive || tag === null) {
        return;
      }
      if (compareVersions(tag, APP_VERSION) > 0) {
        setUpdate({ tag });
      }
    });
    return () => {
      alive = false;
    };
  }, []);

  return update;
}
