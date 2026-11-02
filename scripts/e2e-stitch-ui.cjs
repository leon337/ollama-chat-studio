// Regressão de interface, isolada, sem chave Ollama ou chamadas à nuvem.
const {spawnSync} = require('node:child_process');
const {mkdtempSync,mkdirSync} = require('node:fs');
const {tmpdir} = require('node:os');
const {join,resolve} = require('node:path');
const ROOT=resolve(__dirname,'..');
if (!process.env.DISPLAY && !process.env.E2E_UI_XVFB && process.platform==='linux') {
  const r=spawnSync('xvfb-run',['-a','-s','-screen 0 1440x900x24',process.execPath,__filename],{stdio:'inherit',env:{...process.env,E2E_UI_XVFB:'1'}});
  process.exit(r.status ?? 1);
}
const { _electron: electron }=require('playwright-core');
let passed=0,failed=0;
function check(label, truth, detail='') {
  console.log((truth?'  ✓ ':'  ✗ ')+label+(truth?'':' -> '+detail));
  if(truth)passed++;else failed++;
}
const screenshots=process.env.E2E_UI_SHOTS || '/tmp/ocs-stitch-ui-shots';
(async()=>{
  mkdirSync(screenshots,{recursive:true});
  const env={...process.env};
  delete env.OLLAMA_API_KEY;
  const args=['--disable-gpu','--disable-dev-shm-usage','--user-data-dir='+mkdtempSync(join(tmpdir(),'ocs-stitch-ui-'))];
  if(process.getuid && process.getuid()===0)args.unshift('--no-sandbox');
  args.push('.');
  const app=await electron.launch({executablePath:require('electron'),cwd:ROOT,args,env});
  try {
    const page=await app.firstWindow();
    const errors=[];
    page.on('pageerror', e=>errors.push(e.message));
    await page.waitForSelector('.app',{timeout:30000});
    await page.setViewportSize({width:1360,height:768});
    await page.waitForTimeout(600);
    // Sem credencial, o app abre Configurações de forma legítima.
    // Fechar o modal para testar o shell subjacente, sem criar chave.
    const initialSetup=page.getByRole('dialog',{name:'Configurações'});
    if(await initialSetup.isVisible()) await page.getByRole('button',{name:'Fechar',exact:true}).click();
    const shell=page.locator('.app');
    check('Shell e trilho de navegação visíveis',await page.locator('.nav-rail').isVisible());
    check('Sem Work/Projetos falsos',!(await page.locator('.nav-rail').innerText()).includes('Work'));
    check('Sidebar inicialmente aberta em janela ampla',await shell.evaluate(x=>x.classList.contains('sidebar-open')));
    check('Painel de parâmetros inicialmente fechado',await page.locator('.drawer-host').count()===0);
    check('Compositor disponível',await page.locator('.composer textarea').isVisible());
    check('Estado vazio com mensagem original',await page.getByText('O que vamos explorar hoje?').count()===1);
    await page.screenshot({path:join(screenshots,'01-desktop-1360.png')});
    await page.getByRole('button',{name:'Recolher barra lateral'}).click();
    check('Sidebar recolhe via navegação',await page.locator('.sidebar').count()===0);
    const collapsed=await page.locator('.main').boundingBox();
    check('Área central expande com sidebar fechada',!!collapsed&&collapsed.width>1080,JSON.stringify(collapsed));
    await page.getByRole('button',{name:'Expandir barra lateral'}).click();
    check('Sidebar restaura sem perder lista',await page.locator('.sidebar').isVisible());
    await page.getByRole('button',{name:'Parâmetros do modelo'}).click();
    check('Drawer opcional abre',await page.locator('.drawer-host').isVisible());
    check('Parâmetros preservam campos reais',await page.getByLabel('Parâmetros').count()>=1);
    await page.keyboard.press('Escape');
    check('Escape fecha painel de parâmetros',await page.locator('.drawer-host').count()===0);
    check('Foco retorna ao acionador do painel',await page.evaluate(()=>document.activeElement?.getAttribute('aria-label')==='Parâmetros do modelo'));
    // Verificar seletor real sem chave e sem envio à nuvem.
    const picker=page.getByRole('button',{name:'Selecionar modelo e nível de raciocínio'});
    await picker.click();
    check('Seletor abre no composer',await page.getByRole('dialog',{name:'Modelo e raciocínio'}).isVisible());
    await page.getByLabel('Modelo no compositor').selectOption('gpt-oss:20b');
    await page.getByRole('combobox',{name:'Nível de raciocínio',exact:true}).selectOption('high');
    check('GPT-OSS seleciona Alto',await page.locator('.picker-thinking').innerText()==='Alto');
    await page.keyboard.press('Escape');
    check('Escape fecha seletor',await page.getByRole('dialog',{name:'Modelo e raciocínio'}).count()===0);
    await page.getByRole('button',{name:'Parâmetros do modelo'}).click();
    check('Parâmetros sincronizam nível Alto',await page.locator('.params select').filter({has:page.locator('option[value="high"]')}).inputValue()==='high');
    await page.keyboard.press('Escape');
    await picker.click();
    await page.getByLabel('Modelo no compositor').selectOption('nemotron-3-super');
    check('Modelo sem thinking bloqueia opções',await page.getByRole('combobox',{name:'Nível de raciocínio',exact:true}).isDisabled());
    check('Modelo incompatível não mantém Alto',await page.locator('.picker-thinking').innerText()==='Sem raciocínio');
    await page.keyboard.press('Escape');
    const input=page.locator('.composer textarea');
    await input.fill('Rascunho sintético sem enviar');
    check('Enviar disponível quando há texto',await page.getByRole('button',{name:'Enviar',exact:true}).isEnabled());
    await input.press('Shift+Enter');
    check('Shift+Enter produz quebra de linha sem envio',(await input.inputValue()).includes('\n'));
    await input.fill('');
    check('Enviar desabilitado sem conteúdo',await page.getByRole('button',{name:'Enviar',exact:true}).isDisabled());
    await page.setViewportSize({width:900,height:750});
    await page.waitForTimeout(300);
    const nine=await page.evaluate(()=>({overflow:document.documentElement.scrollWidth>innerWidth+2,scroller:!!document.querySelector('.scroller'),send:!!document.querySelector('.composer button.primary')}));
    check('900 px sem overflow horizontal',!nine.overflow,JSON.stringify(nine));
    check('900 px mantém o composer',nine.send && nine.scroller);
    check('900 px recolhe sidebar automaticamente',await page.locator('.sidebar').count()===0);
    await page.screenshot({path:join(screenshots,'02-compact-900.png')});
    await page.setViewportSize({width:740,height:750});
    await page.waitForTimeout(300);
    const seven=await page.evaluate(()=>({overflow:document.documentElement.scrollWidth>innerWidth+2,body:document.body.scrollWidth,viewport:innerWidth}));
    check('740 px sem overflow horizontal',!seven.overflow,JSON.stringify(seven));
    check('740 px mantém a navegação e textarea',await page.locator('.nav-rail').isVisible() && await input.isVisible());
    check('740 px deixa compositor desobstruído pela sidebar',await page.locator('.sidebar').count()===0);
    await page.screenshot({path:join(screenshots,'03-compact-740.png')});
    check('Nenhum erro fatal JavaScript',errors.length===0,errors.join(' | ').slice(0,400));
  } finally {await app.close();}
  console.log('TEST_RESULT '+passed+' passed / '+failed+' failed');
  if(failed)process.exit(1);
})().catch(err=>{console.error(err);process.exit(2);});
