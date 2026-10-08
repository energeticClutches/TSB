import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'astro/config';

// The marketing page is static HTML: no ordering code, no database, nothing to attack.
export default defineConfig({
  site: process.env.SITE_URL || 'https://theslushbar.example',
  vite: { plugins: [tailwindcss()] },
  build: { inlineStylesheets: 'always' },
});
