// 쓰기 작업 계층. CONTRACTS.md v0.18 "ui-hub가 다른 패키지에 제공하는 액션" 구현.
//
// 다른 패키지는 api.ts를 직접 부르지 않고 여기서 만든 RepoActions만 쓴다.
// 모든 메서드가 같은 순서를 지킨다:
//   확인 다이얼로그 -> busy on -> command -> 실패 토스트(+인증 핸드오프)
//   -> 충돌 통지 -> refreshAll(뒤에 쓰기가 남아 있으면 생략) -> busy off.
//   실패는 reject로 올려 호출 측이 입력 상태(커밋 메시지 등)를 지울지 스스로 정한다.
import { useCallback, useMemo, useRef, useState } from "react";
import type {
  CommitOptions,
  DiscardArea,
  OpResult,
  PendingKind,
  PullMode,
  RebaseStep,
} from "../types";
import * as api from "./api";
import { basename } from "./format";
// 다이얼로그와 토스트의 모양은 ui-actions 소유다. 여기서 새로 정의하지 않고 그대로 쓴다
import type { ConfirmSpec } from "./Dialogs";
import type { ToastProps } from "./Toast";

// ConfirmSpec의 단일 출처는 Dialogs.tsx다. 여기서 또 정의하면 ui-actions가 필드를
// 늘렸을 때 두 정의가 조용히 갈라진다. 기존 import 경로를 지키려고 재수출만 한다.
export type { ConfirmSpec };

/**
 * 쓰기 결과 알림. Toast가 그리는 데 필요한 것에서 셸이 채우는 두 가지를 뺀 것이다.
 * onClose는 토스트 스택이, onRunInTerminal은 RepoWorkspace가 붙인다.
 * 같은 이유로 여기서 필드를 다시 나열하지 않는다.
 */
export type ToastSpec = Omit<ToastProps, "onClose" | "onRunInTerminal">;

/**
 * 쓰기 액션 묶음. 시그니처는 CONTRACTS.md v0.18에서 동결됐다.
 * 모든 메서드는 성공 시 resolve, 실패 시 reject 한다 (확인 거부는 조용히 resolve).
 */
