import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const temp = await mkdtemp(join(tmpdir(), 'leads-sidebar-test-'));
let child, browser, host;
try {
  const binary = join(temp, 'leads-sidebar');
  const built = spawnSync('go', ['build', '-o', binary, './cmd/server'], { cwd: root, encoding: 'utf8' });
  assert.equal(built.status, 0, built.stderr);
  const listener = net.createServer();
  await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  const endpoint = `http://127.0.0.1:${port}/mcp`;
  child = spawn(binary, ['--address', `127.0.0.1:${port}`], { env: {...process.env,LEADS_DATA_DIR:join(temp,'data')}, stdio: 'ignore' });
  for (let attempt = 0; ; attempt++) {
    try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) break; } catch {}
    if (attempt >= 100) throw new Error('Lead server did not start');
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  let session, sequence = 0;
  async function rpc(method, params) {
    const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
    if (session) headers['Mcp-Session-Id'] = session;
    const response = await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: ++sequence, method, params }) });
    session = response.headers.get('mcp-session-id') ?? session;
    let text = await response.text();
    if (response.headers.get('content-type')?.includes('text/event-stream')) text = text.split('\n').find(line => line.startsWith('data:')).slice(5);
    const data = JSON.parse(text);
    if (!response.ok || data.error) throw new Error(JSON.stringify(data));
    return data.result;
  }
  await rpc('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'browser-test', version: '1' } });
  const initial = await rpc('tools/call', { name: 'leads.open', arguments: {} });
  const resource = await rpc('resources/read', { uri: 'ui://leads-sidebar/pipeline-v3' });
  const calls = [];
  let failNext = false;
  const shell = `<!doctype html><iframe id="app" src="/widget" style="width:100%;height:100vh;border:0"></iframe><script>
  const frame=document.getElementById('app');
  window.displayModeRequests=[];window.displayBehavior='allow';
  window.addEventListener('message',async event=>{
    if(event.source!==frame.contentWindow)return;
    const m=event.data;
    if(m.method==='ui/notifications/initialized'){
      frame.contentWindow.postMessage({jsonrpc:'2.0',method:'ui/notifications/tool-input',params:{arguments:{}}},'*');
      frame.contentWindow.postMessage({jsonrpc:'2.0',method:'ui/notifications/tool-result',params:${JSON.stringify(initial)}},'*');
      return;
    }
    if(m.id===undefined)return;
    try{
      let result;
      if(m.method==='ui/initialize'){
        window.appCapabilities=m.params.appCapabilities;
        result={protocolVersion:m.params.protocolVersion,hostInfo:{name:'smoke-test',version:'1'},hostCapabilities:{serverTools:{}},hostContext:{theme:'light',platform:'web',displayMode:'inline',availableDisplayModes:['inline','fullscreen']}};
      }
      else if(m.method==='ui/request-display-mode'){
        window.displayModeRequests.push(m.params.mode);
        if(window.displayBehavior==='error')throw new Error('Display mode rejected by test host');
        result={mode:window.displayBehavior==='deny'?'inline':m.params.mode};
      }
      else if(m.method==='tools/call')result=await fetch('/call',{method:'POST',body:JSON.stringify(m.params)}).then(r=>r.json());
      else if(m.method==='ping')result={};
      else throw new Error('Unexpected request '+m.method);
      frame.contentWindow.postMessage({jsonrpc:'2.0',id:m.id,result},'*');
    }catch(error){frame.contentWindow.postMessage({jsonrpc:'2.0',id:m.id,error:{code:-32603,message:error.message}},'*');}
  });</script>`;
  host = http.createServer(async (request, response) => {
    try {
      if (request.url === '/widget') { response.setHeader('content-type', 'text/html'); response.end(resource.contents[0].text); }
      else if (request.url === '/call') {
        let raw = ''; for await (const chunk of request) raw += chunk;
        const params = JSON.parse(raw); calls.push(params);
        const result = failNext ? { isError: true, content: [{ type: 'text', text: 'Simulated save error. Retry available.' }] } : await rpc('tools/call', params);
        failNext = false; response.setHeader('content-type', 'application/json'); response.end(JSON.stringify(result));
      } else { response.setHeader('content-type', 'text/html'); response.end(shell); }
    } catch (error) { response.statusCode = 500; response.end(JSON.stringify({ error: error.message })); }
  });
  await new Promise(resolve => host.listen(0, '127.0.0.1', resolve));
  browser = await chromium.launch({ headless: true, ...(process.env.BROWSER_EXECUTABLE ? { executablePath: process.env.BROWSER_EXECUTABLE } : {}) });
  const page = await browser.newPage({viewport:{width:1440,height:1040}});
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${host.address().port}`);
  const frame = page.frameLocator('#app');
  await frame.locator('#rows tr[data-lead-id="LEAD-001"]').waitFor();
  assert.equal(await frame.locator('#rows tr[data-lead-id]').count(),50);
  assert.match(await frame.locator('#range').textContent(),/1–50 of 150/);
  assert.equal(await frame.getByRole('button',{name:'← Previous',exact:true}).isDisabled(),true);
  await frame.getByRole('button',{name:'Page 2',exact:true}).click();
  await frame.locator('#rows tr[data-lead-id="LEAD-051"]').waitFor();
  assert.equal(await frame.locator('#rows tr[data-lead-id]').count(),50);
  await frame.getByRole('button',{name:'Next →',exact:true}).click();
  await frame.locator('#rows tr[data-lead-id="LEAD-101"]').waitFor();
  assert.equal(await frame.locator('#rows tr[data-lead-id]').count(),50);
  assert.equal(await frame.getByRole('button',{name:'Next →',exact:true}).isDisabled(),true);
  assert.deepEqual(await page.evaluate(()=>window.appCapabilities.availableDisplayModes),['inline','fullscreen']);
  await frame.getByRole('button',{name:'Fullscreen',exact:true}).click();
  await frame.getByRole('button',{name:'Exit fullscreen',exact:true}).waitFor();
  assert.equal(await frame.locator('html').getAttribute('data-display-mode'),'fullscreen');
  assert.match(await frame.locator('#range').textContent(),/101–150/);
  await frame.getByRole('button',{name:'Exit fullscreen',exact:true}).click();
  await frame.getByRole('button',{name:'Fullscreen',exact:true}).waitFor();
  assert.deepEqual(await page.evaluate(()=>window.displayModeRequests),['fullscreen','inline']);
  const hostContext=async context=>{
    await page.locator('#app').evaluate((el,context)=>el.contentWindow.postMessage({jsonrpc:'2.0',method:'ui/notifications/host-context-changed',params:context},'*'),context);
  };
  await hostContext({displayMode:'fullscreen'});
  await frame.getByRole('button',{name:'Exit fullscreen',exact:true}).waitFor();
  await hostContext({displayMode:'inline'});
  await frame.getByRole('button',{name:'Fullscreen',exact:true}).waitFor();
  await page.evaluate(()=>window.displayBehavior='deny');
  await frame.getByRole('button',{name:'Fullscreen',exact:true}).click();
  await frame.locator('#status').getByText('The host kept the app in inline mode. Fullscreen is not available in this view.',{exact:true}).waitFor();
  assert.equal(await frame.locator('html').getAttribute('data-display-mode'),'inline');
  await page.evaluate(()=>window.displayBehavior='error');
  await frame.getByRole('button',{name:'Fullscreen',exact:true}).click();
  await page.waitForFunction(()=>document.getElementById('app').contentDocument.getElementById('status').textContent.includes('Display mode rejected by test host'));
  assert.equal(await frame.locator('html').getAttribute('data-display-mode'),'inline');
  await hostContext({availableDisplayModes:['inline']});
  await frame.getByRole('button',{name:'Fullscreen unavailable',exact:true}).waitFor();
  assert.equal(await frame.getByRole('button',{name:'Fullscreen unavailable',exact:true}).isDisabled(),true);
  await frame.getByRole('button',{name:'Refresh',exact:true}).click();
  await frame.locator('#status').getByText('All changes are saved on the server.',{exact:true}).waitFor();
  assert.equal(await frame.getByRole('button',{name:'Fullscreen unavailable',exact:true}).isDisabled(),true);
  await hostContext({availableDisplayModes:['inline','fullscreen']});
  await frame.getByRole('button',{name:'Fullscreen',exact:true}).waitFor();
  await page.evaluate(()=>window.displayBehavior='allow');
  const stage=frame.locator('#rows [data-lead-id="LEAD-101"] select');
  await stage.selectOption('Contract Created');
  await frame.locator('#status').getByText('Isabella Rivera moved to Contract Created. Saved.',{exact:true}).waitFor();
  assert.equal(await stage.inputValue(),'Contract Created');
  await frame.getByRole('button',{name:'Refresh',exact:true}).click();
  await frame.locator('#status').getByText('All changes are saved on the server.',{exact:true}).waitFor();
  assert.equal(await stage.inputValue(),'Contract Created');
  failNext=true;
  await stage.selectOption('Negotiation');
  await frame.locator('#status[data-error=true]').waitFor();
  assert.match(await frame.locator('#status').textContent(),/Simulated save error/);
  assert.equal(await stage.inputValue(),'Contract Created');
  await stage.selectOption('Negotiation');
  await frame.locator('#status').getByText('Isabella Rivera moved to Negotiation. Saved.',{exact:true}).waitFor();
  await frame.locator('#search').fill('LEAD-150');
  await frame.locator('#search-form').evaluate(form=>form.requestSubmit());
  await frame.locator('#rows tr[data-lead-id="LEAD-150"]').waitFor();
  assert.equal(await frame.locator('#rows tr[data-lead-id]').count(),1);
  await frame.locator('#search').fill('no-such-lead');
  await frame.locator('#search-form').evaluate(form=>form.requestSubmit());
  await frame.getByText('No leads match. Try a different search or stage.',{exact:true}).waitFor();
  await frame.locator('#search').fill('');
  await frame.locator('#stage-filter').selectOption('Deal Approved');
  await page.waitForFunction(()=>document.getElementById('app').contentDocument.querySelectorAll('#rows tr[data-lead-id]').length===18);
  assert.equal(await frame.locator('#rows select').count(),18);
  for(const value of await frame.locator('#rows select').evaluateAll(selects=>selects.map(s=>s.value)))assert.equal(value,'Deal Approved');
  await frame.locator('#stage-filter').selectOption('');
  await frame.locator('#rows tr[data-lead-id="LEAD-001"]').waitFor();
  assert.equal(await frame.locator('#rows tr[data-lead-id]').count(),50);
  assert.deepEqual(errors, []);
  if (process.env.SCREENSHOT_PATH) await page.screenshot({path:process.env.SCREENSHOT_PATH,fullPage:true});
  await frame.getByRole('button',{name:'Kanban',exact:true}).click();
  await frame.locator('#kanban-board').waitFor({state:'visible'});
  assert.equal(await frame.locator('#table-wrap').isVisible(),false);
  assert.equal(await frame.locator('.kanban-column').count(),8);
  assert.equal(await frame.locator('#kanban-board .lead-card').count(),50);
  const boardCard=id=>frame.locator(`#kanban-board .lead-card[data-lead-id="${id}"]`);
  const column=stage=>frame.locator(`.kanban-column[data-stage="${stage}"]`);
  const beforeMove=calls.filter(c=>c.name==='leads.updateStage').length;
  await boardCard('LEAD-001').dragTo(column('Lead Captured').locator('.column-heading'));
  assert.equal(calls.filter(c=>c.name==='leads.updateStage').length,beforeMove);
  await boardCard('LEAD-001').dragTo(column('Lead Qualified').locator('.column-heading'));
  await frame.locator('#status').getByText('Olivia Chen moved to Lead Qualified. Saved.',{exact:true}).waitFor();
  assert.equal(await column('Lead Qualified').locator('[data-lead-id="LEAD-001"]').count(),1);
  assert.equal(await frame.locator('#kanban-board .lead-card').count(),50);
  await frame.getByRole('button',{name:'Refresh',exact:true}).click();
  await frame.locator('#status').getByText('All changes are saved on the server.',{exact:true}).waitFor();
  assert.equal(await column('Lead Qualified').locator('[data-lead-id="LEAD-001"]').count(),1);
  failNext=true;
  await boardCard('LEAD-001').locator('select').selectOption('Contract Created');
  await frame.locator('#status[data-error=true]').waitFor();
  assert.equal(await column('Lead Qualified').locator('[data-lead-id="LEAD-001"]').count(),1);
  await boardCard('LEAD-001').locator('select').selectOption('Contract Created');
  await frame.locator('#status').getByText('Olivia Chen moved to Contract Created. Saved.',{exact:true}).waitFor();
  assert.equal(await column('Contract Created').locator('[data-lead-id="LEAD-001"]').count(),1);
  await frame.getByRole('button',{name:'Table',exact:true}).click();
  assert.equal(await frame.locator('#rows [data-lead-id="LEAD-001"] select').inputValue(),'Contract Created');
  await frame.getByRole('button',{name:'Kanban',exact:true}).click();
  await frame.getByRole('button',{name:'Page 2',exact:true}).click();
  await boardCard('LEAD-051').waitFor();
  assert.equal(await frame.locator('#kanban-board .lead-card').count(),50);
  assert.equal(await frame.getByRole('button',{name:'Kanban',exact:true}).getAttribute('aria-pressed'),'true');
  await frame.getByRole('button',{name:'← Previous',exact:true}).click();
  await boardCard('LEAD-001').waitFor();
  await frame.locator('#search').fill('no-board-results');
  await frame.locator('#search-form').evaluate(form=>form.requestSubmit());
  await page.waitForFunction(()=>document.getElementById('app').contentDocument.querySelectorAll('#kanban-board .lead-card').length===0);
  assert.equal(await frame.locator('.kanban-column').count(),8);
  await frame.locator('#search').fill('');
  await frame.locator('#stage-filter').selectOption('Lead Captured');
  await boardCard('LEAD-009').waitFor();
  assert.equal(await column('Lead Qualified').locator('.lead-card').count(),0);
  await boardCard('LEAD-009').dragTo(column('Lead Qualified').locator('.column-empty'));
  await frame.locator('#status').getByText('Charlotte Chen moved to Lead Qualified. Saved.',{exact:true}).waitFor();
  assert.equal(await boardCard('LEAD-009').count(),0);
  await frame.locator('#stage-filter').selectOption('');
  await boardCard('LEAD-009').waitFor();
  assert.equal(await column('Lead Qualified').locator('[data-lead-id="LEAD-009"]').count(),1);
  await frame.locator('#kanban-board').evaluate(el=>el.scrollLeft=0);
  if(process.env.SCREENSHOT_PATH)await page.screenshot({path:process.env.SCREENSHOT_PATH.replace(/\.png$/,'-kanban.png'),fullPage:true});
  await page.setViewportSize({width:390,height:844});
  await frame.locator('#kanban-board').evaluate(el=>{if(el.scrollWidth<=el.clientWidth)throw Error('Expected scrollable mobile board');});
  assert.equal(await frame.locator('body').evaluate(el=>el.scrollWidth<=window.innerWidth),true);
  await frame.getByRole('button',{name:'Table',exact:true}).click();
  await frame.locator('#table-wrap').evaluate(el=>{if(el.scrollWidth<=el.clientWidth)throw Error('Expected scrollable mobile table');});
  assert.equal(await frame.locator('body').evaluate(el=>el.scrollWidth<=window.innerWidth),true);
  await page.locator('#app').evaluate(el=>{el.contentWindow.postMessage({jsonrpc:'2.0',method:'ui/notifications/host-context-changed',params:{theme:'dark'}},'*');});
  await page.waitForFunction(()=>document.getElementById('app').contentDocument.documentElement.dataset.theme==='dark');
  assert.deepEqual(errors, []);
  console.log('PASS: MCP handshake, three pages of 50, persistent stage updates, failed-save rollback and retry, search, empty results, filters, mobile scrolling, dark theme, fullscreen/exit, host mode changes, denied requests, unavailable modes, Kanban drag/drop, empty-column drops, stage selectors, failed board saves, and view switching.');
} finally {
  if (browser) await browser.close();
  if (host) await new Promise(resolve => host.close(resolve));
  if (child && child.exitCode === null) { const exited = new Promise(resolve => child.once('exit', resolve)); child.kill('SIGTERM'); await exited; }
  await rm(temp, { recursive: true, force: true });
}
