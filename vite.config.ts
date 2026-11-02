import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';
import { buildCsp } from './src/main/security';

// Em produção a CSP também vai embutida no HTML (defesa em profundidade além do header
// aplicado pelo processo main). Em dev o Vite injeta script inline, então só o header dev vale.
const cspMeta = (): Plugin => ({
  name: 'csp-meta',
  apply: 'build',
  transformIndexHtml: (html) => html.replace('<head>', `<head>\n    <meta http-equiv="Content-Security-Policy" content="${buildCsp({ dev: false })}" />`),
});

export default defineConfig({
  root: resolve(__dirname, 'src/renderer'),
  base: './',
  plugins: [react(), cspMeta()],
  build: { outDir: resolve(__dirname, 'dist/renderer'), emptyOutDir: true, sourcemap: false },
  server: { port: 5173, strictPort: true },
});
