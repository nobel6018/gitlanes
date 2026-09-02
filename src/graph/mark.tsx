// 검색어 하이라이트. MESSAGE/AUTHOR/SHA 셀의 매치 구간을 <mark>로 감싼다.
// 5만 행 스크롤에서 행마다 도는 코드라 정규식을 만들지 않고 indexOf 루프로 자른다.
// @see CONTRACTS.md "v0.11 확장" - GraphView props 추가
import type { ReactNode } from "react";

/**
 * 대소문자 무시 부분일치 구간 전부를 <mark>로 감싼 노드를 만든다.
 * 매치가 없거나 query가 비면 원본 문자열을 그대로 돌려줘서 DOM이 늘어나지 않는다.
 */
export function highlightText(text: string, query: string): ReactNode {
  if (query.length === 0 || text.length === 0) {
    return text;
  }
  const haystack = text.toLowerCase();
  const needle = query.toLowerCase();
  // 소문자화로 길이가 변하는 문자(İ 등)가 섞이면 인덱스가 원본과 어긋난다. 그럴 땐 강조를 건너뛴다
  if (haystack.length !== text.length || needle.length !== query.length) {
    return text;
  }
  let at = haystack.indexOf(needle);
  if (at < 0) {
    return text;
  }

  const parts: ReactNode[] = [];
  let from = 0;
  let key = 0;
  while (at >= 0) {
    if (at > from) {
      parts.push(text.slice(from, at));
    }
    parts.push(
      <mark className="gl-mark" key={key++}>
        {text.slice(at, at + needle.length)}
      </mark>,
    );
    from = at + needle.length;
    at = haystack.indexOf(needle, from);
  }
  if (from < text.length) {
    parts.push(text.slice(from));
  }
  return parts;
}
