import { useCallback, useEffect, useRef, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { fetchLatestRelease, isNewerThanApp, RELEASES_PAGE } from "./version";
import type { ReleaseInfo } from "./version";

/** 수동 확인 결과 pill이 떠 있는 시간(ms) */
const RESULT_VISIBLE_MS = 3000;

export type CheckResult = "upToDate" | "failed";

export interface UpdateChecker {
  /** 새 버전 정보. 없으면 null */
  update: ReleaseInfo | null;
  checking: boolean;
  /** 수동 확인 결과 pill 상태. 없으면 null */
  result: CheckResult | null;
  /** 배너를 보여줄지 (닫으면 이 세션 동안 false) */
  bannerVisible: boolean;
  checkNow: () => void;
  dismissBanner: () => void;
  openRelease: () => void;
}

/** 앱 실행당 1회 자동 확인 (StrictMode 이중 마운트에도 한 번) */
let autoChecked = false;

/**
 * @param autoCheck Preferences의 "Check for updates on launch". false면 자동 확인을 건너뛴다
 *   (수동 확인은 언제나 가능). 나중에 켜면 그 시점에 한 번 확인한다
 */
export function useUpdateChecker(autoCheck = true): UpdateChecker {
  const [update, setUpdate] = useState<ReleaseInfo | null>(null);
  const [checking, setChecking] = useState(false);
  const [result, setResult] = useState<CheckResult | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const checkingRef = useRef(false);
  const resultTimer = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (resultTimer.current !== null) {
        window.clearTimeout(resultTimer.current);
      }
    };
  }, []);

  const showResult = useCallback((kind: CheckResult) => {
    setResult(kind);
    if (resultTimer.current !== null) {
      window.clearTimeout(resultTimer.current);
    }
    resultTimer.current = window.setTimeout(() => setResult(null), RESULT_VISIBLE_MS);
  }, []);

  const runCheck = useCallback(
    (manual: boolean) => {
      if (checkingRef.current) {
        return;
      }
      checkingRef.current = true;
      setChecking(true);
      setResult(null);
      void fetchLatestRelease(manual)
        .then((release) => {
          if (release === null) {
            // 자동 확인 실패는 조용히 무시한다
            if (manual) {
              showResult("failed");
            }
            return;
          }
          if (isNewerThanApp(release.tag)) {
            setUpdate(release);
            // 새 버전을 새로 찾았으면 닫아둔 배너를 다시 띄운다
            setDismissed(false);
            return;
          }
          setUpdate(null);
          if (manual) {
            showResult("upToDate");
          }
        })
        .finally(() => {
          checkingRef.current = false;
          setChecking(false);
        });
    },
    [showResult],
  );

  useEffect(() => {
    if (autoChecked || !autoCheck) {
      return;
    }
    autoChecked = true;
    runCheck(false);
  }, [autoCheck, runCheck]);

  const checkNow = useCallback(() => runCheck(true), [runCheck]);
  const dismissBanner = useCallback(() => setDismissed(true), []);
  const openRelease = useCallback(() => {
    void openUrl(update?.htmlUrl ?? RELEASES_PAGE).catch(() => {
      // 브라우저를 못 열어도 앱 동작에는 지장이 없다
    });
  }, [update]);

  return {
    update,
    checking,
    result,
    bannerVisible: update !== null && !dismissed,
    checkNow,
    dismissBanner,
    openRelease,
  };
}
