// 쓰기 작업 폼 다이얼로그 모음. 계약: CONTRACTS.md v0.18 ui-actions.
// 전부 DialogFrame 위에 얹어 Esc / 바깥 클릭 / × 로 닫히고 Enter로 확정한다.
// 실제 git 호출은 ui-hub의 RepoActions가 하고, 여기서는 값만 모아 onSubmit으로 넘긴다.
import { useEffect, useId, useState } from "react";
import type { ReactNode } from "react";
import { DialogFrame } from "./Dialogs";
import "./actions.css";

// ── 공용 입력 조각 ─────────────────────────────────────────────

function Field({
  label,
  htmlFor,
  children,
}: {
  label: string;
  htmlFor?: string;
  children: ReactNode;
}) {
  return (
    <div className="dlg-field">
      <label className="dlg-label" htmlFor={htmlFor}>
        {label}
      </label>
      {children}
    </div>
  );
}

function Check({
  checked,
  onChange,
  label,
  note,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
  note?: string;
}) {
  return (
    <label className="dlg-check">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span>
        {label}
        {note !== undefined && <span className="dlg-check-note">{note}</span>}
      </span>
    </label>
  );
}

/** 자유 입력 + 자동완성. 브랜치/태그 어느 쪽이든 ref를 직접 쳐 넣을 수 있어야 한다 */
function RefCombo({
  id,
  value,
  onChange,
  options,
  placeholder,
}: {
  id: string;
  value: string;
  onChange: (next: string) => void;
  options: string[];
  placeholder?: string;
}) {
  const listId = `${id}-list`;
  return (
    <>
      <input
        id={id}
        className="dlg-input"
        list={listId}
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        spellCheck={false}
        autoComplete="off"
      />
      <datalist id={listId}>
        {options.map((opt) => (
          <option key={opt} value={opt} />
        ))}
      </datalist>
    </>
  );
}

/**
 * 실시간 유효성 힌트. 최종 판정은 rust 쪽 `git check-ref-format`이 한다(계약 5번).
 * 여기서 하는 건 타이핑 중에 바로 알려주는 정도의 앞단 검사다.
 */
