import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { defineConfig, loadEnv } from 'vite';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  // Demo mode (whole backend in the browser) unless a Supabase project is configured.
  const demo = env.VITE_DEMO === 'true' || (!env.VITE_SUPABASE_URL && env.VITE_DEMO !== 'false');
  return {
    plugins: [react(), tailwindcss()],
    define: { __DEMO__: JSON.stringify(demo) },
    // Production builds: swap PGlite for a stub so its WebAssembly (and its eval) never ship.
    ...(!demo && { resolve: { alias: [{ find: /^@electric-sql\/pglite(\/.*)?$/, replacement: fileURLToPath(new URL('./src/demo/pglite-stub.ts', import.meta.url)) }] } }),
    server: {
      port: 5173,
      // The admin app calls its API same-origin at /v1/* so the device cookie stays
      // first-party (SameSite=Strict). In production Cloudflare routes /v1/* the same way.
      ...(env.VITE_SUPABASE_URL && {
        proxy: {
          '/v1': { target: `${env.VITE_SUPABASE_URL}/functions/v1/api/v1`, changeOrigin: true, rewrite: (p) => p.replace(/^\/v1/, '') },
        },
      }),
    },
    // PGlite (demo mode only) ships its own WebAssembly files; don't pre-bundle it.
    optimizeDeps: { exclude: ['@electric-sql/pglite'] },
    build: { sourcemap: true },
  };
});
