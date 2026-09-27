const $ = (id) => document.getElementById(id);
let token = location.hash.slice(1) || sessionStorage.getItem('mini-token') || '';
if (token) { sessionStorage.setItem('mini-token', token); history.replaceState(null, '', location.pathname); }
let state = null, revision = -1, sending = false, lastApproval = '', notice = '';
$('cwd').value = localStorage.getItem('mini-cwd') || '';

async function api(path, data) {
  const response = await fetch('/api/' + path, {method: data === undefined ? 'GET' : 'POST', headers: {'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json'}, body: data === undefined ? undefined : JSON.stringify(data)});
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || '連線失敗');
  return result;
}
function showError(error) { notice = error.message || String(error); $('notice').textContent = notice; $('notice').hidden = false; }
async function act(name, data = {}) {
  try { const result = await api(name, data); notice = ''; revision = -1; await refresh(); return result; }
  catch (error) { showError(error); return null; }
}
function element(tag, className, text) { const el = document.createElement(tag); if (className) el.className = className; if (text !== undefined) el.textContent = text; return el; }
function renderSources(sources) {
  const list = $('source-list'); if (!list) return;
  list.replaceChildren(...sources.map(source => {
    const card = element('article', 'source-card');
    card.append(element('strong', '', source.name), element('small', '', `${source.repository} · ${source.license} · ${source.status}`));
    if (source.latest_commit) card.append(element('small', '', `${source.latest_commit.slice(0, 7)} ${source.latest_message || ''}`));
    const review = element('button', '', '檢查與審查'); review.type = 'button'; review.onclick = () => act('sources', {subAction: 'review', repository: source.repository}); card.append(review);
    if (source.status === 'owner_review') { const stage = element('button', '', '下載供我審查'); stage.type = 'button'; stage.onclick = () => act('sources', {subAction: 'stage', repository: source.repository}); card.append(stage); }
    return card;
  }));
}
function render(s) {
  state = s;
  const busy = s.busy || sending;
  $('connection').textContent = !s.ready ? '尚未連接' : s.account ? '● 已連接' : '需要登入';
  $('login').hidden = s.account;
  $('login').disabled = !s.ready;
  $('send').disabled = busy || !s.ready || !s.account;
  $('stop').hidden = !s.busy;
  $('new-chat').disabled = busy; $('mobile-new').disabled = busy;
  $('mode').disabled = busy || !!s.chat;
  $('model').disabled = busy || !!s.chat;
  $('working').hidden = !s.busy;
  $('notice').hidden = !s.error && !notice;
  $('notice').textContent = notice || s.error;
  $('chat-count').textContent = s.chats.length;
  renderSources(s.sources || []);
  if (!$('cwd').value) $('cwd').value = s.defaultCwd;
  const cwd = s.chat?.cwd || $('cwd').value;
  $('project-name').textContent = cwd.split(/[\\/]/).filter(Boolean).pop() || 'AI 工作空間';
  $('project-path').textContent = cwd;
  $('project-path').title = cwd;
  if (s.chat) $('mode').value = s.chat.mode;
  if ($('model').options.length !== s.models.length + 1) {
    const previous = $('model').value;
    $('model').replaceChildren(new Option('Codex 預設模型', ''), ...s.models.map(m => new Option(m.name, m.id)));
    $('model').value = previous;
  }
  $('history').replaceChildren(...s.chats.map(c => {
    const b = element('button', 'history-item' + (s.chat?.id === c.id ? ' active' : ''), c.title);
    b.title = c.title; b.disabled = busy; b.onclick = () => act('select', {id: c.id}); return b;
  }));
  if (!s.chats.length) $('history').append(element('p', 'empty', '還沒有對話，開始第一個任務吧。'));
  $('welcome').hidden = !!s.chat;
  const pane = $('conversation');
  const atBottom = pane.scrollHeight - pane.scrollTop - pane.clientHeight < 100;
  $('messages').replaceChildren(...(s.chat?.messages || []).map(m => {
    const box = element('article', 'message ' + m.role);
    box.append(element('div', 'role', m.role === 'user' ? 'YOU' : '✦ MINI'), element('div', 'message-body', m.text));
    return box;
  }));
  if (atBottom) pane.scrollTop = pane.scrollHeight;
  $('pet-status').textContent = s.approvals.length ? '需要你的確認' : s.busy ? '正在努力中…' : s.chat ? '隨時可以繼續' : '準備開始';
  $('pet-description').textContent = s.busy ? '工作進度會即時更新。' : '你的下一個想法，我陪你完成。';
  const plan = s.chat?.plan || [];
  $('plan').replaceChildren(...(plan.length ? plan.map(p => element('li', '', (p.status === 'completed' ? '✓ ' : p.status === 'inProgress' ? '→ ' : '') + p.step)) : [element('li', 'empty', '任務開始後，計畫會顯示在這裡。')]));
  const activities = s.chat?.activity || [];
  $('activity').replaceChildren(...(activities.length ? activities.slice(-30).reverse().map(a => {
    const details = element('details', 'activity-item');
    details.append(element('summary', '', (a.status === 'completed' ? '✓ ' : a.status === 'failed' ? '× ' : '· ') + a.text));
    details.append(element('pre', '', a.output || (a.changes.length ? JSON.stringify(a.changes, null, 2) : a.status)));
    return details;
  }) : [element('p', 'empty', '工具操作與檔案變更會同步顯示。')]));
  const approvalKey = JSON.stringify(s.approvals);
  if (lastApproval !== approvalKey) {
    lastApproval = approvalKey; $('approval').replaceChildren();
    for (const a of s.approvals) {
      const box = element('div'); box.append(element('strong', '', '需要你的核准'), element('pre', '', JSON.stringify(a.details, null, 2)));
      for (const [label, decision] of [['允許這次操作', 'accept'], ['拒絕', 'decline']]) {
        const b = element('button', decision, label); b.onclick = () => act('approve', {id: a.id, decision}); box.append(b);
      }
      $('approval').append(box);
    }
  }
  $('approval').hidden = !s.approvals.length;
}
async function refresh() {
  try { const s = await api('state'); if (revision !== s.revision) { revision = s.revision; render(s); } }
  catch (error) { showError(error); $('connection').textContent = '已離線'; $('send').disabled = true; }
}
async function poll() { await refresh(); setTimeout(poll, 800); }
$('compose').onsubmit = async (event) => {
  event.preventDefault(); const text = $('prompt').value.trim();
  if (!text || sending || state?.busy) return;
  sending = true; if (state) render(state);
  const result = await act('send', {text, cwd: $('cwd').value, mode: $('mode').value, model: $('model').value});
  sending = false; if (result) $('prompt').value = ''; revision = -1; await refresh();
};
$('prompt').onkeydown = (event) => { if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); $('compose').requestSubmit(); } };
$('new-chat').onclick = () => act('new');
$('import-history').onclick = async () => { const result = await act('import'); if (result) { notice = `已匯入 ${result.imported} 個 Codex 對話；來源紀錄保持原樣。`; revision = -1; await refresh(); } };
$('sources-button').onclick = () => $('sources').showModal();
$('refresh-sources').onclick = () => act('sources', {subAction: 'refresh'});
$('stop').onclick = () => act('stop');
$('login').onclick = async () => { const popup = window.open('about:blank', '_blank'); const result = await act('login'); if (result?.url) { if (popup) popup.location = result.url; else location.href = result.url; } else popup?.close(); };
$('settings-button').onclick = () => $('settings').showModal();
$('settings').addEventListener('close', () => { if ($('settings').returnValue === 'save') { localStorage.setItem('mini-cwd', $('cwd').value); if (state) render(state); } });
document.querySelectorAll('[data-prompt]').forEach(b => b.onclick = () => { $('prompt').value = b.dataset.prompt; $('prompt').focus(); });
document.addEventListener('keydown', (e) => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'n') { e.preventDefault(); if (!state?.busy) act('new'); } });
document.querySelector('.brand').onclick = (e) => { e.preventDefault(); if (!state?.busy) act('new'); };
poll();

$('mobile-new').onclick = () => act('new');
$('panel-button').onclick = () => document.querySelector('.inspector').classList.toggle('mobile-open');
$('panel-close').onclick = () => document.querySelector('.inspector').classList.remove('mobile-open');
