// Empacota main e preload com esbuild. Renderer é compilado pelo Vite.
import { build, context } from 'esbuild';

const watch = process.argv.includes('--watch');

const common = {
  bundle: true,
  platform: 'node',
  sourcemap: true,
  logLevel: 'info',
  // Mantém import() dinâmico intacto: pdfjs-dist é ESM puro.
  supported: { 'dynamic-import': true },
};

const targets = [
  {
    ...common,
    entryPoints: ['src/main/index.ts'],
    outfile: 'dist/main/index.js',
    format: 'cjs',
    target: 'node22',
    external: ['electron', 'pdfjs-dist'],
  },
  {
    ...common,
    entryPoints: ['src/preload/index.ts'],
    outfile: 'dist/preload/index.js',
    format: 'cjs',
    target: 'node22',
    // preload em sandbox só pode importar 'electron'
    external: ['electron'],
  },
];

if (watch) {
  for (const t of targets) await (await context(t)).watch();
} else {
  for (const t of targets) await build(t);
}
