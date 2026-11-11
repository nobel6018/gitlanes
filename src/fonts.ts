// 번들 폰트(tokens.css의 @font-face) 로드 대기.
// RefPills가 canvas measureText로 pill 폭을 재고 결과를 캐시하므로,
// 폰트가 오기 전에 재면 폴백 폰트 폭이 캐시에 남아 "+N" 판정이 어긋난다.
// @see docs/design-system.md

/** 로컬 파일이라 보통 수 ms. 무슨 이유로든 늦어지면 이 시간 뒤에는 그냥 진행한다 */
const FONT_WAIT_LIMIT_MS = 1500;

const FACES = ['400 13px "Host Grotesk"', '700 11px "Host Grotesk"', '400 13px "Atkinson Hyperlegible Mono"'];

export function whenFontsReady(): Promise<void> {
  if (typeof document === "undefined" || !("fonts" in document)) {
    return Promise.resolve();
  }
  const loads = Promise.all(FACES.map((face) => document.fonts.load(face))).then(
    () => undefined,
    () => undefined,
  );
  const limit = new Promise<void>((resolve) => setTimeout(resolve, FONT_WAIT_LIMIT_MS));
  return Promise.race([loads, limit]);
}
