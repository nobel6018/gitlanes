// WIP 패널 하단에 고정되는 커밋 입력창. 계약: CONTRACTS.md v0.18 "ui-wip".
// 쓰기는 전부 RepoActions.commit을 거친다 (확인 다이얼로그와 토스트는 ui-hub 몫).
import { useCallback, useEffect, useRef, useState } from "react";
import type { ChangeEvent, KeyboardEvent } from "react";
import { withKbd } from "./shortcuts";
import type { WipActions } from "./WipDetailPanel";

/** subject 권장 길이. 넘으면 옅은 경고만 띄우고 커밋은 막지 않는다 */
const SUBJECT_LIMIT = 50;
/** 본문 줄바꿈 권장 폭. textarea 뒤에 세로 눈금선으로 그린다 */
const BODY_GUIDE = 72;
const MIN_ROWS = 3;
const MAX_ROWS = 12;
/** wip.css의 .cb-input line-height와 일치해야 한다 */
const ROW_HEIGHT = 18;
const INPUT_PADDING = 12;

const DRAFT_PREFIX = "gitlanes.draft.";

function readDraft(repoPath: string): string {
  try {
    return localStorage.getItem(DRAFT_PREFIX + repoPath) ?? "";
  } catch {
    return "";
  }
}

function writeDraft(repoPath: string, message: string) {
  try {
    if (message === "") {
      localStorage.removeItem(DRAFT_PREFIX + repoPath);
    } else {
      localStorage.setItem(DRAFT_PREFIX + repoPath, message);
    }
  } catch {
    // localStorage가 막혀 있으면 초안 복원만 포기한다
  }
}

export interface CommitBoxProps {
  /** 초안 저장 키에 쓴다 */
  repoPath: string;
  /** 버튼 문구와 활성 여부를 정한다 */
  stagedCount: number;
  actions: WipActions;
  /** Amend 체크 시 마지막 커밋 메시지를 받아온다. 없으면 빈 채로 둔다 */
  onRequestLastMessage?: () => Promise<string>;
}

export function CommitBox({ repoPath, stagedCount, actions, onRequestLastMessage }: CommitBoxProps) {
  const [message, setMessage] = useState(() => readDraft(repoPath));
  const [amend, setAmend] = useState(false);
  const [signoff, setSignoff] = useState(false);
  const [gpgSign, setGpgSign] = useState(false);
  const [committing, setCommitting] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  /** Amend를 껐을 때 되돌릴 원래 초안 */
  const beforeAmendRef = useRef<string | null>(null);

  // 레포가 바뀌면 그 레포의 초안을 꺼내 온다
  useEffect(() => {
    setMessage(readDraft(repoPath));
    setAmend(false);
    beforeAmendRef.current = null;
  }, [repoPath]);

  const resize = useCallback(() => {
    const el = inputRef.current;
    if (el === null) {
      return;
    }
    // scrollHeight를 재려면 먼저 높이를 풀어야 한다
    el.style.height = "auto";
    const min = MIN_ROWS * ROW_HEIGHT + INPUT_PADDING;
    const max = MAX_ROWS * ROW_HEIGHT + INPUT_PADDING;
    el.style.height = `${Math.min(Math.max(el.scrollHeight, min), max)}px`;
  }, []);

  useEffect(resize, [message, resize]);

  function changeMessage(event: ChangeEvent<HTMLTextAreaElement>) {
    const next = event.target.value;
    setMessage(next);
    writeDraft(repoPath, next);
  }

  async function toggleAmend() {
    const next = !amend;
    setAmend(next);
    if (!next) {
      // Amend를 풀면 원래 쓰던 초안으로 돌아간다
      const restored = beforeAmendRef.current ?? "";
      beforeAmendRef.current = null;
      setMessage(restored);
      writeDraft(repoPath, restored);
      return;
    }
    beforeAmendRef.current = message;
    if (onRequestLastMessage === undefined) {
      return;
    }
    try {
      const last = await onRequestLastMessage();
      if (last !== "") {
        setMessage(last);
        writeDraft(repoPath, last);
      }
    } catch {
      // 마지막 메시지를 못 가져오면 쓰던 내용을 그대로 둔다
    }
  }

  const busy = actions.busy || committing;
  const trimmed = message.trim();
  const canCommit = trimmed !== "" && (stagedCount > 0 || amend) && !busy;

  async function runCommit() {
    if (!canCommit) {
      return;
    }
    setCommitting(true);
    try {
      await actions.commit({
        message: trimmed,
        amend,
        signoff,
        gpgSign,
        allowEmpty: false,
        stageAll: false,
      });
      // 성공했을 때만 비운다. 실패하면 사용자가 다시 쓰지 않게 그대로 둔다
      setMessage("");
      writeDraft(repoPath, "");
      setAmend(false);
      beforeAmendRef.current = null;
    } catch {
      // 실패 알림은 ui-hub의 토스트가 맡는다
    } finally {
      setCommitting(false);
    }
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      void runCommit();
    }
  }

  const subject = message.split("\n", 1)[0];
  const over = subject.length - SUBJECT_LIMIT;
  const label = amend
    ? "Amend commit"
    : stagedCount === 1
      ? "Commit 1 file"
      : `Commit ${stagedCount} files`;

  return (
    <div className="cb-root">
      <div className="cb-input-wrap">
        <textarea
          ref={inputRef}
          className="cb-input"
          value={message}
          onChange={changeMessage}
          onKeyDown={handleKeyDown}
          placeholder={amend ? "Amend the last commit…" : "Commit message"}
          spellCheck={false}
          aria-label="Commit message"
          style={{ backgroundSize: `${BODY_GUIDE}ch 100%` }}
        />
        {over > 0 && (
          <span className="cb-over" title={`subject 권장 ${SUBJECT_LIMIT}자`}>
            {subject.length}/{SUBJECT_LIMIT}
          </span>
        )}
      </div>

      <div className="cb-opts">
        <label className="cb-opt">
          <input type="checkbox" checked={amend} onChange={() => void toggleAmend()} />
          <span>Amend last commit</span>
        </label>
        <label className="cb-opt">
          <input type="checkbox" checked={signoff} onChange={() => setSignoff(!signoff)} />
          <span>Sign-off</span>
        </label>
        <label className="cb-opt">
          <input type="checkbox" checked={gpgSign} onChange={() => setGpgSign(!gpgSign)} />
          <span>Sign with GPG</span>
        </label>
      </div>

      <div className="cb-foot">
        {stagedCount === 0 && !amend && <span className="cb-hint">Stage changes to commit</span>}
        <button
          className="cb-commit"
          onClick={() => void runCommit()}
          disabled={!canCommit}
          title={withKbd(label, "Mod+Enter")}
        >
          {busy && <span className="cb-spinner" aria-hidden="true" />}
          {label}
        </button>
      </div>
    </div>
  );
}