export interface RepoActions {
  // 스테이징
  stage(files: string[]): Promise<void>;
  unstage(files: string[]): Promise<void>;
  /**
   * area를 생략하면 "all" (마지막 커밋 상태로 전부 되돌리기)이다.
   * 계약이 area를 추가했지만 rust와 ui-wip이 아직 안 넘기고 있어 기본값을 지금 동작에 맞췄다.
   * 선택 인자라 discard(files)만 부르는 WipActions도 구조적으로 그대로 만족한다.
   */
  discard(files: string[], area?: DiscardArea): Promise<void>;
  stageAll(): Promise<void>;
  unstageAll(): Promise<void>;
  /**
   * 워킹 트리에서 버리는 경우(!cached && reverse)만 확인창을 띄운다.
   * scope는 확인창에 보여줄 영향 범위("2 lines in src/a.ts" 같은 것). 선택 인자라
   * 아직 넘기지 않는 호출 측도 그대로 컴파일된다 (v0.15.1)
   */
  applyPatch(patch: string, cached: boolean, reverse: boolean, scope?: string): Promise<void>;
  clean(paths: string[]): Promise<void>;
  // 커밋
  commit(options: CommitOptions): Promise<void>;
  undoCommit(): Promise<void>;
  // 브랜치
  checkout(target: string, createLocal: boolean): Promise<void>;
  createBranch(name: string, startPoint: string | null, checkout: boolean): Promise<void>;
  deleteBranch(name: string, force: boolean, remote: boolean): Promise<void>;
  renameBranch(from: string, to: string): Promise<void>;
  setUpstream(branch: string, upstream: string | null): Promise<void>;
  // 네트워크
  fetch(opts?: {
    remote?: string;
    prune?: boolean;
    allRemotes?: boolean;
    tags?: boolean;
  }): Promise<void>;
  pull(mode: PullMode): Promise<void>;
  push(opts?: {
    remote?: string;
    branch?: string;
    setUpstream?: boolean;
    forceWithLease?: boolean;
    tags?: boolean;
  }): Promise<void>;
  // 히스토리
  merge(source: string, opts?: { noFf?: boolean; squash?: boolean }): Promise<void>;
  rebase(upstream: string, onto?: string | null): Promise<void>;
  rebaseInteractive(base: string, steps: RebaseStep[]): Promise<void>;
  cherryPick(shas: string[], noCommit: boolean): Promise<void>;
  revert(shas: string[], noCommit: boolean): Promise<void>;
  reset(target: string, mode: "soft" | "mixed" | "hard"): Promise<void>;
  pendingAction(action: "continue" | "abort" | "skip"): Promise<void>;
  // 태그 / 스태시 / remote / 워크트리
  createTag(name: string, target: string, message: string | null): Promise<void>;
  deleteTag(name: string): Promise<void>;
  pushTag(remote: string, name: string, del: boolean): Promise<void>;
  stashPush(opts?: {
    message?: string;
    includeUntracked?: boolean;
    keepIndex?: boolean;
    files?: string[];
  }): Promise<void>;
  /**
   * sha는 ref를 고른 시점의 StashInfo.sha다 (v0.16). Rust가 실행 직전 ref가 아직 그 스태시를
   * 가리키는지 확인한다. 선택 인자로 두지 않은 이유는 빠뜨리면 번호 밀림 보호가 조용히 꺼져서다.
   * 스태시 목록을 아직 못 읽었을 때만 null을 넘긴다
   */
  stashApply(ref: string, sha: string | null, drop: boolean): Promise<void>;
  stashDrop(ref: string, sha: string | null): Promise<void>;
  stashBranch(ref: string, sha: string | null, name: string): Promise<void>;
  addRemote(name: string, url: string): Promise<void>;
  removeRemote(name: string): Promise<void>;
  renameRemote(from: string, to: string): Promise<void>;
  setRemoteUrl(name: string, url: string): Promise<void>;
  addWorktree(dir: string, branch: string, createBranch: boolean): Promise<void>;
  removeWorktree(dir: string, force: boolean): Promise<void>;
  // 충돌
  resolveWith(file: string, side: "ours" | "theirs"): Promise<void>;
  markResolved(files: string[]): Promise<void>;
  // 공통
  /** 쓰기 작업이 진행 중인가 (버튼 비활성화용) */
  busy: boolean;
}

export interface UseRepoActionsOptions {
  repoPath: string;
  refreshAll: () => Promise<void>;
  confirm: (spec: ConfirmSpec) => Promise<boolean>;
  /**
   * repoPath는 그 작업을 시작한 레포다. 인증 핸드오프가 토스트를 띄운 뒤 탭의 레포가
   * 바뀌어도 원래 레포에서 명령을 돌리도록 토스트 항목에 함께 저장한다 (v0.15.1)
   */
  toast: (t: ToastSpec, repoPath?: string) => void;
  /**
   * 인증 실패 시 내장 터미널로 명령을 넘긴다.
   * 실제 버튼은 Toast가 그리므로(command/needsAuth를 토스트에 실어 보낸다) 여기서는
   * 셸이 토스트에 붙일 핸들러를 받아 두기만 한다. 계약 시그니처라 이름은 그대로 둔다
   */
  runInTerminal: (command: string[]) => void;
  onConflicts: (files: string[]) => void;
  /**
   * 큐에 들어간 쓰기 수를 동기로 적어 둘 곳 (v0.15.2). 폴링이 이 값을 보고 쓰기 도중에는
   * 쉰다. busy는 렌더를 거쳐야 바뀌어서 쓰기 IPC가 나간 직후의 틱을 막지 못한다.
   * 확인창이 떠 있는 동안은 올리지 않는다(아직 아무것도 쓰지 않았다)
   */
  writing?: { current: number };
}

/** 확인 문구에 쓰는 진행 중 작업 이름 */
const KIND_LABEL: Record<PendingKind, string> = {
  merge: "merge",
  rebase: "rebase",
  cherryPick: "cherry-pick",
  revert: "revert",
  am: "patch apply (git am)",
  conflicts: "conflict resolution",
};

function fileWord(n: number): string {
  return n === 1 ? "1 file" : `${n} files`;
}

