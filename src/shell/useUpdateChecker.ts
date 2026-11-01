import { useCallback, useEffect, useRef, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { ask } from "@tauri-apps/plugin-dialog";
import { relaunch } from "@tauri-apps/plugin-process";
import { check } from "@tauri-apps/plugin-updater";
import type { Update } from "@tauri-apps/plugin-updater";
import { termCloseAll, termCount } from "./api";
import { fetchLatestRelease, isNewerThanApp, RELEASES_PAGE, summarizeNotes } from "./version";
import type { ReleaseInfo } from "./version";

// 앱 안 업데이트. 켤 때 확인만 하고, 받기와 설치와 다시 켜기는 사람이 배너 버튼을 눌러야 한다.
// latest.json(Tauri updater)을 못 읽으면 예전처럼 GitHub API로 확인해 릴리스 페이지로 안내한다.
// @see docs/update.md

/** 수동 확인 결과 pill이 떠 있는 시간(ms) */
const RESULT_VISIBLE_MS = 3000;

export type CheckResult = "upToDate" | "failed";

/** 배너 버튼 상태. idle이면 누를 수 있다 */
export type InstallPhase =
  | { kind: "idle" }
  | { kind: "downloading"; percent: number | null }
  | { kind: "installing" };

export interface UpdateChecker {
  /** 새 버전 정보. 없으면 null */
  update: ReleaseInfo | null;
  /** 앱 안에서 받아 설치할 수 있으면 true. false면 릴리스 페이지로 안내한다 */
  installable: boolean;
  phase: InstallPhase;
  /** 마지막 설치 실패 메시지. 없으면 null */
  installError: string | null;
  checking: boolean;
  /** 수동 확인 결과 pill 상태. 없으면 null */
  result: CheckResult | null;
  /** 배너를 보여줄지 (닫으면 이 세션 동안 false) */
  bannerVisible: boolean;
  checkNow: () => void;
  dismissBanner: () => void;
  /** 닫아 둔 배너를 다시 띄운다 (툴바 새 버전 배지) */
  showBanner: () => void;
  openRelease: () => void;
  /** 받아서 설치하고 다시 켠다. 열린 터미널이 있으면 먼저 묻는다 */
  install: () => void;
}

/** 앱 실행당 1회 자동 확인 (StrictMode 이중 마운트에도 한 번) */
let autoChecked = false;

interface Found {
  release: ReleaseInfo;
  /** Tauri updater로 찾았을 때만 있다 */
  installer: Update | null;
}

/**
 * latest.json으로 먼저 확인하고, 실패하면(updater 도입 전 릴리스, 이 플랫폼 파일 없음, 오프라인)
 * GitHub API로 다시 확인한다. 최신이면 "upToDate", 둘 다 확인하지 못하면 null
 */
async function findUpdate(force: boolean): Promise<Found | "upToDate" | null> {
  try {
    const installer = await check();
    if (installer === null) {
      return "upToDate";
    }
    const tag = `v${installer.version}`;
    return {
      release: {
        tag,
        htmlUrl: `https://github.com/nobel6018/gitlanes/releases/tag/${tag}`,
        notes: summarizeNotes(installer.body ?? ""),
      },
      installer,
    };
  } catch (error) {
    console.warn(`업데이트 확인(latest.json) 실패, GitHub API로 다시 확인합니다: ${String(error)}`);
  }
  const release = await fetchLatestRelease(force);
  if (release === null) {
    return null;
  }
  return isNewerThanApp(release.tag) ? { release, installer: null } : "upToDate";
}

/**
 * @param autoCheck Preferences의 "Check for updates on launch". false면 자동 확인을 건너뛴다
 *   (수동 확인은 언제나 가능). 나중에 켜면 그 시점에 한 번 확인한다
 */
export function useUpdateChecker(autoCheck = true): UpdateChecker {
  const [update, setUpdate] = useState<ReleaseInfo | null>(null);
  const [installable, setInstallable] = useState(false);
  const [phase, setPhase] = useState<InstallPhase>({ kind: "idle" });
  const [installError, setInstallError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [result, setResult] = useState<CheckResult | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const checkingRef = useRef(false);
  const busyRef = useRef(false);
  const installer = useRef<Update | null>(null);
  /** 받아 두었으면 다음에 누를 때 다시 받지 않는다. install()이 받은 바이트를 비우므로 실패하면 false로 되돌린다 */
  const downloaded = useRef(false);
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
      // 받거나 설치하는 중에 확인을 다시 돌리면 쥐고 있던 Update가 바뀐다
      if (checkingRef.current || busyRef.current) {
        return;
      }
      checkingRef.current = true;
      setChecking(true);
      setResult(null);
      void findUpdate(manual)
        .then((found) => {
          if (found === null) {
            // 자동 확인 실패는 조용히 무시한다
            if (manual) {
              showResult("failed");
            }
            return;
          }
          if (found === "upToDate") {
            setUpdate(null);
            setInstallable(false);
            installer.current = null;
            if (manual) {
              showResult("upToDate");
            }
            return;
          }
          if (installer.current?.version !== found.installer?.version) {
            downloaded.current = false;
          }
          installer.current = found.installer;
          setUpdate(found.release);
          setInstallable(found.installer !== null);
          setInstallError(null);
          // 새 버전을 새로 찾았으면 닫아둔 배너를 다시 띄운다
          setDismissed(false);
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

  const openRelease = useCallback(() => {
    void openUrl(update?.htmlUrl ?? RELEASES_PAGE).catch(() => {
      // 브라우저를 못 열어도 앱 동작에는 지장이 없다
    });
  }, [update]);

  const install = useCallback(() => {
    const target = installer.current;
    if (target === null) {
      openRelease();
      return;
    }
    if (busyRef.current) {
      return;
    }
    busyRef.current = true;
    setInstallError(null);
    void (async () => {
      try {
        const terminals = await termCount();
        if (terminals > 0) {
          const ok = await ask(
            `열린 터미널 ${terminals}개가 닫힙니다. 업데이트를 설치하고 GitLanes를 다시 켤까요?`,
            { title: `GitLanes v${target.version}`, kind: "warning", okLabel: "업데이트", cancelLabel: "취소" },
          );
          if (!ok) {
            return;
          }
        }
        if (!downloaded.current) {
          let total: number | null = null;
          let received = 0;
          setPhase({ kind: "downloading", percent: null });
          await target.download((event) => {
            if (event.event === "Started") {
              total = event.data.contentLength ?? null;
            } else if (event.event === "Progress") {
              received += event.data.chunkLength;
              if (total !== null && total > 0) {
                setPhase({ kind: "downloading", percent: Math.min(100, Math.round((received / total) * 100)) });
              }
            }
          });
          downloaded.current = true;
        }
        setPhase({ kind: "installing" });
        // Windows는 install()이 설치 파일을 띄우며 앱을 바로 끝내서 RunEvent::Exit 정리가 돌지 않는다
        await termCloseAll();
        await target.install();
        await relaunch();
      } catch (error) {
        downloaded.current = false;
        setInstallError(String(error));
      } finally {
        busyRef.current = false;
        setPhase({ kind: "idle" });
      }
    })();
  }, [openRelease]);

  const checkNow = useCallback(() => runCheck(true), [runCheck]);
  const dismissBanner = useCallback(() => setDismissed(true), []);
  const showBanner = useCallback(() => setDismissed(false), []);

  return {
    update,
    installable,
    phase,
    installError,
    checking,
    result,
    bannerVisible: update !== null && !dismissed,
    checkNow,
    dismissBanner,
    showBanner,
    openRelease,
    install,
  };
}
