// 텍스트 폭 실측. pill 넘침 판정이 글자 수 추정이면 긴 이름과 짧은 이름이
// 섞였을 때 "+N"이 잘못 뜨므로 canvas 2d의 measureText로 잰다.
// 5만 행 스크롤에서도 비용이 없도록 폰트별 컨텍스트 1개를 재사용하고 폭을 캐시한다.

/** 캐시가 무한정 커지지 않게 두는 상한. 넘으면 통째로 비운다 */
const CACHE_LIMIT = 4096;
/** canvas를 못 쓰는 환경(테스트 등)에서만 쓰는 글자당 폭 */
const FALLBACK_CHAR_WIDTH = 6.1;

const contexts = new Map<string, CanvasRenderingContext2D | null>();
const widths = new Map<string, number>();

function contextFor(font: string): CanvasRenderingContext2D | null {
  const cached = contexts.get(font);
  if (cached !== undefined) {
    return cached;
  }
  let ctx: CanvasRenderingContext2D | null = null;
  if (typeof document !== "undefined") {
    ctx = document.createElement("canvas").getContext("2d");
    if (ctx) {
      ctx.font = font;
    }
  }
  contexts.set(font, ctx);
  return ctx;
}

/** font는 canvas font 단축 표기("400 11px system-ui, sans-serif") */
export function measureText(text: string, font: string): number {
  const key = `${font} ${text}`;
  const cached = widths.get(key);
  if (cached !== undefined) {
    return cached;
  }
  const ctx = contextFor(font);
  const width = ctx ? ctx.measureText(text).width : text.length * FALLBACK_CHAR_WIDTH;
  if (widths.size >= CACHE_LIMIT) {
    widths.clear();
  }
  widths.set(key, width);
  return width;
}
