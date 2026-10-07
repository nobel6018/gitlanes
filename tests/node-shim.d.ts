// tests/*.mts가 쓰는 Node API의 최소 타입 선언.
// @types/node를 의존성으로 들이지 않고(package.json 동결) `npm run build`의 tsc가 테스트도 검사하게 하려고 둔다.
// 전역(Buffer, process)은 선언하지 않는다. 테스트는 node:buffer, node:process에서 import하므로
// src 코드에 Node 전역이 새어 들어가지 않는다. 테스트가 새 Node API를 쓰면 여기에 시그니처를 더한다.
// 시그니처는 Node 24 문서 기준으로 테스트가 쓰는 오버로드만 옮겼다.

declare module "node:buffer" {
  export type BufferEncoding = "utf8" | "hex" | "latin1";
  export class Buffer extends Uint8Array {
    static from(data: string, encoding?: BufferEncoding): Buffer;
    static from(data: ArrayLike<number>): Buffer;
    static alloc(size: number): Buffer;
    static concat(list: readonly Uint8Array[]): Buffer;
    equals(other: Uint8Array): boolean;
    toString(encoding?: BufferEncoding): string;
  }  export function isUtf8(input: Uint8Array): boolean;
}

declare module "node:process" {
  export type ProcessEnv = Record<string, string | undefined>;
  const process: {
    env: ProcessEnv;
    exitCode: number | undefined;
  };
  export default process;
}

declare module "node:child_process" {
  import type { Buffer } from "node:buffer";
  import type { ProcessEnv } from "node:process";
  type Stdio = "pipe" | "ignore" | "inherit";
  export interface SpawnOptions {
    env?: ProcessEnv;
    input?: string | Uint8Array;
    stdio?: Stdio | Stdio[];
  }
  export function execFileSync(file: string, args: readonly string[], options?: SpawnOptions): Buffer;
  export function spawnSync(
    command: string,
    args: readonly string[],
    options?: SpawnOptions,
  ): { status: number | null; stdout: Buffer; stderr: Buffer };
}

declare module "node:fs" {
  import type { Buffer } from "node:buffer";
  type Data = string | Uint8Array;
  export function appendFileSync(path: string, data: Data): void;
  export function chmodSync(path: string, mode: number): void;
  export function cpSync(src: string, dest: string, options?: { recursive?: boolean }): void;
  export function existsSync(path: string): boolean;
  export function mkdirSync(path: string, options?: { recursive?: boolean }): string | undefined;
  export function mkdtempSync(prefix: string): string;
  export function readFileSync(path: string): Buffer;
  export function rmSync(path: string, options?: { recursive?: boolean; force?: boolean }): void;
  export function statSync(path: string): { mode: number };
  export function writeFileSync(path: string, data: Data): void;
}

declare module "node:os" {
  export function tmpdir(): string;
}

declare module "node:path" {
  export function join(...paths: string[]): string;
  export function dirname(path: string): string;
}

declare module "node:perf_hooks" {
  export const performance: { now(): number };
}