export function refNameProblem(name: string): string | null {
  if (name.trim() === "") {
    return "Name is required.";
  }
  if (name !== name.trim()) {
    return "Name cannot start or end with whitespace.";
  }
  if (/\s/.test(name)) {
    return "Name cannot contain spaces.";
  }
  if (/[~^:?*[\\]/.test(name)) {
    return "Name cannot contain any of ~ ^ : ? * [ \\";
  }
  if (name.includes("..") || name.includes("@{")) {
    return "Name cannot contain .. or @{";
  }
  if (name.startsWith("/") || name.endsWith("/") || name.includes("//")) {
    return "Slashes cannot be leading, trailing, or doubled.";
  }
  if (name.startsWith(".") || name.includes("/.")) {
    return "No path component can start with a dot.";
  }
  if (name.endsWith(".lock") || name.includes(".lock/")) {
    return "No path component can end with .lock";
  }
  if (name === "@") {
    return "A single @ is not a valid name.";
  }
  if (/[\x00-\x20\x7f]/.test(name)) {
    return "Name cannot contain control characters.";
  }
  return null;
}

/** 다이얼로그가 닫혔다 열릴 때마다 폼을 기본값으로 되돌린다 */
function useResetOnOpen(open: boolean, reset: () => void) {
  useEffect(() => {
    if (open) {
      reset();
    }
    // reset은 매 렌더 새로 만들어지므로 의존성에서 뺀다. open 전이에만 반응하면 된다
  }, [open]);
}

// ── 1. 브랜치 생성 ─────────────────────────────────────────────

export interface CreateBranchDialogProps {
  open: boolean;
  onClose: () => void;
  onSubmit: (name: string, startPoint: string | null, checkout: boolean) => void;
  /** start point 콤보에 채울 후보 (로컬/원격 브랜치, 태그) */
  refs?: string[];
  /** 기본 start point. 보통 "HEAD" 또는 선택된 커밋 sha */
  defaultStartPoint?: string;
  /** 이미 있는 이름을 미리 잡아준다 */
  existingNames?: string[];
}

export function CreateBranchDialog({
  open,
  onClose,
  onSubmit,
  refs = [],
  defaultStartPoint = "HEAD",
  existingNames = [],
}: CreateBranchDialogProps) {
  const id = useId();
  const [name, setName] = useState("");
  const [start, setStart] = useState(defaultStartPoint);
  const [checkout, setCheckout] = useState(true);

  useResetOnOpen(open, () => {
    setName("");
    setStart(defaultStartPoint);
    setCheckout(true);
  });

  const problem =
    name === ""
      ? "Name is required."
      : existingNames.includes(name)
        ? `A branch named ${name} already exists.`
        : refNameProblem(name);

  return (
    <DialogFrame
      open={open}
      title="Create branch"
      onClose={onClose}
      onSubmit={() => onSubmit(name, start.trim() === "" ? null : start.trim(), checkout)}
      submitLabel="Create"
      disabledReason={name === "" ? null : problem}
      blocked={problem !== null}
    >
      <Field label="Branch name" htmlFor={`${id}-name`}>
        <input
          id={`${id}-name`}
          className={problem === null || name === "" ? "dlg-input" : "dlg-input bad"}
          value={name}
          placeholder="feature/my-change"
          onChange={(e) => setName(e.target.value)}
          spellCheck={false}
          autoComplete="off"
          autoFocus
        />
        {name !== "" && problem === null && <div className="dlg-ok">Valid name.</div>}
      </Field>
      <Field label="Start point" htmlFor={`${id}-start`}>
        <RefCombo
          id={`${id}-start`}
          value={start}
          onChange={setStart}
          options={refs}
          placeholder="HEAD"
        />
        <div className="dlg-note">The new branch points at this commit, branch, or tag.</div>
      </Field>
      <Check
        checked={checkout}
        onChange={setCheckout}
        label="Check out after create"
        note="Switches the working tree to the new branch."
      />
    </DialogFrame>
  );
}

// ── 2. 브랜치 이름 변경 ────────────────────────────────────────

export interface RenameBranchDialogProps {
  open: boolean;
  onClose: () => void;
  onSubmit: (from: string, to: string) => void;
  /** 바꿀 대상 브랜치 */
  branch: string;
  existingNames?: string[];
}

export function RenameBranchDialog({
  open,
  onClose,
  onSubmit,
  branch,
  existingNames = [],
}: RenameBranchDialogProps) {
  const id = useId();
  const [name, setName] = useState(branch);

  useResetOnOpen(open, () => setName(branch));

  const problem =
    name === branch
      ? "Pick a different name."
      : existingNames.includes(name)
        ? `A branch named ${name} already exists.`
        : refNameProblem(name);

  return (
    <DialogFrame
      open={open}
      title="Rename branch"
      onClose={onClose}
      onSubmit={() => onSubmit(branch, name)}
      submitLabel="Rename"
      disabledReason={problem}
    >
      <Field label="Current name">
        <div className="dlg-mono">{branch}</div>
      </Field>
      <Field label="New name" htmlFor={`${id}-name`}>
        <input
          id={`${id}-name`}
          className={problem === null ? "dlg-input" : "dlg-input bad"}
          value={name}
          onChange={(e) => setName(e.target.value)}
          spellCheck={false}
          autoComplete="off"
          autoFocus
        />
      </Field>
      <div className="dlg-note">
        Renaming a local branch does not rename it on the remote. Push and delete the old remote
        branch separately.
      </div>
    </DialogFrame>
  );
}

// ── 3. 태그 생성 ───────────────────────────────────────────────

export interface CreateTagDialogProps {
  open: boolean;
  onClose: () => void;
  onSubmit: (name: string, target: string, message: string | null) => void;
  /** 기본 대상. 보통 선택된 커밋 sha */
  defaultTarget?: string;
  refs?: string[];
  existingNames?: string[];
}

export function CreateTagDialog({
  open,
  onClose,
  onSubmit,
  defaultTarget = "HEAD",
  refs = [],
  existingNames = [],
}: CreateTagDialogProps) {
  const id = useId();
  const [name, setName] = useState("");
  const [target, setTarget] = useState(defaultTarget);
  const [annotated, setAnnotated] = useState(false);
  const [message, setMessage] = useState("");

  useResetOnOpen(open, () => {
    setName("");
    setTarget(defaultTarget);
    setAnnotated(false);
    setMessage("");
  });

  const nameProblem =
    name === ""
      ? "Name is required."
      : existingNames.includes(name)
        ? `A tag named ${name} already exists.`
        : refNameProblem(name);
  const problem =
    nameProblem !== null
      ? nameProblem
      : annotated && message.trim() === ""
        ? "An annotated tag needs a message."
        : null;

  return (
    <DialogFrame
      open={open}
      title="Create tag"
      onClose={onClose}
      onSubmit={() => onSubmit(name, target, annotated ? message : null)}
      submitLabel="Create tag"
      disabledReason={name === "" ? null : problem}
      blocked={problem !== null}
    >
      <Field label="Tag name" htmlFor={`${id}-name`}>
        <input
          id={`${id}-name`}
          className={nameProblem === null || name === "" ? "dlg-input" : "dlg-input bad"}
          value={name}
          placeholder="v1.2.0"
          onChange={(e) => setName(e.target.value)}
          spellCheck={false}
          autoComplete="off"
          autoFocus
        />
      </Field>
      <Field label="Target" htmlFor={`${id}-target`}>
        <RefCombo id={`${id}-target`} value={target} onChange={setTarget} options={refs} />
      </Field>
      <Check
        checked={annotated}
        onChange={setAnnotated}
        label="Annotated"
        note="Stores a tagger, a date, and a message as its own git object."
      />
      {annotated && (
        <Field label="Message" htmlFor={`${id}-msg`}>
          <textarea
            id={`${id}-msg`}
            className="dlg-textarea"
            value={message}
            onChange={(e) => setMessage(e.target.value)}
          />
        </Field>
      )}
    </DialogFrame>
  );
}

// ── 4. 브랜치 리셋 ─────────────────────────────────────────────

export type ResetMode = "soft" | "mixed" | "hard";

const RESET_MODES: { mode: ResetMode; label: string; note: string }[] = [
  {
    mode: "soft",
    label: "Soft",
    note: "Moves the branch only. Your changes stay staged.",
  },
  {
    mode: "mixed",
    label: "Mixed",
    note: "Moves the branch and clears the index. File changes stay in the working tree.",
  },
  {
    mode: "hard",
    label: "Hard",
    note: "Moves the branch and throws your file changes away.",
  },
];

export interface ResetBranchDialogProps {
  open: boolean;
  onClose: () => void;
  onSubmit: (target: string, mode: ResetMode) => void;
  /** 되돌릴 지점. 보통 선택된 커밋 sha */
  target: string;
  /** 리셋될 브랜치 이름 (표시용) */
  branch?: string | null;
}

export function ResetBranchDialog({
  open,
  onClose,
  onSubmit,
  target,
  branch,
}: ResetBranchDialogProps) {
  const [mode, setMode] = useState<ResetMode>("mixed");

  useResetOnOpen(open, () => setMode("mixed"));

  const hard = mode === "hard";

  return (
    <DialogFrame
      open={open}
      title="Reset branch"
      onClose={onClose}
      onSubmit={() => onSubmit(target, mode)}
      submitLabel={hard ? "Reset and discard changes" : "Reset"}
      danger={hard}
    >
      <div className="dlg-note">
        Moves {branch != null && branch !== "" ? branch : "the current branch"} to{" "}
        <span className="dlg-mono">{target}</span>.
      </div>
      <div style={{ marginTop: 8 }}>
        {RESET_MODES.map((m) => {
          const on = m.mode === mode;
          const danger = m.mode === "hard";
          return (
            <label
              key={m.mode}
              className={[
                "dlg-radio",
                on ? "on" : "",
                danger ? "danger" : "",
              ]
                .filter((c) => c !== "")
                .join(" ")}
            >
              <input
                type="radio"
                name="reset-mode"
                checked={on}
                onChange={() => setMode(m.mode)}
              />
              <span>
                <span className="dlg-radio-title">{m.label}</span>
                <span className="dlg-radio-note">{m.note}</span>
              </span>
            </label>
          );
        })}
      </div>
      {hard && (
        <div className="cd-undo danger">
          <span className="cd-undo-key">Undo</span>
          <span>
            Commits can be recovered from the reflog, but uncommitted file changes cannot. They are
            gone for good.
          </span>
        </div>
      )}
    </DialogFrame>
  );
}

// ── 5. 머지 옵션 ───────────────────────────────────────────────

export interface MergeOptionsDialogProps {
  open: boolean;
  onClose: () => void;
  onSubmit: (source: string, opts: { noFf: boolean; squash: boolean }) => void;
  /** 합칠 원본 브랜치 */
  source: string;
  /** 현재 브랜치 (표시용) */
  target?: string | null;
}

export function MergeOptionsDialog({
  open,
  onClose,
  onSubmit,
  source,
  target,
}: MergeOptionsDialogProps) {
  const [noFf, setNoFf] = useState(false);
  const [squash, setSquash] = useState(false);

  useResetOnOpen(open, () => {
    setNoFf(false);
    setSquash(false);
  });

  return (
    <DialogFrame
      open={open}
      title="Merge"
      onClose={onClose}
      onSubmit={() => onSubmit(source, { noFf, squash })}
      submitLabel="Merge"
    >
      <div className="dlg-note">
        Merges <span className="dlg-mono">{source}</span> into{" "}
        <span className="dlg-mono">{target != null && target !== "" ? target : "the current branch"}</span>.
      </div>
      <Check
        checked={noFf}
        onChange={(next) => {
          setNoFf(next);
          // --no-ff와 --squash는 같이 쓸 수 없다. squash는 커밋을 아예 안 만든다
          if (next) {
            setSquash(false);
          }
        }}
        label="Create a merge commit even if fast-forward possible (--no-ff)"
        note="Keeps the branch visible as its own lane in the graph."
      />
      <Check
        checked={squash}
        onChange={(next) => {
          setSquash(next);
          if (next) {
            setNoFf(false);
          }
        }}
        label="Squash"
        note="Stages the combined change without committing and without recording the merge."
      />
    </DialogFrame>
  );
}

// ── 6. 리베이스 옵션 ───────────────────────────────────────────

export interface RebaseOptionsDialogProps {
  open: boolean;
  onClose: () => void;
  onSubmit: (upstream: string, onto: string | null, autostash: boolean) => void;
  /** 올라탈 대상 */
  upstream: string;
  refs?: string[];
  /** 리베이스될 브랜치 (표시용) */
  branch?: string | null;
}

export function RebaseOptionsDialog({
  open,
  onClose,
  onSubmit,
  upstream,
  refs = [],
  branch,
}: RebaseOptionsDialogProps) {
  const id = useId();
  const [onto, setOnto] = useState("");
  const [autostash, setAutostash] = useState(true);

  useResetOnOpen(open, () => {
    setOnto("");
    setAutostash(true);
  });

  return (
    <DialogFrame
      open={open}
      title="Rebase"
      onClose={onClose}
      onSubmit={() => onSubmit(upstream, onto.trim() === "" ? null : onto.trim(), autostash)}
      submitLabel="Rebase"
    >
      <div className="dlg-note">
        Replays{" "}
        <span className="dlg-mono">{branch != null && branch !== "" ? branch : "the current branch"}</span>{" "}
        on top of <span className="dlg-mono">{upstream}</span>. The replayed commits get new shas.
      </div>
      <Check
        checked={autostash}
        onChange={setAutostash}
        label="Autostash"
        note="Stashes uncommitted changes first and restores them when the rebase ends."
      />
      <details className="dlg-more">
        <summary>Advanced: rebase onto a different base</summary>
        <Field label="Onto" htmlFor={`${id}-onto`}>
          <RefCombo
            id={`${id}-onto`}
            value={onto}
            onChange={setOnto}
            options={refs}
            placeholder="leave empty to use the upstream above"
          />
          <div className="dlg-note">
            Takes the commits that upstream does not have and puts them on this ref instead. Use it
            to move a branch off the wrong parent.
          </div>
        </Field>
      </details>
    </DialogFrame>
  );
}

// ── 7. upstream 설정 ───────────────────────────────────────────

export interface SetUpstreamDialogProps {
  open: boolean;
  onClose: () => void;
  /** upstream이 null이면 --unset-upstream */
  onSubmit: (branch: string, upstream: string | null) => void;
  branch: string;
  /** "origin/main" 형태의 후보 목록 */
  remoteBranches?: string[];
  currentUpstream?: string | null;
}

export function SetUpstreamDialog({
  open,
  onClose,
  onSubmit,
  branch,
  remoteBranches = [],
  currentUpstream,
}: SetUpstreamDialogProps) {
  const id = useId();
  const [value, setValue] = useState(currentUpstream ?? "");

  useResetOnOpen(open, () => setValue(currentUpstream ?? ""));

  const hasUpstream = currentUpstream != null && currentUpstream !== "";

  return (
    <DialogFrame
      open={open}
      title="Set upstream"
      onClose={onClose}
      onSubmit={() => onSubmit(branch, value.trim() === "" ? null : value.trim())}
      submitLabel="Set upstream"
      disabledReason={value.trim() === "" ? "Pick a remote branch, or use Unset." : null}
      aside={
        hasUpstream ? (
          <button type="button" className="dlg-btn" onClick={() => onSubmit(branch, null)}>
            Unset
          </button>
        ) : undefined
      }
    >
      <Field label="Local branch">
        <div className="dlg-mono">{branch}</div>
      </Field>
      <Field label="Upstream" htmlFor={`${id}-up`}>
        <RefCombo
          id={`${id}-up`}
          value={value}
          onChange={setValue}
          options={remoteBranches}
          placeholder="origin/main"
        />
        <div className="dlg-note">
          Pull and push use this branch when you give them no arguments, and the toolbar counts
          ahead and behind against it.
        </div>
      </Field>
    </DialogFrame>
  );
}

// ── 8. remote 추가 / 편집 ──────────────────────────────────────

export interface RemoteDialogProps {
  open: boolean;
  onClose: () => void;
  /** 편집 모드면 originalName이 주어지고, 이름이 바뀌었으면 rename도 필요하다 */
  onSubmit: (name: string, url: string, originalName: string | null) => void;
  /** null이면 추가 모드 */
  remote?: { name: string; url: string } | null;
  existingNames?: string[];
}

export function RemoteDialog({
  open,
  onClose,
  onSubmit,
  remote = null,
  existingNames = [],
}: RemoteDialogProps) {
  const id = useId();
  const [name, setName] = useState(remote?.name ?? "");
  const [url, setUrl] = useState(remote?.url ?? "");

  useResetOnOpen(open, () => {
    setName(remote?.name ?? "");
    setUrl(remote?.url ?? "");
  });

  const editing = remote !== null;
  const taken = existingNames.filter((n) => n !== remote?.name).includes(name);
  const problem =
    name.trim() === ""
      ? "Name is required."
      : /\s/.test(name)
        ? "Name cannot contain spaces."
        : taken
          ? `A remote named ${name} already exists.`
          : url.trim() === ""
            ? "URL is required."
            : null;

  return (
    <DialogFrame
      open={open}
      title={editing ? "Edit remote" : "Add remote"}
      onClose={onClose}
      onSubmit={() => onSubmit(name.trim(), url.trim(), remote?.name ?? null)}
      submitLabel={editing ? "Save" : "Add remote"}
      disabledReason={name === "" && url === "" ? null : problem}
      blocked={problem !== null}
    >
      <Field label="Name" htmlFor={`${id}-name`}>
        <input
          id={`${id}-name`}
          className="dlg-input"
          value={name}
          placeholder="origin"
          onChange={(e) => setName(e.target.value)}
          spellCheck={false}
          autoComplete="off"
          autoFocus={!editing}
        />
      </Field>
      <Field label="URL" htmlFor={`${id}-url`}>
        <input
          id={`${id}-url`}
          className="dlg-input"
          value={url}
          placeholder="git@github.com:owner/repo.git"
          onChange={(e) => setUrl(e.target.value)}
          spellCheck={false}
          autoComplete="off"
          autoFocus={editing}
        />
      </Field>
    </DialogFrame>
  );
}

// ── 9. 워크트리 추가 ───────────────────────────────────────────

export interface AddWorktreeDialogProps {
  open: boolean;
  onClose: () => void;
  onSubmit: (dir: string, branch: string, createBranch: boolean) => void;
  /** 네이티브 파일 다이얼로그는 ui-hub 소관이라 콜백으로만 받는다 */
  onPickDirectory?: () => Promise<string | null>;
  refs?: string[];
  existingBranches?: string[];
}

export function AddWorktreeDialog({
  open,
  onClose,
  onSubmit,
  onPickDirectory,
  refs = [],
  existingBranches = [],
}: AddWorktreeDialogProps) {
  const id = useId();
  const [dir, setDir] = useState("");
  const [branch, setBranch] = useState("");
  const [createBranch, setCreateBranch] = useState(false);
  const [picking, setPicking] = useState(false);

  useResetOnOpen(open, () => {
    setDir("");
    setBranch("");
    setCreateBranch(false);
    setPicking(false);
  });

  const branchProblem =
    branch.trim() === ""
      ? "Branch is required."
      : createBranch
        ? existingBranches.includes(branch)
          ? `A branch named ${branch} already exists.`
          : refNameProblem(branch)
        : null;
  const problem = dir.trim() === "" ? "Directory is required." : branchProblem;

  return (
    <DialogFrame
      open={open}
      title="Add worktree"
      onClose={onClose}
      onSubmit={() => onSubmit(dir.trim(), branch.trim(), createBranch)}
      submitLabel="Add worktree"
      disabledReason={dir === "" && branch === "" ? null : problem}
      blocked={problem !== null}
    >
      <Field label="Directory" htmlFor={`${id}-dir`}>
        <div className="dlg-row">
          <div className="dlg-field" style={{ marginTop: 0 }}>
            <input
              id={`${id}-dir`}
              className="dlg-input"
              value={dir}
              placeholder="/path/to/new-worktree"
              onChange={(e) => setDir(e.target.value)}
              spellCheck={false}
              autoComplete="off"
              autoFocus
            />
          </div>
          {onPickDirectory !== undefined && (
            <button
              type="button"
              className="dlg-btn"
              disabled={picking}
              onClick={() => {
                setPicking(true);
                void onPickDirectory()
                  .then((picked) => {
                    if (picked !== null) {
                      setDir(picked);
                    }
                  })
                  .finally(() => setPicking(false));
              }}
            >
              Browse
            </button>
          )}
        </div>
        <div className="dlg-note">The directory must not exist yet, or must be empty.</div>
      </Field>
      <Field label="Branch" htmlFor={`${id}-branch`}>
        <RefCombo
          id={`${id}-branch`}
          value={branch}
          onChange={setBranch}
          options={createBranch ? [] : refs}
          placeholder={createBranch ? "new-branch-name" : "existing branch"}
        />
      </Field>
      <Check
        checked={createBranch}
        onChange={setCreateBranch}
        label="Create new branch"
        note="A branch already checked out in another worktree cannot be checked out again."
      />
    </DialogFrame>
  );
}

// ── 10. 스태시 ─────────────────────────────────────────────────

export interface StashDialogProps {
  open: boolean;
  onClose: () => void;
  onSubmit: (opts: {
    message?: string;
    includeUntracked?: boolean;
    keepIndex?: boolean;
  }) => void;
}

export function StashDialog({ open, onClose, onSubmit }: StashDialogProps) {
  const id = useId();
  const [message, setMessage] = useState("");
  const [includeUntracked, setIncludeUntracked] = useState(false);
  const [keepIndex, setKeepIndex] = useState(false);

  useResetOnOpen(open, () => {
    setMessage("");
    setIncludeUntracked(false);
    setKeepIndex(false);
  });

  return (
    <DialogFrame
      open={open}
      title="Stash changes"
      onClose={onClose}
      onSubmit={() =>
        onSubmit({
          message: message.trim() === "" ? undefined : message.trim(),
          includeUntracked,
          keepIndex,
        })
      }
      submitLabel="Stash"
    >
      <Field label="Message (optional)" htmlFor={`${id}-msg`}>
        <input
          id={`${id}-msg`}
          className="dlg-input"
          value={message}
          placeholder="what you were in the middle of"
          onChange={(e) => setMessage(e.target.value)}
          autoComplete="off"
          autoFocus
        />
      </Field>
      <Check
        checked={includeUntracked}
        onChange={setIncludeUntracked}
        label="Include untracked files"
        note="Without this, new files git does not track yet are left behind."
      />
      <Check
        checked={keepIndex}
        onChange={setKeepIndex}
        label="Keep index"
        note="Leaves what you already staged in the working tree."
      />
    </DialogFrame>
  );
}
