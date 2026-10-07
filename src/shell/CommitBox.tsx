// WIP 패널 하단에 고정되는 커밋 입력창. 계약: CONTRACTS.md v0.18 "ui-wip".
// 쓰기는 전부 RepoActions.commit을 거친다 (확인 다이얼로그와 토스트는 ui-hub 몫).
import { useCallback, useEffect, useRef, useState } from "react";
import type { ChangeEvent, KeyboardEvent } from "react";
import { getCommitTemplate } from "./api";
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
/**
 * Amend 중에 고치는 메시지는 이 키에만 쓴다. 원래 초안(DRAFT_PREFIX)은 amend 동안 건드리지 않아서
 * 언마운트, 탭 닫기, amend 성공 어느 경로로 끝나도 원래 초안이 남는다. 키가 있으면 amend 중이라는 뜻이라
 * 다시 마운트될 때 amend 상태로 돌아온다. 빈 메시지도 ""로 저장해 상태를 잃지 않는다
 */
const AMEND_DRAFT_PREFIX = "gitlanes.draft.amend.";

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

/** amend 중이 아니면 null */
function readAmendDraft(repoPath: string): string | null {
  try {
    return localStorage.getItem(AMEND_DRAFT_PREFIX + repoPath);
  } catch {
    return null;
  }
}

/** null이면 amend 초안을 지운다(= amend 종료) */
function writeAmendDraft(repoPath: string, message: string | null) {
  try {
    if (message === null) {
      localStorage.removeItem(AMEND_DRAFT_PREFIX + repoPath);
    } else {
      localStorage.setItem(AMEND_DRAFT_PREFIX + repoPath, message);
    }
  } catch {
    // localStorage가 막혀 있으면 amend 초안 복원만 포기한다
  }
}

/**
 * 템플릿(commit.template)에서 온 `#` 주석 줄만 지운다. git_commit은 메시지를 -m으로 넘기고,
 * -m 커밋의 기본 cleanup은 whitespace라 git이 `#` 줄을 지우지 않는다. 템플릿의 안내 문구가
 * 그대로 커밋에 박히지 않게 여기서 걷어 낸다. 사용자가 직접 쓴 `#123` 같은 줄은 템플릿에
 * 없으므로 남는다. 줄 끝 공백 차이는 무시하고 비교한다
 */
export function stripTemplateComments(message: string, template: string | null): string {
  if (template === null) {
    return message;
  }
  const comments = new Set(
    template
      .split("\n")
      .map((line) => line.trimEnd())
      .filter((line) => line.startsWith("#")),
  );
  if (comments.size === 0) {
    return message;
  }
  return message
    .split("\n")
    .filter((line) => !comments.has(line.trimEnd()))
    .join("\n");
}

