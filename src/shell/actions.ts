// 쓰기 작업 계층. CONTRACTS.md v0.18 "ui-hub가 다른 패키지에 제공하는 액션" 구현.
//
// 다른 패키지는 api.ts를 직접 부르지 않고 여기서 만든 RepoActions만 쓴다.
// 모든 메서드가 같은 순서를 지킨다:
//   확인 다이얼로그 -> busy on -> command -> 실패 토스트(+인증 핸드오프)
//   -> 충돌 통지 -> refreshAll -> busy off. 실패는 reject로 올려 호출 측이
//   입력 상태(커밋 메시지 등)를 지울지 스스로 정한다.
import { useCallback, useMemo, useRef, useState } from "react";
import type {
  CommitOptions,
  OpResult,
  PendingKind,
  PullMode,
  RebaseStep,
} from "../types";
import * as api from "./api";

/** 파괴적 작업 확인 다이얼로그의 내용. undo는 "되돌리는 방법" 한 줄이다 */
// ConfirmSpec의 단일 출처는 Dialogs.tsx다. 여기서 또 정의하면 ui-actions가 필드를
// 늘렸을 때 두 정의가 조용히 갈라진다. 기존 import 경로를 지키려고 재수출만 한다.
export type { ConfirmSpec } from "./Dialogs";
import type { ConfirmSpec } from "./Dialogs";

/** 쓰기 결과 알림. needsAuth일 때만 action이 붙는다 */
export interface ToastSpec {
  message: string;
  tone: "error" | "info";
  durationMs?: number;
  /** git stderr처럼 원문을 복사하고 싶은 경우 */
  copyable?: boolean;
  /** git stderr 원문. 토스트가 접히는 영역에 등폭으로 보여준다 */
  stderr?: string;
  /** 실행한 git 인자. needsAuth일 때 터미널 핸드오프에 그대로 쓴다 */
  command?: string[];
  /** 인증 실패로 보이면 토스트가 "Run in terminal" 버튼을 띄운다 */
  needsAuth?: boolean;
}

/**
 * 쓰기 액션 묶음. 시그니처는 CONTRACTS.md v0.18에서 동결됐다.
 * 모든 메서드는 성공 시 resolve, 실패 시 reject 한다 (확인 거부는 조용히 resolve).
 */
export interface RepoActions {
  // 스테이징
  stage(files: string[]): Promise<void>;
  unstage(files: string[]): Promise<void>;
  discard(files: string[]): Promise<void>;
  stageAll(): Promise<void>;
  unstageAll(): Promise<void>;
  applyPatch(patch: string, cached: boolean, reverse: boolean): Promise<void>;
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
  stashApply(ref: string, drop: boolean): Promise<void>;
  stashDrop(ref: string): Promise<void>;
  stashBranch(ref: string, name: string): Promise<void>;
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
  toast: (t: ToastSpec) => void;
  runInTerminal: (command: string[]) => void;
  onConflicts: (files: string[]) => void;
}

/** 실패 토스트는 stderr를 읽어야 해서 길게 띄운다 */
const ERROR_TOAST_MS = 12_000;

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
 */
export function quoteArg(arg: string): string {
  if (arg !== "" && /^[A-Za-z0-9_@%+=:,./-]+$/.test(arg)) {
    return arg;
  }
  return `'${arg.replace(/'/g, "'\\''")}'`;
}

