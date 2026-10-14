// 커밋 메시지에서 PR(머지 요청) 번호를 찾아 웹 URL을 만든다.
// API 호출 없이 호스팅 서비스가 머지할 때 남기는 메시지 관례만 본다.
// 관례 자체가 호스트 종류를 말해 주므로 remote 호스트 이름은 보지 않는다 (GHE, 자체 GitLab도 그대로 동작).

export interface PrRef {
  number: number;
  /** subject 안에서 링크로 바꿀 토큰 ("#61")과 시작 위치. 본문에서 찾았으면 null */
  token: { text: string; start: number } | null;
  url: string;
}

interface Convention {
  /** 1번 그룹이 번호 */
  pattern: RegExp;
  where: "subject" | "body";
  path: string;
  tokenPrefix: string | null;
}

// 순서가 우선순위다. 머지 커밋 관례가 squash 꼬리 "(#N)"보다 확실하다
const CONVENTIONS: Convention[] = [
  // GitHub merge commit: "Merge pull request #61 from nobel6018/release/v0.20.1"
  { pattern: /^Merge pull request #(\d+) from /, where: "subject", path: "pull", tokenPrefix: "#" },
  // Bitbucket: "Merged in feature/x (pull request #7)"
  { pattern: /\(pull request #(\d+)\)/, where: "subject", path: "pull-requests", tokenPrefix: "#" },
  // GitHub squash merge: "feat: something (#123)"
  { pattern: /\(#(\d+)\)\s*$/, where: "subject", path: "pull", tokenPrefix: "#" },
  // GitLab merge commit 본문: "See merge request team/app!12"
  { pattern: /^See merge request \S+!(\d+)\s*$/m, where: "body", path: "-/merge_requests", tokenPrefix: null },
];

export function findPrRef(params: { subject: string; body: string; remoteUrl: string }): PrRef | null {
  const base = params.remoteUrl.replace(/\/+$/, "");
  for (const c of CONVENTIONS) {
    const match = c.pattern.exec(c.where === "subject" ? params.subject : params.body);
    if (match === null) {
      continue;
    }
    const number = Number(match[1]);
    const text = c.tokenPrefix === null ? null : `${c.tokenPrefix}${match[1]}`;
    return {
      number,
      token: text === null ? null : { text, start: match.index + match[0].indexOf(text) },
      url: `${base}/${c.path}/${number}`,
    };
  }
  return null;
}

/** subject를 PR 토큰 앞, 토큰, 뒤로 나눈다. "Fix #12 (#34)"에서 링크는 패턴이 잡은 #34에만 붙는다 */
export function splitSubject(params: { subject: string; token: { text: string; start: number } }): [string, string, string] {
  const { subject, token } = params;
  const end = token.start + token.text.length;
  return [subject.slice(0, token.start), token.text, subject.slice(end)];
}
