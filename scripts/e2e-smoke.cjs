// Smoke test E2E do app Electron REAL. Sem rede e sem chave: não toca na nuvem nem gasta franquia.
//   npm run e2e                      -> testa dist/ (rode `npm run build` antes)
//   STUDIO_EXECUTABLE=release/linux-unpacked/ollama-chat-studio npm run e2e   -> testa o app empacotado
//   E2E_SHOTS=/pasta npm run e2e     -> também salva screenshots
// Sem DISPLAY (servidor/CI), o script se relança sob xvfb-run automaticamente.
const { spawnSync } = require('node:child_process');
const { existsSync, mkdtempSync, mkdirSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');

const ROOT = resolve(__dirname, '..');

if (!process.env.DISPLAY && !process.env.E2E_NO_XVFB && process.platform === 'linux') {
  const r = spawnSync('xvfb-run', ['-a', '-s', '-screen 0 1440x900x24', process.execPath, __filename], { stdio: 'inherit', env: { ...process.env, E2E_NO_XVFB: '1' } });
  if (r.error) {
    console.error('Sem DISPLAY e sem xvfb-run. Instale: sudo apt install xvfb');
    process.exit(2);
  }
  process.exit(r.status ?? 1);
}

const { _electron: electron } = require('playwright-core');

function makePdf(text) {
  const stream = `BT /F1 14 Tf 20 100 Td (${text}) Tj ET`;
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Contents 4 0 R /Resources << /Font << /F1 << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> >> >> >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
  ];
  let out = '%PDF-1.4\n';
  const offs = [];
  objs.forEach((o, i) => {
    offs.push(out.length);
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + offs.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('');
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Array.from(Buffer.from(out));
}

let failed = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? '  ✓' : '  ✗'} ${name}${ok ? '' : `  -> ${detail}`}`);
  if (!ok) failed++;
};

(async () => {
  const packaged = process.env.STUDIO_EXECUTABLE ? resolve(ROOT, process.env.STUDIO_EXECUTABLE) : null;
  const executablePath = packaged ?? require(join(ROOT, 'node_modules/electron'));
  if (!existsSync(packaged ?? join(ROOT, 'dist/main/index.js'))) throw new Error('Nada para testar. Rode `npm run build` (ou `npm run dist:dir`).');
  const shots = process.env.E2E_SHOTS;
  if (shots) mkdirSync(shots, { recursive: true });
  console.log(`Alvo: ${packaged ? 'app empacotado' : 'dist/ + Electron do projeto'}`);

  const env = { ...process.env };
  delete env.OLLAMA_API_KEY;
  const args = ['--disable-gpu', '--disable-dev-shm-usage', `--user-data-dir=${mkdtempSync(join(tmpdir(), 'ocs-e2e-'))}`];
  // Como root (contêineres) o Chromium exige --no-sandbox; no desktop normal NÃO use.
  if (process.getuid && process.getuid() === 0) args.unshift('--no-sandbox');
  if (!packaged) args.push('.');

  const app = await electron.launch({ executablePath, cwd: ROOT, args, env });
  const page = await app.firstWindow();
  const consoleErrors = [];
  page.on('pageerror', (e) => consoleErrors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && !/Content Security Policy/.test(m.text()) && consoleErrors.push(m.text()));
  await page.waitForSelector('.app', { timeout: 30000 });
  await page.waitForTimeout(600);

  console.log('Isolamento do renderer');
  const iso = await page.evaluate(() => ({ req: typeof window.require, proc: typeof window.process, ipc: typeof window.ipcRenderer, keys: Object.keys(window.studio).length }));
  check('sem require/process/ipcRenderer no renderer', iso.req === 'undefined' && iso.proc === 'undefined' && iso.ipc === 'undefined', JSON.stringify(iso));
  check('ponte window.studio exposta', iso.keys >= 10);

  console.log('CSP efetiva');
  const csp = await page.evaluate(
    () =>
      new Promise((resolveP) => {
        const v = [];
        document.addEventListener('securitypolicyviolation', (e) => v.push(e.violatedDirective));
        window.__a = 0;
        window.__b = 0;
        const s = document.createElement('script');
        s.textContent = 'window.__a = 1';
        document.body.appendChild(s);
        setTimeout('window.__b = 1', 0);
        const net = fetch('https://example.com').then(() => 'passou', () => 'bloqueado');
        setTimeout(async () => resolveP({ a: window.__a, b: window.__b, v, net: await net }), 400);
      }),
  );
  check('script inline bloqueado', csp.a === 0);
  check('eval/string-timeout bloqueado', csp.b === 0 && csp.v.includes('script-src'), JSON.stringify(csp.v));
  check('rede externa a partir do renderer bloqueada (connect-src self)', csp.net === 'bloqueado');

  console.log('Main / IPC');
  const r = await page.evaluate(async (pdf) => {
    const s = window.studio;
    const out = {};
    out.models = (await s.models.list()).length;
    out.badIpc = await s.conversations.messages({ x: 1 }).then(() => 'aceitou', () => 'rejeitou');
    out.exe = await s.attachments.ingest({ name: 'x.png', mime: 'image/png', bytes: new Uint8Array([0x4d, 0x5a, 0, 0]) }).then(() => 'aceitou', () => 'rejeitou');
    out.pdf = await s.attachments.ingest({ name: 'a.pdf', mime: 'application/pdf', bytes: new Uint8Array(pdf) }).then((a) => a.kind + ':' + a.meta.pages, (e) => 'erro ' + e.message.slice(0, 120));
    out.verify = await s.models.verify().then((v) => v.tagsOk + '|' + v.errors[0], (e) => 'erro');
    const conv = await s.conversations.create('beam');
    out.conv = (await s.conversations.list()).some((c) => c.id === conv.id);
    await s.conversations.remove(conv.id);
    out.key = await s.secrets.set('chave-de-teste-nao-real-123456').then(
      async () => {
        const st = await s.secrets.status();
        await s.secrets.clear();
        return 'gravou-cifrado:' + st.secure;
      },
      (e) => 'recusou:' + e.message.slice(-70),
    );
    return out;
  }, makePdf('Smoke PDF ok'));
  check('7 modelos no catálogo', r.models === 7, r.models);
  check('payload IPC malformado rejeitado', r.badIpc === 'rejeitou');
  check('executável disfarçado de PNG rejeitado', r.exe === 'rejeitou');
  check('PDF extraído dentro do Electron (pdf.js empacotado)', r.pdf === 'pdf:1', r.pdf);
  check('verify() sem chave falha limpo, sem rede', r.verify.startsWith('false|/api/tags: Nenhuma chave'), r.verify);
  check('criar/listar/excluir conversa (SQLite)', r.conv === true);
  check('cofre: grava cifrado OU recusa (nunca texto puro)', r.key.startsWith('gravou-cifrado:true') || r.key.startsWith('recusou:'), r.key);
  console.log(`     (cofre neste ambiente: ${r.key})`);

  console.log('Gating na UI');
  await page.keyboard.press('Escape');
  await page.selectOption('select[aria-label="Modelo"]', 'beam');
  await page.waitForTimeout(250);
  const beam = await page.evaluate(() => document.querySelector('.hints')?.textContent ?? '');
  check('beam: imagem e vídeo desabilitados com motivo', /imagem: .*não tem visão/.test(beam) && /vídeo:/.test(beam), beam);
  await page.selectOption('select[aria-label="Modelo"]', 'gemma4:31b');
  await page.waitForTimeout(250);
  const gemma = await page.evaluate(() => ({ hints: document.querySelector('.hints')?.textContent ?? '', vision: document.querySelector('.topbar .chip.native')?.parentElement?.textContent ?? '' }));
  check('gemma4:31b: imagem liberada (sem aviso de visão)', !/imagem:/.test(gemma.hints), gemma.hints);
  await page.getByRole('button', { name: 'Parâmetros do modelo' }).click();
  const think = await page.evaluate(() => document.querySelector('.params select')?.disabled);
  check('thinking habilitado no gemma4:31b', think === false);
  await page.selectOption('select[aria-label="Modelo"]', 'nemotron-3-super');
  await page.waitForTimeout(250);
  check('nemotron-3-super: thinking desabilitado', (await page.evaluate(() => document.querySelector('.params select')?.disabled)) === true);

  check('sem erros inesperados no console', consoleErrors.length === 0, consoleErrors.join(' | '));
  if (shots) {
    await page.selectOption('select[aria-label="Modelo"]', 'gemma4:31b');
    await page.screenshot({ path: join(shots, 'main.png') });
    await page.getByRole('button', { name: 'Capacidades' }).click();
    await page.waitForTimeout(300);
    await page.screenshot({ path: join(shots, 'capacidades.png') });
  }
  await app.close();
  console.log(failed === 0 ? '\nE2E: TUDO OK' : `\nE2E: ${failed} FALHA(S)`);
  process.exit(failed === 0 ? 0 : 1);
})().catch((e) => {
  console.error('E2E ABORTADO:', e.message);
  process.exit(1);
});
