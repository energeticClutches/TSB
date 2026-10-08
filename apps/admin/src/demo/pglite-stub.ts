/** Stands in for PGlite in production builds (demo mode off), so no database WebAssembly ships. */
export class PGlite {
  static create(): never {
    throw new Error('Demo mode is not part of this build.');
  }
}
export type Transaction = never;
export const citext = {};
export const pgcrypto = {};
