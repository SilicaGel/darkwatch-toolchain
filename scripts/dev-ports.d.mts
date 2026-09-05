// Type surface for scripts/dev-ports.mjs (#2538).
//
// The resolver is plain ESM JavaScript so bash, Vite's config loader, and node
// can all consume it without a build step. This declaration exists so the
// TypeScript consumers — tests/playwright.config.ts and the qa-check tools,
// which ARE typechecked (tests/tsconfig.json) — import it as a typed module
// instead of tripping noImplicitAny.

export type DevPortService =
  | "client"
  | "server"
  | "qaClient"
  | "qaServer"
  | "minioApi"
  | "minioConsole"
  | "www"
  | "brochure"
  | "brochureServer"
  | "brochureClient";

export type DevPorts = Record<DevPortService, number>;

export const DEV_PORT_BLOCK_BASE: number;
export const DEV_PORT_BLOCK_SPAN: number;
export const DEV_PORT_OFFSETS: Readonly<Record<DevPortService, number>>;
export const DEV_PORT_SERVICES: readonly DevPortService[];

export function resolveDevPorts(input?: {
  overrides?: Partial<Record<DevPortService, string | number | null | undefined>>;
  laneOffset?: number;
}): DevPorts;

export function devUrl(port: number, options?: { host?: string; protocol?: string }): string;
