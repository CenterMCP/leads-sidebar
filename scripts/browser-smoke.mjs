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
    if (attempt >= 100) throw new Error('Dice server did not start');
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
  const resource = await rpc('resources/read', { uri: 'ui://leads-sidebar/pipeline-v1' });
  const calls = [];
  let failNext = false;
  const shell = `<!doctype html><iframe id="app" src="/widget" style="width:100%;height:100vh;border:0"></iframe><script>
  const frame=document.getElementById('app');
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
      if(m.method==='ui/initialize')result={protocolVersion:m.params.protocolVersion,hostInfo:{name:'smoke-test',version:'1'},hostCapabilities:{serverTools:{}},hostContext:{theme:'light',platform:'web',displayMode:'fullscreen'}};
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
  const stage=frame.locator('[data-lead-id="LEAD-101"] select');
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
  await page.setViewportSize({width:390,height:844});
  await frame.locator('#table-wrap').evaluate(el=>{if(el.scrollWidth<=el.clientWidth)throw Error('Expected scrollable mobile table');});
  assert.equal(await frame.locator('body').evaluate(el=>el.scrollWidth<=window.innerWidth),true);
  await page.locator('#app').evaluate(el=>{el.contentWindow.postMessage({jsonrpc:'2.0',method:'ui/notifications/host-context-changed',params:{theme:'dark'}},'*');});
  await page.waitForFunction(()=>document.getElementById('app').contentDocument.documentElement.dataset.theme==='dark');
  assert.deepEqual(errors, []);
  console.log('PASS: MCP handshake, three pages of 50, persistent stage updates, failed-save rollback and retry, search, empty results, filters, mobile scrolling, and dark theme.');
} finally {
  if (browser) await browser.close();
  if (host) await new Promise(resolve => host.close(resolve));
  if (child && child.exitCode === null) { const exited = new Promise(resolve => child.once('exit', resolve)); child.kill('SIGTERM'); await exited; }
  await rm(temp, { recursive: true, force: true });
}
