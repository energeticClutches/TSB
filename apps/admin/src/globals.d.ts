/**
 * Build-time switch for demo mode (set in vite.config.ts). Being a constant, `false` lets the
 * bundler drop the demo code, PGlite and its WebAssembly from production builds entirely.
 */
declare const __DEMO__: boolean;
