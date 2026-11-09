import { App, type McpUiHostContext } from '@modelcontextprotocol/ext-apps';

type Lead = { id: string; name: string; company: string; email: string; owner: string; value: number; stage: string; updatedAt: string; version: number };
type Page = { leads: Lead[]; page: number; pageSize: number; total: number; totalPages: number; query: string; stage: string; stages: string[]; currency: string; summary: { total: number; pipelineValue: number; stageCounts: Record<string, number> } };
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const rows = $<HTMLTableSectionElement>('rows');
const search = $<HTMLInputElement>('search');
const filter = $<HTMLSelectElement>('stage-filter');
const status = $('status');
const app = new App({ name: 'Lead Pipeline', version: '0.3.0' }, { availableDisplayModes: ['inline', 'fullscreen'] });
let data: Page | undefined;
let connected = false;
let busy = false;
let loaded = false;
let currentView: 'table' | 'kanban' = 'table';
let draggedLeadId: string | null = null;
let displayPending = false;
let displayMode: 'inline' | 'fullscreen' | 'pip' = 'inline';
let availableModes: McpUiHostContext['availableDisplayModes'];
const displayButton = $<HTMLButtonElement>('display-mode');
function updateDisplayButton() {
  const fullscreen = displayMode === 'fullscreen';
  const target = fullscreen ? 'inline' : 'fullscreen';
  const supported = availableModes === undefined || availableModes.includes(target);
  displayButton.hidden = !connected;
  displayButton.disabled = !connected || busy || displayPending || !supported;
  displayButton.textContent = displayPending ? 'Switching view…' : fullscreen ? 'Exit fullscreen' : supported ? 'Fullscreen' : 'Fullscreen unavailable';
  displayButton.title = supported ? '' : `This host does not offer ${target} mode.`;
  displayButton.setAttribute('aria-pressed', String(fullscreen));
  document.documentElement.dataset.displayMode = displayMode;
}
function applyHostContext(context: Partial<McpUiHostContext>) {
  if (context.theme) document.documentElement.dataset.theme = context.theme;
  if (context.displayMode) displayMode = context.displayMode;
  if (context.availableDisplayModes !== undefined) availableModes = context.availableDisplayModes;
  updateDisplayButton();
}
displayButton.onclick = async () => {
  if (displayButton.disabled || displayPending) return;
  const target = displayMode === 'fullscreen' ? 'inline' : 'fullscreen';
  displayPending = true; updateDisplayButton();
  try {
    const result = await app.requestDisplayMode({ mode: target }, { timeout: 10_000 });
    displayMode = result.mode;
    if (result.mode !== target) message(`The host kept the app in ${result.mode} mode. ${target === 'fullscreen' ? 'Fullscreen is not available in this view.' : 'Use the host’s controls to leave fullscreen.'}`, true);
    else message(target === 'fullscreen' ? 'Fullscreen view opened.' : 'Returned to inline view.');
  } catch (error) {
    message(`Could not change the display mode: ${error instanceof Error ? error.message : String(error)}`, true);
  } finally { displayPending = false; updateDisplayButton(); }
};
const colors = ['#8291ad', '#688ce0', '#8b71d0', '#bb77aa', '#daac49', '#dc8654', '#4baf91', '#218578'];
function node<K extends keyof HTMLElementTagNameMap>(tag: K, text = '', className = '') {
  const n = document.createElement(tag); n.textContent = text; n.className = className; return n;
}
function message(text: string, error = false) { status.textContent = text; status.dataset.error = String(error); }
function lock(value: boolean) {
  busy = value;
  document.querySelectorAll<HTMLButtonElement | HTMLInputElement | HTMLSelectElement>('button,input,select').forEach(n => n.disabled = value || !connected);
  $('table-wrap').setAttribute('aria-busy', String(value));
  $('kanban-board').setAttribute('aria-busy', String(value));
  document.querySelectorAll<HTMLElement>('.lead-card').forEach(card => { card.draggable = connected && !value; card.setAttribute('aria-disabled', String(value || !connected)); });
  if (!value && data) updatePages(data);
  updateDisplayButton();
}
function money(value: number) { return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(value); }
function parse(value: unknown): Page {
  if (!value || typeof value !== 'object') throw Error('The server returned an invalid lead page.');
  const p = value as Page;
  if (!Array.isArray(p.leads) || p.leads.length > 50 || p.pageSize !== 50 || !Number.isInteger(p.page) || p.page < 1 || !Number.isInteger(p.totalPages) || !p.summary || !Array.isArray(p.stages) || p.stages.length !== 8) throw Error('The server returned an invalid lead page.');
  for (const l of p.leads) if (!l.id || typeof l.name !== 'string' || !p.stages.includes(l.stage) || !Number.isInteger(l.version)) throw Error('The server returned an invalid lead.');
  return p;
}
async function call(name: string, args: Record<string, unknown>) {
  const r = await app.callServerTool({ name, arguments: args }, { timeout: 20_000 });
  if (r.isError) throw Error(r.content.filter(c => c.type === 'text').map(c => c.text).join('\n') || 'The request failed.');
  return r.structuredContent;
}
function updatePages(p: Page) {
  const nav = $('pages'); nav.replaceChildren();
  const button = (label: string, target: number, disabled: boolean) => {
    const b = node('button', label); b.disabled = disabled || busy || !connected;
    b.onclick = () => void load(target); nav.append(b); return b;
  };
  button('← Previous', p.page - 1, p.page === 1);
  for (let n = 1; n <= p.totalPages; n++) { const b = button(String(n), n, false); b.setAttribute('aria-label', `Page ${n}`); if (n === p.page) b.setAttribute('aria-current', 'page'); }
  button('Next →', p.page + 1, p.page === p.totalPages);
}
function setView(view: 'table' | 'kanban') {
  currentView = view;
  $('table-wrap').hidden = view !== 'table';
  $('kanban-board').hidden = view !== 'kanban';
  $('kanban-hint').hidden = view !== 'kanban';
  $('view-table').setAttribute('aria-pressed', String(view === 'table'));
  $('view-kanban').setAttribute('aria-pressed', String(view === 'kanban'));
}
$('view-table').onclick = () => { if (!busy) setView('table'); };
$('view-kanban').onclick = () => { if (!busy) setView('kanban'); };
function clearDrag() {
  draggedLeadId = null;
  document.querySelectorAll('.dragging,.drop-target').forEach(el => el.classList.remove('dragging', 'drop-target'));
}
function renderBoard(p: Page) {
  clearDrag();
  const board = $('kanban-board'); board.replaceChildren();
  p.stages.forEach((stage, index) => {
    const leads = p.leads.filter(lead => lead.stage === stage);
    const column = node('section', '', 'kanban-column'); column.dataset.stage = stage;
    column.setAttribute('aria-labelledby', `column-title-${index}`);
    column.style.setProperty('--stage-color', colors[index]);
    const heading = node('div', '', 'column-heading');
    const title = node('h3', stage); title.id = `column-title-${index}`;
    const count = node('span', String(leads.length), 'column-count'); count.title = 'Leads on this page';
    heading.append(title, count);
    const subtotal = node('p', `${money(leads.reduce((sum, lead) => sum + lead.value, 0))} · this page`, 'column-subtotal');
    const list = node('div', '', 'kanban-list'); list.tabIndex = 0; list.setAttribute('aria-label', `${stage} leads on this page`);
    for (const lead of leads) {
      const card = node('article', '', 'lead-card'); card.dataset.leadId = lead.id;
      card.draggable = connected && !busy; card.setAttribute('aria-label', `${lead.name}, ${lead.company}`);
      const top = node('div', '', 'card-top'); top.append(node('span', lead.id, 'card-id'), node('span', '⠿', 'drag-handle'));
      const contact = node('div', '', 'contact');
      const avatar = node('span', lead.name.split(' ').map(n => n[0]).slice(0, 2).join(''), 'avatar');
      const details = node('div'); details.append(node('div', lead.name, 'name'), node('div', lead.company, 'card-company')); contact.append(avatar, details);
      const email = node('p', lead.email, 'card-email');
      const bottom = node('div', '', 'card-bottom'); bottom.append(node('span', money(lead.value), 'value'), node('span', lead.owner, 'owner'));
      const label = node('label', 'Move to', 'move-label');
      const select = node('select', '', 'stage-select'); select.setAttribute('aria-label', `Move ${lead.name} to stage`);
      p.stages.forEach(s => select.add(new Option(s, s))); select.value = lead.stage;
      select.disabled = !connected || busy; select.onchange = () => void move(lead, select.value); label.append(select);
      card.append(top, contact, email, bottom, label);
      card.ondragstart = event => {
        if (!connected || busy || (event.target instanceof Element && event.target.closest('select,button,input'))) { event.preventDefault(); return; }
        draggedLeadId = lead.id;
        event.dataTransfer?.setData('text/plain', lead.id);
        if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
        card.classList.add('dragging');
      };
      card.ondragend = clearDrag;
      list.append(card);
    }
    if (!leads.length) list.append(node('p', 'Drop a lead here', 'column-empty'));
    column.ondragover = event => {
      if (!draggedLeadId || busy) return;
      event.preventDefault(); if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
      document.querySelectorAll('.drop-target').forEach(el => { if (el !== column) el.classList.remove('drop-target'); });
      column.classList.add('drop-target');
    };
    column.ondragleave = event => { if (!(event.relatedTarget instanceof Node) || !column.contains(event.relatedTarget)) column.classList.remove('drop-target'); };
    column.ondrop = event => {
      if (!draggedLeadId || busy) return;
      event.preventDefault();
      const lead = data?.leads.find(lead => lead.id === draggedLeadId); clearDrag();
      if (lead && lead.stage !== stage) void move(lead, stage);
    };
    column.append(heading, subtotal, list); board.append(column);
  });
}
function render(p: Page) {
  data = p;
  $('total').textContent = String(p.summary.total); $('pipeline-value').textContent = money(p.summary.pipelineValue);
  $('qualified').textContent = String(p.summary.stageCounts['Lead Qualified']);
  $('approved').textContent = String(p.summary.stageCounts['Deal Approved'] + p.summary.stageCounts['Contract Created']);
  $('match-count').textContent = `${p.total} ${p.total === 1 ? 'lead' : 'leads'}`;
  search.value = p.query;
  filter.replaceChildren(new Option('All stages', '')); p.stages.forEach(s => filter.add(new Option(s, s))); filter.value = p.stage;
  const stages = $('stages'); stages.replaceChildren();
  p.stages.forEach((s, i) => { const b = node('button', '', 'stage-card'); b.setAttribute('aria-pressed', String(p.stage === s)); const dot = node('span', '', 'dot'); dot.style.background = colors[i]; b.append(dot, document.createTextNode(s), node('strong', String(p.summary.stageCounts[s]))); b.onclick = () => { if (busy) return; filter.value = p.stage === s ? '' : s; void load(1); }; stages.append(b); });
  rows.replaceChildren();
  if (!p.leads.length) { const tr = node('tr'); const td = node('td', 'No leads match. Try a different search or stage.', 'empty'); td.colSpan = 6; tr.append(td); rows.append(tr); }
  for (const l of p.leads) {
    const tr = node('tr'); tr.dataset.leadId = l.id;
    const contact = node('td'); const wrap = node('div', '', 'contact');
    const avatar = node('span', l.name.split(' ').map(n => n[0]).slice(0, 2).join(''), 'avatar');
    const details = node('div'); details.append(node('div', l.name, 'name'), node('div', l.email, 'email')); wrap.append(avatar, details); contact.append(wrap);
    const stageCell = node('td'); const select = node('select', '', 'stage-select'); select.setAttribute('aria-label', `Stage for ${l.name}`);
    p.stages.forEach(s => select.add(new Option(s, s))); select.value = l.stage; select.style.borderLeft = `3px solid ${colors[p.stages.indexOf(l.stage)]}`;
    select.onchange = () => void move(l, select.value); stageCell.append(select);
    const date = node('td', new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' }).format(new Date(l.updatedAt)), 'date'); date.title = `${l.id} · ${l.updatedAt}`;
    tr.append(contact, node('td', l.company), node('td', l.owner, 'owner'), node('td', money(l.value), 'value'), stageCell, date); rows.append(tr);
  }
  const start = p.total ? (p.page - 1) * 50 + 1 : 0;
  $('range').textContent = `Showing ${start}–${Math.min(p.page * 50, p.total)} of ${p.total} leads · 50 per page`;
  renderBoard(p); setView(currentView);
  updatePages(p);
}
async function fetchPage(page: number, scroll: boolean) {
  const next = parse(await call('leads.list', { page, query: search.value.trim(), stage: filter.value }));
  render(next); loaded = true; if (scroll) { $('table-wrap').scrollTop = 0; document.querySelectorAll('.kanban-list').forEach(list => list.scrollTop = 0); }
}
async function load(page = data?.page ?? 1) {
  if (busy || !connected) return;
  lock(true); message('Loading leads…');
  try { await fetchPage(page, true); message('All changes are saved on the server.'); }
  catch (error) { message(`${error instanceof Error ? error.message : String(error)} Use Refresh to try again.`, true); }
  finally { lock(false); }
}
async function move(lead: Lead, stage: string) {
  if (busy || !connected) { if (data) render(data); return; }
  lock(true); message(`Moving ${lead.name} to ${stage}…`);
  let saved = false;
  try {
    await call('leads.updateStage', { leadId: lead.id, stage, expectedVersion: lead.version }); saved = true;
    await fetchPage(data?.page ?? 1, false);
    message(`${lead.name} moved to ${stage}. Saved.`);
  } catch (error) {
    if (data) render(data);
    message(`${saved ? 'Stage saved, but the list could not refresh. ' : ''}${error instanceof Error ? error.message : String(error)} Use Refresh to reload.`, true);
  } finally { lock(false); }
}
$('search-form').onsubmit = e => { e.preventDefault(); void load(1); };
filter.onchange = () => void load(1);
$('refresh').onclick = () => void load(data && search.value.trim() === data.query && filter.value === data.stage ? data.page : 1);
app.ontoolresult = r => { if (loaded || busy) return; if (r.isError) { message('Could not open the lead workspace. Use Refresh to retry.', true); return; } try { render(parse(r.structuredContent)); } catch (error) { message(String(error), true); } };
app.onhostcontextchanged = applyHostContext;
async function connect() {
  if (window.parent === window) { message('Open Lead Pipeline through a ChatGPT sidebar plugin or an MCP Apps host.', true); return; }
  try { await app.connect(); connected = true; applyHostContext(app.getHostContext() ?? {}); lock(false); await load(1); }
  catch (error) { message(error instanceof Error ? error.message : String(error), true); }
}
void connect();
