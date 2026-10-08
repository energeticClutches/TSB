import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv } from 'vite';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  return {
    plugins: [react(), tailwindcss()],
    server: {
      port: 5174,
      ...(env.VITE_SUPABASE_URL && env.VITE_DEMO !== 'true' && {
        proxy: {
          '/v1': { target: `${env.VITE_SUPABASE_URL}/functions/v1/api/v1`, changeOrigin: true, rewrite: (p) => p.replace(/^\/v1/, '') },
        },
      }),
    },
    build: {
      sourcemap: true,
      // Phase 6 §5: keep the first load small on 4G.
      chunkSizeWarningLimit: 250,
    },
  };
});