/** OpResult.command를 사람이 복붙할 수 있는 한 줄 명령으로 만든다 */
export function formatCommand(command: string[]): string {
  return ["git", ...command].map(quoteArg).join(" ");
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

  const enqueue = useCallback(<T,>(task: () => Promise<T>): Promise<T> => {
    // 앞 작업이 실패해도 큐는 계속 흐른다 (catch로 끊어준다)
    const next = chain.current.then(task, task);
    chain.current = next.catch(() => undefined);
    return next;
  }, []);

  const run = useCallback(
    async (spec: RunSpec): Promise<void> => {
      const o = ref.current;
      if (spec.confirm !== undefined) {
        const ok = await o.confirm(spec.confirm);
        if (!ok) {
          // 사용자가 취소했다. 아무 일도 없었던 것처럼 돌아간다
          return;
        }
      }

      setBusyCount((n) => n + 1);
      try {
        const result = await enqueue(spec.call);

        if (result.conflicts.length > 0) {
          o.onConflicts(result.conflicts);
        }

        if (!result.ok) {
          const detail = (result.stderr.trim() || result.stdout.trim() || "").slice(0, 2000);
          // stderr는 message에 이어붙이지 않고 따로 넘긴다. 토스트가 접히는 영역에
          // 등폭으로 원문을 보존해야 사용자가 git 메시지를 그대로 읽고 복사한다
          o.toast({
            message: spec.failure,
            tone: "error",
            durationMs: ERROR_TOAST_MS,
            copyable: true,
            stderr: detail === "" ? undefined : detail,
            command: result.command,
            needsAuth: result.needsAuth,
          });
          // 성공이든 실패든 새로고침한다. 실패해도 인덱스는 움직였을 수 있다
          await o.refreshAll();
          throw new Error(detail === "" ? spec.failure : detail);
        }

        if (spec.success !== null) {
          o.toast({ message: spec.success, tone: "info" });
        }
        await o.refreshAll();
      } catch (err) {
        // command 자체가 reject 된 경우(인자 검증 실패 Err(String))도 여기로 온다
        if (!(err instanceof Error)) {
          const message = api.errorMessage(err);
          o.toast({
            message: spec.failure,
            tone: "error",
            durationMs: ERROR_TOAST_MS,
            copyable: true,
            stderr: message,
          });
          await o.refreshAll();
          throw new Error(message);
        }
        throw err;
      } finally {
        setBusyCount((n) => n - 1);
      }
    },
    [enqueue],
  );

  return useMemo<RepoActions>(() => {
    const path = repoPath;

    return {
      // ── 스테이징 ─────────────────────────────────────────
      stage: (files) =>
        run({
          success: null,
          failure: "Stage failed",
          call: () => api.gitStage(path, files),
        }),

      unstage: (files) =>
        run({
          success: null,
          failure: "Unstage failed",
          call: () => api.gitUnstage(path, files),
        }),

      discard: (files) =>
        run({
          success: `Discarded ${fileWord(files.length)}`,
          failure: "Discard failed",
          confirm: {
            title: "Discard changes?",
            body: `Local changes in ${fileWord(files.length)} will be thrown away. Untracked files among them are deleted from disk.`,
            undo: "This cannot be undone. Uncommitted changes are not stored anywhere, not even in the reflog.",
            confirmLabel: "Discard",
            danger: true,
          },
          call: () => api.gitDiscard(path, files),
        }),

      stageAll: () =>
        run({
          success: null,
          failure: "Stage all failed",
          call: () => api.gitStageAll(path),
        }),

      unstageAll: () =>
        run({
          success: null,
          failure: "Unstage all failed",
          call: () => api.gitUnstageAll(path),
        }),

      applyPatch: (patch, cached, reverse) =>
        run({
          success: null,
          failure: "Applying the patch failed",
          call: () => api.gitApplyPatch(path, patch, cached, reverse),
        }),

      clean: (paths) =>
        run({
          success: `Deleted ${fileWord(paths.length)}`,
          failure: "Clean failed",
          confirm: {
            title: "Delete untracked files?",
            body: `${fileWord(paths.length)} that git does not track will be deleted from disk.`,
            undo: "This cannot be undone. Untracked files were never stored in git.",
            confirmLabel: "Delete",
            danger: true,
          },
          call: () => api.gitClean(path, paths),
        }),

      // ── 커밋 ─────────────────────────────────────────────
      commit: (options) =>
        run({
          success: options.amend ? "Commit amended" : "Committed",
          failure: options.amend ? "Amend failed" : "Commit failed",
          call: () => api.gitCommit(path, options),
        }),

      undoCommit: () =>
        run({
          success: "Last commit undone, changes are staged",
          failure: "Undo commit failed",
          call: () => api.gitUndoCommit(path),
        }),

      // ── 브랜치 ───────────────────────────────────────────
      checkout: (target, createLocal) =>
        run({
          success: `Checked out ${target}`,
          failure: `Checkout of ${target} failed`,
          call: () => api.gitCheckout(path, target, createLocal),
        }),

      createBranch: (name, startPoint, checkout) =>
        run({
          success: checkout ? `Created and checked out ${name}` : `Created ${name}`,
          failure: `Creating ${name} failed`,
          call: () => api.gitCreateBranch(path, name, startPoint, checkout),
        }),

      deleteBranch: (name, force, remote) =>
        run({
          success: remote ? `Deleted ${name} on the remote` : `Deleted ${name}`,
          failure: `Deleting ${name} failed`,
          confirm: remote
            ? {
                title: "Delete remote branch?",
                body: `${name} will be deleted on the remote. Everyone who fetches this remote loses the branch.`,
                undo: `Push it back from a local copy that still has the commits: git push <remote> <sha>:refs/heads/<branch>.`,
                confirmLabel: "Delete on remote",
                danger: true,
              }
            : force
              ? {
                  title: "Force delete branch?",
                  body: `${name} is not fully merged. Commits only on this branch stop being reachable by any ref.`,
                  undo: "Find the tip with git reflog and recreate it: git branch <name> <sha>. Unreachable commits are pruned after about 30 days.",
                  confirmLabel: "Force delete",
                  danger: true,
                }
              : undefined,
          call: () => api.gitDeleteBranch(path, name, force, remote),
        }),

      renameBranch: (from, to) =>
        run({
          success: `Renamed ${from} to ${to}`,
          failure: `Renaming ${from} failed`,
          call: () => api.gitRenameBranch(path, from, to),
        }),

      setUpstream: (branch, upstream) =>
        run({
          success:
            upstream === null
              ? `Cleared upstream of ${branch}`
              : `${branch} now tracks ${upstream}`,
          failure: `Setting upstream of ${branch} failed`,
          call: () => api.gitSetUpstream(path, branch, upstream),
        }),

      // ── 네트워크 ─────────────────────────────────────────
      fetch: (o) =>
        run({
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
        run({
          success: "Pulled",
          failure: "Pull failed",
          call: () => api.gitPull(path, mode, null, null),
        }),

      push: (o) =>
        run({
          success: o?.tags === true ? "Pushed tags" : "Pushed",
          failure: "Push failed",
          confirm:
            o?.forceWithLease === true
              ? {
                  title: "Force push with lease?",
                  body: `The remote branch will be overwritten with your local history. Commits only on the remote stop being reachable there.`,
                  undo: "Anyone who still has the old commits can push them back. --force-with-lease refuses the push if the remote moved since your last fetch, so this is not a blind overwrite.",
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
        run({
          success: o?.squash === true ? `Squash merged ${source}` : `Merged ${source}`,
          failure: `Merging ${source} failed`,
          call: () =>
            api.gitMerge(path, source, o?.noFf ?? false, o?.squash ?? false, false),
        }),

      // autostash를 켜둔다. 워킹 트리가 더러우면 git이 시작 자체를 거부하는데,
      // 그 실패는 사용자가 고칠 방법이 다이얼로그에 없다. 스태시는 리베이스 끝에 되돌아온다
      rebase: (upstream, onto) =>
        run({
          success: `Rebased onto ${onto ?? upstream}`,
          failure: `Rebase onto ${onto ?? upstream} failed`,
          call: () => api.gitRebase(path, upstream, onto ?? null, true),
        }),

      rebaseInteractive: (base, steps) =>
        run({
          success: `Rebased ${steps.length === 1 ? "1 commit" : `${steps.length} commits`}`,
          failure: "Interactive rebase failed",
          call: () => api.gitRebaseInteractive(path, base, steps),
        }),

      cherryPick: (shas, noCommit) =>
        run({
          success: `Cherry-picked ${shas.length === 1 ? "1 commit" : `${shas.length} commits`}`,
          failure: "Cherry-pick failed",
          call: () => api.gitCherryPick(path, shas, noCommit, null),
        }),

      revert: (shas, noCommit) =>
        run({
          success: `Reverted ${shas.length === 1 ? "1 commit" : `${shas.length} commits`}`,
          failure: "Revert failed",
          call: () => api.gitRevert(path, shas, noCommit, null),
        }),

      reset: (target, mode) =>
        run({
          success: `Reset (${mode}) to ${target}`,
          failure: "Reset failed",
          confirm:
            mode === "hard"
              ? {
                  title: "Reset --hard?",
                  body: `The current branch moves to ${target} and every file in the working tree is overwritten to match it.`,
                  undo: "You can find the previous position with git reflog and reset back to it, but uncommitted file changes cannot be recovered.",
                  confirmLabel: "Reset hard",
                  danger: true,
                }
              : undefined,
          call: () => api.gitReset(path, target, mode),
        }),

      // kind는 프리즈된 시그니처에 없어 호출 직전에 get_sync_state로 읽는다.
      // 진행 중인 작업이 없으면 부를 이유가 없으므로 조용히 끝낸다
      pendingAction: async (action) => {
        const state = await api.getSyncState(path);
        const pending = state.pending;
        if (pending === null) {
          return;
        }
        const kind: PendingKind = pending.kind;
        await run({
          success:
            action === "abort"
              ? `Aborted the ${kind}`
              : action === "skip"
                ? "Skipped this commit"
                : `Continued the ${kind}`,
          failure: `${action} failed`,
          confirm:
            action === "abort"
              ? {
                  title: `Abort the ${kind}?`,
                  body: `The ${kind} in progress stops and the repository returns to the state it had before the ${kind} started.`,
                  undo: "Committed history is not lost, but conflict resolutions you made in the working tree are discarded.",
                  confirmLabel: "Abort",
                  danger: true,
                }
              : undefined,
          call: () => api.gitPendingAction(path, kind, action),
        });
      },

      // ── 태그 ─────────────────────────────────────────────
      createTag: (name, target, message) =>
        run({
          success: `Created tag ${name}`,
          failure: `Creating tag ${name} failed`,
          call: () => api.gitCreateTag(path, name, target, message),
        }),

      deleteTag: (name) =>
        run({
          success: `Deleted tag ${name}`,
          failure: `Deleting tag ${name} failed`,
          confirm: {
            title: "Delete tag?",
            body: `The local tag ${name} will be removed. The remote keeps its copy.`,
            undo: `Recreate it with git tag ${name} <sha> if you know the commit, or fetch it back from the remote.`,
            confirmLabel: "Delete tag",
            danger: true,
          },
          call: () => api.gitDeleteTag(path, name),
        }),

      pushTag: (remote, name, del) =>
        run({
          success: del ? `Deleted tag ${name} on ${remote}` : `Pushed tag ${name}`,
          failure: del ? `Deleting tag ${name} on ${remote} failed` : `Pushing tag ${name} failed`,
          confirm: del
            ? {
                title: "Delete tag on remote?",
                body: `${name} will be deleted on ${remote}. Anyone who already fetched it keeps a local copy.`,
                undo: `Push it again with git push ${remote} ${name} while you still have the tag locally.`,
                confirmLabel: "Delete on remote",
                danger: true,
              }
            : undefined,
          call: () => api.gitPushTag(path, remote, name, del),
        }),

      // ── 스태시 ───────────────────────────────────────────
      stashPush: (o) =>
        run({
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

      stashApply: (stashRef, drop) =>
        run({
          success: drop ? `Popped ${stashRef}` : `Applied ${stashRef}`,
          failure: drop ? `Popping ${stashRef} failed` : `Applying ${stashRef} failed`,
          call: () => api.gitStashApply(path, stashRef, drop),
        }),

      stashDrop: (stashRef) =>
        run({
          success: `Dropped ${stashRef}`,
          failure: `Dropping ${stashRef} failed`,
          confirm: {
            title: "Drop stash?",
            body: `${stashRef} and the changes it holds will be removed from the stash list.`,
            undo: "The stash commit stays unreachable in the object database for a while: find it with git fsck --unreachable and restore it with git stash apply <sha>.",
            confirmLabel: "Drop",
            danger: true,
          },
          call: () => api.gitStashDrop(path, stashRef),
        }),

      stashBranch: (stashRef, name) =>
        run({
          success: `Created ${name} from ${stashRef}`,
          failure: `Creating ${name} from ${stashRef} failed`,
          call: () => api.gitStashBranch(path, stashRef, name),
        }),

      // ── remote ───────────────────────────────────────────
      addRemote: (name, url) =>
        run({
          success: `Added remote ${name}`,
          failure: `Adding remote ${name} failed`,
          call: () => api.gitAddRemote(path, name, url),
        }),

      removeRemote: (name) =>
        run({
          success: `Removed remote ${name}`,
          failure: `Removing remote ${name} failed`,
          call: () => api.gitRemoveRemote(path, name),
        }),

      renameRemote: (from, to) =>
        run({
          success: `Renamed remote ${from} to ${to}`,
          failure: `Renaming remote ${from} failed`,
          call: () => api.gitRenameRemote(path, from, to),
        }),

      setRemoteUrl: (name, url) =>
        run({
          success: `Updated the URL of ${name}`,
          failure: `Updating the URL of ${name} failed`,
          call: () => api.gitSetRemoteUrl(path, name, url),
        }),

      // ── 워크트리 ─────────────────────────────────────────
      addWorktree: (dir, branch, createBranch) =>
        run({
          success: `Added worktree at ${dir}`,
          failure: `Adding a worktree at ${dir} failed`,
          call: () => api.gitAddWorktree(path, dir, branch, createBranch),
        }),

      removeWorktree: (dir, force) =>
        run({
          success: `Removed worktree at ${dir}`,
          failure: `Removing the worktree at ${dir} failed`,
          confirm: {
            title: "Remove worktree?",
            body: `The worktree at ${dir} will be unregistered and its directory deleted.${force ? " Uncommitted changes inside it are thrown away." : ""}`,
            undo: `Recreate it with git worktree add ${quoteArg(dir)} <branch>. Committed work is safe because it lives in the shared repository, but uncommitted changes are not recoverable.`,
            confirmLabel: "Remove",
            danger: true,
          },
          call: () => api.gitRemoveWorktree(path, dir, force),
        }),

      // ── 충돌 ─────────────────────────────────────────────
      resolveWith: (file, side) =>
        run({
          success: `Resolved ${file} with ${side}`,
          failure: `Resolving ${file} failed`,
          call: () => api.gitResolveWith(path, file, side),
        }),

      markResolved: (files) =>
        run({
          success: `Marked ${nameList(files)} resolved`,
          failure: "Marking resolved failed",
          call: () => api.gitMarkResolved(path, files),
        }),

      busy: busyCount > 0,
    };
  }, [repoPath, run, busyCount]);
}
