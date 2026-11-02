// Modo desenvolvimento: Vite (renderer) + esbuild watch (main/preload) + Electron.
import { spawn } from 'node:child_process';

const run = (cmd, args, env = {}) =>
  spawn(cmd, args, { stdio: 'inherit', env: { ...process.env, ...env } });

const vite = run('npx', ['vite']);
run('node', ['scripts/build-electron.mjs', '--watch']);

const waitOn = run('npx', ['wait-on', 'http://localhost:5173', 'dist/main/index.js', 'dist/preload/index.js']);
waitOn.on('exit', (code) => {
  if (code !== 0) process.exit(code ?? 1);
  const electron = run('npx', ['electron', '.'], { STUDIO_DEV_URL: 'http://localhost:5173' });
  electron.on('exit', () => {
    vite.kill();
    process.exit(0);
  });
});