/** 마운트나 레포 전환 때 보여 줄 상태. amend 초안이 있으면 그쪽이 우선이다 */
function loadState(repoPath: string): { message: string; amend: boolean } {
  const amendDraft = readAmendDraft(repoPath);
  if (amendDraft !== null) {
    return { message: amendDraft, amend: true };
  }
  return { message: readDraft(repoPath), amend: false };
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
  const [initial] = useState(() => loadState(repoPath));
  const [message, setMessage] = useState(initial.message);
  const [amend, setAmend] = useState(initial.amend);
  const [signoff, setSignoff] = useState(false);
  const [gpgSign, setGpgSign] = useState(false);
  const [committing, setCommitting] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  /**
   * Amend 토글과 레포 전환마다 올린다. onRequestLastMessage 응답이 늦게 오면 그 사이 토글이 바뀌었을 수
   * 있어서, 요청할 때의 세대와 다르면 응답을 버린다
   */
  const amendGenRef = useRef(0);
  const repoRef = useRef(repoPath);
  /**
   * 이 레포의 commit.template 내용. 없으면 null. 메시지가 비면 채워 넣고, 커밋 직전에
   * 이 템플릿의 `#` 줄을 지우는 기준이 된다. 템플릿 채움은 초안(localStorage)에 쓰지 않는다.
   * 사용자가 고치기 시작해야 초안이 되고, 그 초안에 남은 템플릿 줄도 같은 기준으로 지워진다
   */
  const [template, setTemplate] = useState<string | null>(null);
  const templateRef = useRef<string | null>(null);
  templateRef.current = template;
  const messageRef = useRef(message);
  messageRef.current = message;
  const amendRef = useRef(amend);
  amendRef.current = amend;

  // 레포가 바뀌면 그 레포의 초안(amend 중이었으면 amend 초안)을 꺼내 오고 템플릿을 다시 읽는다
  useEffect(() => {
    repoRef.current = repoPath;
    amendGenRef.current += 1;
    const state = loadState(repoPath);
    setMessage(state.message);
    setAmend(state.amend);
    setTemplate(null);
    let alive = true;
    getCommitTemplate(repoPath)
      .then((text) => {
        if (!alive) {
          return;
        }
        const next = text === null || text.trim() === "" ? null : text;
        setTemplate(next);
        // 기다리는 사이 사용자가 쓰기 시작했거나 amend로 바꿨으면 건드리지 않는다
        if (next !== null && messageRef.current === "" && !amendRef.current) {
          setMessage(next);
        }
      })
      .catch(() => {
        // 템플릿을 못 읽으면 빈 메시지로 시작한다. 커밋 자체와는 무관하다
      });
    return () => {
      alive = false;
    };
  }, [repoPath]);

  /** 일반 커밋으로 돌아가며 보여 줄 메시지. 초안이 비었으면 템플릿을 깐다 */
  function withTemplate(draft: string): string {
    return draft === "" && templateRef.current !== null ? templateRef.current : draft;
  }

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
    if (amend) {
      writeAmendDraft(repoPath, next);
    } else {
      writeDraft(repoPath, next);
    }
  }

  async function toggleAmend() {
    const next = !amend;
    amendGenRef.current += 1;
    const gen = amendGenRef.current;
    setAmend(next);
    if (!next) {
      // Amend를 풀면 원래 쓰던 초안으로 돌아간다. 원래 초안 키는 amend 동안 그대로였다
      writeAmendDraft(repoPath, null);
      setMessage(withTemplate(readDraft(repoPath)));
      return;
    }
    // 마지막 메시지가 오기 전까지는 쓰던 내용을 amend 초안의 시작점으로 둔다
    writeAmendDraft(repoPath, message);
    if (onRequestLastMessage === undefined) {
      return;
    }
    const repo = repoPath;
    try {
      const last = await onRequestLastMessage();
      if (gen !== amendGenRef.current) {
        return;
      }
      if (last !== "") {
        setMessage(last);
        writeAmendDraft(repo, last);
      }
    } catch {
      // 마지막 메시지를 못 가져오면 쓰던 내용을 그대로 둔다
    }
  }

  const busy = actions.busy || committing;
  // 템플릿을 손대지 않고 그대로 둔 경우 지우고 나면 비므로 커밋을 막는다
  const trimmed = stripTemplateComments(message, template).trim();
  const canCommit = trimmed !== "" && (stagedCount > 0 || amend) && !busy;

  async function runCommit() {
    if (!canCommit) {
      return;
    }
    const repo = repoPath;
    const amended = amend;
    setCommitting(true);
    try {
      await actions.commit({
        message: trimmed,
        amend: amended,
        signoff,
        gpgSign,
        allowEmpty: false,
        stageAll: false,
      });
      // 성공했을 때만 비운다. 실패하면 사용자가 다시 쓰지 않게 그대로 둔다.
      // 커밋 중에는 textarea가 readOnly라 여기서 지우는 내용은 보낸 메시지뿐이다
      if (amended) {
        // amend 메시지만 버리고, amend 전에 쓰던 다음 커밋 초안은 그대로 돌려 놓는다
        writeAmendDraft(repo, null);
      } else {
        writeDraft(repo, "");
      }
      if (repoRef.current === repo) {
        amendGenRef.current += 1;
        setMessage(withTemplate(amended ? readDraft(repo) : ""));
        setAmend(false);
      }
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
          // 커밋 중 입력을 막는다(audit S-L4). 성공 시 "보낸 메시지와 같을 때만 비우기"는 amend 성공 때
          // 원래 초안으로 바꿔 끼우는 동작과 충돌한다. 그 사이 새로 친 글과 원래 초안 중 무엇을 남길지
          // 정할 수 없어서, 입력 자체를 막아 지울 내용이 보낸 메시지뿐이게 한다
          readOnly={committing}
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
          <input
            type="checkbox"
            checked={amend}
            disabled={committing}
            onChange={() => void toggleAmend()}
          />
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