/** 여러 이름을 한 줄로. 3개를 넘으면 뒤를 접는다 */
function nameList(names: string[]): string {
  if (names.length <= 3) {
    return names.join(", ");
  }
  return `${names.slice(0, 3).join(", ")} and ${names.length - 3} more`;
}

/**
 * 셸에 그대로 넣어도 안전하게 인용한다.
 * 작은따옴표 안에서는 작은따옴표만 탈출이 필요하다 ('foo'\''bar' 관용구).
 * `=`는 단어 가운데(`--format=x`)에서는 안전하지만 맨 앞에 오면 zsh가 EQUALS 옵션(기본 켜짐)으로
 * `=foo`를 foo의 명령 경로로 바꾼다. 그래서 `=`로 시작하면 인용한다. `~`와 `!`는 허용 문자에
 * 없어 항상 인용되고, 작은따옴표 안에서는 bash와 zsh 모두 틸드 확장과 히스토리 확장을 하지 않는다
 */
export function quoteArg(arg: string): string {
  if (arg !== "" && !arg.startsWith("=") && /^[A-Za-z0-9_@%+=:,./-]+$/.test(arg)) {
    return arg;
  }
  return `'${arg.replace(/'/g, "'\\''")}'`;
}

/**
 * OpResult.command를 사람이 복붙할 수 있는 한 줄 명령으로 만든다.
 * `-C <repo>`를 박아 PTY 셸의 현재 디렉토리(사용자가 cd 했을 수 있다)와 무관하게
 * 원래 레포에서 돌게 한다 (audit-state H1)
 */
export function formatCommand(command: string[], repoPath: string): string {
  return ["git", "-C", repoPath, ...command].map(quoteArg).join(" ");
}

/** 한 번의 쓰기 작업 명세 */
interface RunSpec {
  /** 성공 토스트 문구. null이면 성공 시 조용하다 */
  success: string | null;
  /** 실패 토스트 첫 줄 ("Push failed") */
  failure: string;
  confirm?: ConfirmSpec;
  call: () => Promise<OpResult>;
}

export function useRepoActions(opts: UseRepoActionsOptions): RepoActions {
  const { repoPath } = opts;

  const [busyCount, setBusyCount] = useState(0);

  // 콜백 identity가 매 렌더 바뀌어도 액션 객체를 다시 만들지 않도록 거울에 담는다
  const ref = useRef(opts);
  ref.current = opts;

  /**
   * 동시에 두 쓰기가 돌지 않게 하는 직렬 큐.
   * git은 .git/index.lock을 쓰므로 병렬 실행은 "Unable to create index.lock"으로 깨진다.
   */
  const chain = useRef<Promise<unknown>>(Promise.resolve());
  /** 큐에 있거나 실행 중인 command 수. 0이 아니면 뒤에 다른 쓰기가 기다리고 있다 */
  const queued = useRef(0);
  /** pendingAction이 상태 확인부터 command 끝까지 진행 중인가 */
  const pendingInFlight = useRef(false);

  const enqueue = useCallback(<T,>(task: () => Promise<T>): Promise<T> => {
    queued.current += 1;
    const tracked = async (): Promise<T> => {
      try {
        return await task();
      } finally {
        queued.current -= 1;
      }
    };
    // 앞 작업이 실패해도 큐는 계속 흐른다 (catch로 끊어준다)
    const next = chain.current.then(tracked, tracked);
    chain.current = next.catch(() => undefined);
    return next;
  }, []);

  const run = useCallback(
    async (path: string, spec: RunSpec): Promise<void> => {
      const o = ref.current;
      // 이 작업을 요청받은 레포. 끝났을 때 탭이 다른 레포로 바뀌었는지 비교한다
      const startPath = path;
      /** 끝난 시점에 탭이 다른 레포를 보고 있는가. 그렇다면 결과를 원래 레포 이름으로 알린다 */
      const moved = () => ref.current.repoPath !== startPath;
      const label = (message: string) =>
        moved() ? `${basename(startPath)}: ${message}` : message;
      if (spec.confirm !== undefined) {
        const ok = await o.confirm(spec.confirm);
        if (!ok) {
          // 사용자가 취소했다. 아무 일도 없었던 것처럼 돌아간다
          return;
        }
      }

      /**
       * 뒤에 쓰기가 더 기다리고 있으면 새로고침을 건너뛴다. command가 스레드 풀에서 돌면
       * 이 새로고침의 읽기가 다음 쓰기와 겹쳐 중간 상태를 읽는다. 마지막 쓰기의 새로고침이
       * 앞 쓰기의 결과까지 함께 반영한다
       */
      const refresh = (): Promise<void> =>
        queued.current > 0 ? Promise.resolve() : ref.current.refreshAll();

      setBusyCount((n) => n + 1);
      const writing = o.writing;
      if (writing !== undefined) {
        writing.current += 1;
      }
      try {
        const result = await enqueue(spec.call);

        // 다른 레포 화면에서 WIP 패널을 열어 버리면 엉뚱한 레포의 충돌처럼 보인다
        if (result.conflicts.length > 0 && !moved()) {
          o.onConflicts(result.conflicts);
        }

        if (!result.ok) {
          const detail = (result.stderr.trim() || result.stdout.trim() || "").slice(0, 2000);
          // stderr는 message에 이어붙이지 않고 따로 넘긴다. 토스트가 접히는 영역에
          // 등폭으로 원문을 보존해야 사용자가 git 메시지를 그대로 읽고 복사한다.
          // durationMs를 주지 않으므로 실패 토스트는 사용자가 닫을 때까지 남는다
          o.toast(
            {
              message: label(spec.failure),
              tone: "error",
              copyable: true,
              stderr: detail === "" ? undefined : detail,
              command: result.command,
              needsAuth: result.needsAuth,
              // 터미널로 넘겨도 같은 credential helper가 같은 계정을 내놓는다. needsAuth와 별개로 싣는다
              deniedAccount: result.deniedAccount ?? undefined,
            },
            startPath,
          );
          // 성공이든 실패든 새로고침한다. 실패해도 인덱스는 움직였을 수 있다
          await refresh();
          throw new Error(detail === "" ? spec.failure : detail);
        }

        if (spec.success !== null) {
          o.toast({ message: label(spec.success), tone: "success" }, startPath);
        }
        await refresh();
      } catch (err) {
        // command 자체가 reject 된 경우(인자 검증 실패 Err(String))도 여기로 온다
        if (!(err instanceof Error)) {
          const message = api.errorMessage(err);
          o.toast(
            {
              message: label(spec.failure),
              tone: "error",
              copyable: true,
              stderr: message,
            },
            startPath,
          );
          await refresh();
          throw new Error(message);
        }
        throw err;
      } finally {
        if (writing !== undefined) {
          writing.current -= 1;
        }
        setBusyCount((n) => n - 1);
      }
    },
    [enqueue],
  );

  return useMemo<RepoActions>(() => {
    const path = repoPath;
    // 액션이 만들어진 시점의 레포로 고정한다. run이 끝날 때 현재 레포와 비교하는 기준이다
    const exec = (spec: RunSpec) => run(path, spec);

    return {
      // ── 스테이징 ─────────────────────────────────────────
      stage: (files) =>
        exec({
          success: null,
          failure: "Stage failed",
          call: () => api.gitStage(path, files),
        }),

      unstage: (files) =>
        exec({
          success: null,
          failure: "Unstage failed",
          call: () => api.gitUnstage(path, files),
        }),

      // area별로 문구가 다르다. 동작을 가른 이유는 @see docs/decisions.md#discard-범위
      discard: (files, area = "all") =>
        exec({
          success: `Discarded ${fileWord(files.length)}`,
          failure: "Discard failed",
          confirm: {
            title: "Discard changes?",
            body:
              area === "worktree"
                ? "Unstaged changes will be thrown away. Anything already staged is kept. Untracked files among them are deleted from disk."
                : "Local changes will be thrown away, staged and unstaged alike. Untracked files among them are deleted from disk.",
            undo: "This cannot be undone. Uncommitted changes are not stored anywhere, not even in the reflog.",
            scope: fileWord(files.length),
            confirmLabel: "Discard",
            danger: true,
          },
          call: () => api.gitDiscard(path, files, area),
        }),

      stageAll: () =>
        exec({
          success: null,
          failure: "Stage all failed",
          call: () => api.gitStageAll(path),
        }),

      unstageAll: () =>
        exec({
          success: null,
          failure: "Unstage all failed",
          call: () => api.gitUnstageAll(path),
        }),

      // 워킹 트리에서 버리기는 파일 단위 discard와 같은 효과다. 실수로 옆 버튼을 눌러도
      // 미커밋 변경이 사라지지 않게 확인을 받는다 (audit-state H2). 인덱스 쪽 조작은
      // 워킹 트리에 내용이 남아 있어 되돌릴 수 있으므로 묻지 않는다
      applyPatch: (patch, cached, reverse, scope) =>
        exec({
          success: null,
          failure: "Applying the patch failed",
          confirm:
            !cached && reverse
              ? {
                  title: "Discard these changes?",
                  body: "The selected changes will be removed from the file in the working tree.",
                  undo: "This cannot be undone. Uncommitted changes are not stored anywhere, not even in the reflog.",
                  scope: scope ?? null,
                  confirmLabel: "Discard",
                  danger: true,
                }
              : undefined,
          call: () => api.gitApplyPatch(path, patch, cached, reverse),
        }),

      clean: (paths) =>
        exec({
          success: `Deleted ${fileWord(paths.length)}`,
          failure: "Clean failed",
          confirm: {
            title: "Delete untracked files?",
            body: "Files that git does not track will be deleted from disk.",
            undo: "This cannot be undone. Untracked files were never stored in git.",
            scope: fileWord(paths.length),
            confirmLabel: "Delete",
            danger: true,
          },
          call: () => api.gitClean(path, paths),
        }),

      // ── 커밋 ─────────────────────────────────────────────
      commit: (options) =>
        exec({
          success: options.amend ? "Commit amended" : "Committed",
          failure: options.amend ? "Amend failed" : "Commit failed",
          call: () => api.gitCommit(path, options),
        }),

      undoCommit: () =>
        exec({
          success: "Last commit undone, changes are staged",
          failure: "Undo commit failed",
          call: () => api.gitUndoCommit(path),
        }),

      // ── 브랜치 ───────────────────────────────────────────
      checkout: (target, createLocal) =>
        exec({
          success: `Checked out ${target}`,
          failure: `Checkout of ${target} failed`,
          call: () => api.gitCheckout(path, target, createLocal),
        }),

      createBranch: (name, startPoint, checkout) =>
        exec({
          success: checkout ? `Created and checked out ${name}` : `Created ${name}`,
          failure: `Creating ${name} failed`,
          call: () => api.gitCreateBranch(path, name, startPoint, checkout),
        }),

      deleteBranch: (name, force, remote) =>
        exec({
          success: remote ? `Deleted ${name} on the remote` : `Deleted ${name}`,
          failure: `Deleting ${name} failed`,
          confirm: remote
            ? {
                title: "Delete remote branch?",
                body: "The branch will be deleted on the remote. Everyone who fetches this remote loses it.",
                undo: "Push it back from a local copy that still has the commits: git push <remote> <sha>:refs/heads/<branch>.",
                scope: name,
                confirmLabel: "Delete on remote",
                danger: true,
              }
            : force
              ? {
                  title: "Force delete branch?",
                  body: "The branch is not fully merged. Commits that live only on it stop being reachable by any ref.",
                  undo: "Find the tip with git reflog and recreate it: git branch <name> <sha>. Unreachable commits are pruned after about 30 days.",
                  scope: name,
                  confirmLabel: "Force delete",
                  danger: true,
                }
              : undefined,
          call: () => api.gitDeleteBranch(path, name, force, remote),
        }),

      renameBranch: (from, to) =>
        exec({
          success: `Renamed ${from} to ${to}`,
          failure: `Renaming ${from} failed`,
          call: () => api.gitRenameBranch(path, from, to),
        }),

      setUpstream: (branch, upstream) =>
        exec({
          success:
            upstream === null
              ? `Cleared upstream of ${branch}`
              : `${branch} now tracks ${upstream}`,
          failure: `Setting upstream of ${branch} failed`,
          call: () => api.gitSetUpstream(path, branch, upstream),
        }),

      // ── 네트워크 ─────────────────────────────────────────
      fetch: (o) =>
        exec({
          success: o?.allRemotes === true ? "Fetched all remotes" : "Fetched",
          failure: "Fetch failed",
          call: () =>
            api.gitFetch(
              path,
              o?.remote ?? null,
              o?.prune ?? false,
              o?.allRemotes ?? false,
              o?.tags ?? false,
            ),
        }),

      pull: (mode) =>
        exec({
          success: "Pulled",
          failure: "Pull failed",
          call: () => api.gitPull(path, mode, null, null),
        }),

      push: (o) =>
        exec({
          success: o?.tags === true ? "Pushed tags" : "Pushed",
          failure: "Push failed",
          confirm:
            o?.forceWithLease === true
              ? {
                  title: "Force push with lease?",
                  body: "The remote branch will be overwritten with your local history. Commits that live only on the remote stop being reachable there.",
                  undo: "Anyone who still has the old commits can push them back. The push is refused if the remote branch moved since your last fetch, or if it has commits you never integrated into your local branch, even when you fetched just now.",
                  scope: `${o?.remote ?? "origin"}/${o?.branch ?? "current branch"}`,
                  confirmLabel: "Force push",
                  danger: true,
                }
              : undefined,
          call: () =>
            api.gitPush(
              path,
              o?.remote ?? null,
              o?.branch ?? null,
              o?.setUpstream ?? false,
              o?.forceWithLease ?? false,
              o?.tags ?? false,
            ),
        }),

      // ── 히스토리 ─────────────────────────────────────────
      merge: (source, o) =>
        exec({
          success: o?.squash === true ? `Squash merged ${source}` : `Merged ${source}`,
          failure: `Merging ${source} failed`,
          call: () =>
            api.gitMerge(path, source, o?.noFf ?? false, o?.squash ?? false, false),
        }),

      // autostash를 켜둔다. 워킹 트리가 더러우면 git이 시작 자체를 거부하는데,
      // 그 실패는 사용자가 고칠 방법이 다이얼로그에 없다. 스태시는 리베이스 끝에 되돌아온다
      rebase: (upstream, onto) =>
        exec({
          success: `Rebased onto ${onto ?? upstream}`,
          failure: `Rebase onto ${onto ?? upstream} failed`,
          call: () => api.gitRebase(path, upstream, onto ?? null, true),
        }),

      rebaseInteractive: (base, steps) =>
        exec({
          success: `Rebased ${steps.length === 1 ? "1 commit" : `${steps.length} commits`}`,
          failure: "Interactive rebase failed",
          call: () => api.gitRebaseInteractive(path, base, steps),
        }),

      cherryPick: (shas, noCommit) =>
        exec({
          success: `Cherry-picked ${shas.length === 1 ? "1 commit" : `${shas.length} commits`}`,
          failure: "Cherry-pick failed",
          call: () => api.gitCherryPick(path, shas, noCommit, null),
        }),

      revert: (shas, noCommit) =>
        exec({
          success: `Reverted ${shas.length === 1 ? "1 commit" : `${shas.length} commits`}`,
          failure: "Revert failed",
          call: () => api.gitRevert(path, shas, noCommit, null),
        }),

      reset: (target, mode) =>
        exec({
          success: `Reset (${mode}) to ${target}`,
          failure: "Reset failed",
          confirm:
            mode === "hard"
              ? {
                  title: "Reset --hard?",
                  body: "The current branch moves and every file in the working tree is overwritten to match it.",
                  undo: "You can find the previous position with git reflog and reset back to it, but uncommitted file changes cannot be recovered.",
                  scope: target,
                  confirmLabel: "Reset hard",
                  danger: true,
                }
              : undefined,
          call: () => api.gitReset(path, target, mode),
        }),

      // kind는 프리즈된 시그니처에 없어 호출 직전에 get_sync_state로 읽는다.
      pendingAction: async (action) => {
        // 더블클릭의 두 번째 click은 첫 click의 get_sync_state가 끝나기 전에 온다. 그때는 아직
        // 큐에 아무것도 없고 busy도 렌더 전이라 둘 다 continue를 보내고, 두 번째가 "no merge in
        // progress"로 가짜 실패 토스트를 띄운다 (audit-state L1). ref로 동기 판정해 뒤엣것을 버리고,
        // busy도 진입 즉시 올려 버튼을 잠근다
        if (pendingInFlight.current) {
          return;
        }
        pendingInFlight.current = true;
        setBusyCount((n) => n + 1);
        try {
          let state;
          try {
            state = await api.getSyncState(path);
          } catch (err) {
            const message = api.errorMessage(err);
            ref.current.toast(
              {
                message: "Reading the operation in progress failed",
                tone: "error",
                copyable: true,
                stderr: message,
              },
              path,
            );
            throw new Error(message);
          }
          const pending = state.pending;
          if (pending === null) {
            // 다른 창이나 터미널에서 이미 끝냈다. 패널이 남아 있다면 화면이 낡은 것이다
            ref.current.toast({ message: "Nothing is in progress anymore", tone: "info" }, path);
            await ref.current.refreshAll();
            return;
          }
          // 이어갈 작업 없이 충돌만 남은 상태다. git에 continue/abort/skip할 대상이 없으므로
          // Rust를 부르지 않는다. 패널도 이 버튼들을 그리지 않는다
          if (pending.kind === "conflicts") {
            return;
          }
          const kind: PendingKind = pending.kind;
          const label = KIND_LABEL[kind];
          // git am이 건너뛰는 단위는 메일함의 패치 하나다
          const unit = kind === "am" ? "patch" : "commit";
          // 진행도와 남은 충돌 수를 확인 문구에 넣는다. "3/12에서 멈춘다"를 알아야
          // abort가 얼마나 되돌리는 일인지 판단할 수 있다
          const scope = [
            pending.progress === null ? null : `at ${pending.progress}`,
            pending.conflictCount > 0 ? `${pending.conflictCount} conflicted` : null,
            pending.detail,
          ]
            .filter((part): part is string => part !== null && part !== "")
            .join(", ");

          await exec({
            success:
              action === "abort"
                ? `Aborted the ${label}`
                : action === "skip"
                  ? `Skipped this ${unit}`
                  : `Continued the ${label}`,
            failure:
              action === "abort"
                ? `Aborting the ${label} failed`
                : action === "skip"
                  ? `Skipping this ${unit} failed`
                  : `Continuing the ${label} failed`,
            confirm:
              action === "abort"
                ? {
                    title: `Abort the ${label}?`,
                    body: `The ${label} in progress stops and the repository returns to the state it had before it started.`,
                    undo: "Committed history is not lost, but the conflict resolutions you made in the working tree are discarded.",
                    scope: scope === "" ? null : scope,
                    confirmLabel: "Abort",
                    danger: true,
                  }
                : action === "skip"
                  ? {
                      title: `Skip this ${unit}?`,
                      body: `The ${unit} being applied is dropped from the ${label} and never lands on the branch.`,
                      undo: "The original commit still exists, so you can cherry-pick it back afterwards with git cherry-pick <sha> once you know its sha.",
                      scope: scope === "" ? null : scope,
                      confirmLabel: "Skip",
                      danger: true,
                    }
                  : undefined,
            call: () => api.gitPendingAction(path, kind, action),
          });
        } finally {
          pendingInFlight.current = false;
          setBusyCount((n) => n - 1);
        }
      },

      // ── 태그 ─────────────────────────────────────────────
      createTag: (name, target, message) =>
        exec({
          success: `Created tag ${name}`,
          failure: `Creating tag ${name} failed`,
          call: () => api.gitCreateTag(path, name, target, message),
        }),

      deleteTag: (name) =>
        exec({
          success: `Deleted tag ${name}`,
          failure: `Deleting tag ${name} failed`,
          confirm: {
            title: "Delete tag?",
            body: "The local tag will be removed. The remote keeps its copy.",
            undo: `Recreate it with git tag ${name} <sha> if you know the commit, or fetch it back from the remote.`,
            scope: name,
            confirmLabel: "Delete tag",
            danger: true,
          },
          call: () => api.gitDeleteTag(path, name),
        }),

      pushTag: (remote, name, del) =>
        exec({
          success: del ? `Deleted tag ${name} on ${remote}` : `Pushed tag ${name}`,
          failure: del ? `Deleting tag ${name} on ${remote} failed` : `Pushing tag ${name} failed`,
          confirm: del
            ? {
                title: "Delete tag on remote?",
                body: "The tag will be deleted on the remote. Anyone who already fetched it keeps a local copy.",
                undo: `Push it again with git push ${remote} ${name} while you still have the tag locally.`,
                scope: `${remote} ${name}`,
                confirmLabel: "Delete on remote",
                danger: true,
              }
            : undefined,
          call: () => api.gitPushTag(path, remote, name, del),
        }),

      // ── 스태시 ───────────────────────────────────────────
      stashPush: (o) =>
        exec({
          success: "Stashed",
          failure: "Stash failed",
          call: () =>
            api.gitStashPush(
              path,
              o?.message ?? null,
              o?.includeUntracked ?? false,
              o?.keepIndex ?? false,
              o?.files ?? null,
            ),
        }),

      stashApply: (stashRef, sha, drop) =>
        exec({
          success: drop ? `Popped ${stashRef}` : `Applied ${stashRef}`,
          failure: drop ? `Popping ${stashRef} failed` : `Applying ${stashRef} failed`,
          call: () => api.gitStashApply(path, stashRef, sha, drop),
        }),

      stashDrop: (stashRef, sha) =>
        exec({
          success: `Dropped ${stashRef}`,
          failure: `Dropping ${stashRef} failed`,
          confirm: {
            title: "Drop stash?",
            body: "The stash entry and the changes it holds are removed from the stash list.",
            undo: "The stash commit stays unreachable in the object database for a while: find it with git fsck --unreachable and restore it with git stash apply <sha>.",
            scope: stashRef,
            confirmLabel: "Drop",
            danger: true,
          },
          call: () => api.gitStashDrop(path, stashRef, sha),
        }),

      stashBranch: (stashRef, sha, name) =>
        exec({
          success: `Created ${name} from ${stashRef}`,
          failure: `Creating ${name} from ${stashRef} failed`,
          call: () => api.gitStashBranch(path, stashRef, sha, name),
        }),

      // ── remote ───────────────────────────────────────────
      addRemote: (name, url) =>
        exec({
          success: `Added remote ${name}`,
          failure: `Adding remote ${name} failed`,
          call: () => api.gitAddRemote(path, name, url),
        }),

      removeRemote: (name) =>
        exec({
          success: `Removed remote ${name}`,
          failure: `Removing remote ${name} failed`,
          call: () => api.gitRemoveRemote(path, name),
        }),

      renameRemote: (from, to) =>
        exec({
          success: `Renamed remote ${from} to ${to}`,
          failure: `Renaming remote ${from} failed`,
          call: () => api.gitRenameRemote(path, from, to),
        }),

      setRemoteUrl: (name, url) =>
        exec({
          success: `Updated the URL of ${name}`,
          failure: `Updating the URL of ${name} failed`,
          call: () => api.gitSetRemoteUrl(path, name, url),
        }),

      // ── 워크트리 ─────────────────────────────────────────
      addWorktree: (dir, branch, createBranch) =>
        exec({
          success: `Added worktree at ${dir}`,
          failure: `Adding a worktree at ${dir} failed`,
          call: () => api.gitAddWorktree(path, dir, branch, createBranch),
        }),

      removeWorktree: (dir, force) =>
        exec({
          success: `Removed worktree at ${dir}`,
          failure: `Removing the worktree at ${dir} failed`,
          confirm: {
            title: "Remove worktree?",
            body: `The worktree will be unregistered and its directory deleted.${force ? " Uncommitted changes inside it are thrown away." : ""}`,
            undo: `Recreate it with git worktree add ${quoteArg(dir)} <branch>. Committed work is safe because it lives in the shared repository, but uncommitted changes are not recoverable.`,
            scope: dir,
            confirmLabel: "Remove",
            danger: true,
          },
          call: () => api.gitRemoveWorktree(path, dir, force),
        }),

      // ── 충돌 ─────────────────────────────────────────────
      resolveWith: (file, side) =>
        exec({
          success: `Resolved ${file} with ${side}`,
          failure: `Resolving ${file} failed`,
          call: () => api.gitResolveWith(path, file, side),
        }),

      markResolved: (files) =>
        exec({
          success: `Marked ${nameList(files)} resolved`,
          failure: "Marking resolved failed",
          call: () => api.gitMarkResolved(path, files),
        }),

      busy: busyCount > 0,
    };
  }, [repoPath, run, busyCount]);
}
