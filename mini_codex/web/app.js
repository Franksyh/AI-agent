const $ = (id) => document.getElementById(id);
let token = location.hash.slice(1) || sessionStorage.getItem('mini-token') || '';
if (token) {
  sessionStorage.setItem('mini-token', token);
  history.replaceState(null, '', location.pathname);
}
let state = null;
let revision = -1;
let sending = false;
let lastApproval = '';
let notice = '';
let voiceRecognition = null;
let voiceListening = false;
let lastAssistantMessage = '';
let hasRenderedMessages = false;
let speechEnabled = localStorage.getItem('mini-speech-output') === 'true';
let uiScale = Number(localStorage.getItem('mini-ui-scale') || 1);

$('cwd').value = localStorage.getItem('mini-cwd') || '';

async function api(path, data) {
  const response = await fetch('/api/' + path, {
    method: data === undefined ? 'GET' : 'POST',
    headers: {'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json'},
    body: data === undefined ? undefined : JSON.stringify(data),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || '連線失敗');
  return result;
}

function showError(error) {
  notice = error.message || String(error);
  $('notice').textContent = notice;
  $('notice').hidden = false;
}

async function act(name, data = {}) {
  try {
    const result = await api(name, data);
    notice = '';
    revision = -1;
    await refresh();
    return result;
  } catch (error) {
    showError(error);
    return null;
  }
}

function element(tag, className, text) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text !== undefined) el.textContent = text;
  return el;
}

function setUiScale(value) {
  uiScale = Math.max(0.8, Math.min(1.35, Math.round(value * 20) / 20));
  document.documentElement.style.setProperty('--ui-scale', String(uiScale));
  localStorage.setItem('mini-ui-scale', String(uiScale));
  $('zoom-reset').textContent = `${Math.round(uiScale * 100)}%`;
}

function setSpeechOutput(enabled) {
  speechEnabled = Boolean(enabled);
  localStorage.setItem('mini-speech-output', String(speechEnabled));
  const button = $('voice-output');
  button.setAttribute('aria-pressed', String(speechEnabled));
  button.textContent = speechEnabled ? '🔊' : '🔈';
  button.title = speechEnabled ? '關閉回覆朗讀' : '開啟回覆朗讀';
  if (!speechEnabled && window.speechSynthesis) window.speechSynthesis.cancel();
}

function speak(text) {
  if (!speechEnabled || !window.speechSynthesis || !text.trim()) return;
  window.speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(text.slice(0, 1800));
  utterance.lang = 'zh-TW';
  utterance.rate = 1;
  window.speechSynthesis.speak(utterance);
}

function updateVoiceButton() {
  const button = $('voice-input');
  button.textContent = voiceListening ? '■' : '🎙';
  button.title = voiceListening ? '停止語音輸入' : '語音轉文字';
  button.setAttribute('aria-label', button.title);
  button.classList.toggle('listening', voiceListening);
}

function toggleVoiceInput() {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) {
    showError(new Error('這個瀏覽器不支援語音轉文字。請使用最新版 Edge 或 Chrome。'));
    return;
  }
  if (voiceListening && voiceRecognition) {
    voiceRecognition.stop();
    return;
  }
  const startingText = $('prompt').value.trim();
  const recognition = new SpeechRecognition();
  voiceRecognition = recognition;
  recognition.lang = 'zh-TW';
  recognition.continuous = false;
  recognition.interimResults = true;
  recognition.onstart = () => {
    voiceListening = true;
    updateVoiceButton();
  };
  recognition.onresult = (event) => {
    let transcript = '';
    for (let index = event.resultIndex; index < event.results.length; index += 1) {
      transcript += event.results[index][0].transcript;
    }
    $('prompt').value = `${startingText}${startingText && transcript ? ' ' : ''}${transcript}`;
    $('prompt').focus();
  };
  recognition.onerror = (event) => {
    if (event.error !== 'aborted' && event.error !== 'no-speech') {
      showError(new Error(`語音輸入無法使用：${event.error}`));
    }
  };
  recognition.onend = () => {
    voiceListening = false;
    voiceRecognition = null;
    updateVoiceButton();
  };
  recognition.start();
}

function closeHistoryDrawer() {
  document.body.classList.remove('history-open');
  $('history-scrim').hidden = true;
}

function toggleHistoryDrawer() {
  const opening = !document.body.classList.contains('history-open');
  document.body.classList.toggle('history-open', opening);
  $('history-scrim').hidden = !opening;
}

function renderSources(sources) {
  const list = $('source-list');
  if (!list) return;
  list.replaceChildren(...sources.map(source => {
    const card = element('article', 'source-card');
    card.append(
      element('strong', '', source.name),
      element('small', '', `${source.repository} · ${source.license} · ${source.status}`),
    );
    if (source.latest_commit) card.append(element('small', '', `${source.latest_commit.slice(0, 7)} ${source.latest_message || ''}`));
    const review = element('button', '', '檢查安全門檻');
    review.type = 'button';
    review.onclick = () => act('sources', {subAction: 'review', repository: source.repository});
    card.append(review);
    if (source.status === 'owner_review') {
      const stage = element('button', '', '下載供我審查');
      stage.type = 'button';
      stage.onclick = () => act('sources', {subAction: 'stage', repository: source.repository});
      card.append(stage);
    }
    if (source.status === 'staged_for_owner') {
      const aiReview = element('button', '', '用 Codex 分析程式碼');
      aiReview.type = 'button';
      aiReview.onclick = async () => {
        const result = await act('sources', {subAction: 'ai_review', repository: source.repository});
        if (result) {
          notice = '已建立唯讀來源審查對話；Mini 不會自動安裝或採用候選程式碼。';
          revision = -1;
          await refresh();
        }
      };
      card.append(aiReview);
    }
    return card;
  }));
}

function renderAccess(access, providers) {
  const role = access?.role || 'unauthenticated';
  const roleText = role === 'owner' ? `擁有者${access.owner ? ` · ${access.owner}` : ''}` :
    role === 'member' ? '一般使用者 · 使用與讀取' : '尚未驗證';
  $('access-brief').textContent = roleText;

  const detail = $('access-detail');
  detail.replaceChildren(
    element('strong', '', roleText),
    element('span', '', (access?.capabilities || []).join(' · ') || '尚未取得權限'),
  );
  if (role === 'owner' && access?.computerControl) {
    detail.append(element('small', '', '電腦控制預設關閉；需要時在新對話選擇，仍會逐次要求核准。'));
  }

  const providerList = $('provider-list');
  providerList.replaceChildren(...(providers || []).map(provider => {
    const row = element('div', 'provider-row');
    const stateNames = {
      connected: '已連線', available: '可使用', starting: '連線中',
      setup_required: '需要設定', not_detected: '未偵測', windows_limited: 'Windows 限制',
    };
    row.append(element('strong', '', provider.name), element('span', `provider-status ${provider.status}`, stateNames[provider.status] || provider.status));
    row.append(element('small', '', provider.detail));
    return row;
  }));

  const allowedModes = new Set(access?.allowedModes || ['read-only']);
  for (const option of $('mode').options) {
    option.hidden = !allowedModes.has(option.value);
    option.disabled = !allowedModes.has(option.value);
  }
  if (!allowedModes.has($('mode').value)) $('mode').value = allowedModes.values().next().value || 'read-only';
}

function renderDesktop(desktop) {
  const available = desktop?.available === true;
  const files = desktop?.fileAccess || {};
  $('show-mini').disabled = !available;
  $('hide-mini').disabled = !available;
  $('open-file').disabled = files.available !== true || files.pending === true;
  $('open-file').title = files.available === true
    ? '在桌面 Mini 顯示系統檔案選擇器'
    : '需要在這台電腦啟動桌面 Mini';

  const status = $('file-access-status');
  const last = files.last;
  if (files.pending) {
    status.textContent = '正在等待你在系統檔案選擇器中選取檔案…';
  } else if (last?.message) {
    const size = Number.isFinite(last.size) ? ` · ${last.size.toLocaleString()} bytes` : '';
    status.textContent = `${last.message}${last.mime ? ` (${last.mime}${size})` : size}`;
  } else {
    status.textContent = files.message || '需要桌面 Mini 才能選擇這台電腦的檔案。';
  }

  const preview = $('file-preview-result');
  if (typeof last?.preview === 'string' && last.preview) {
    preview.textContent = last.preview;
    preview.hidden = false;
  } else {
    preview.textContent = '';
    preview.hidden = true;
  }
}

function render(s) {
  state = s;
  const busy = s.busy || sending;
  $('connection').textContent = !s.ready ? '尚未連接' : s.account ? '● 已連接' : '需要登入';
  $('login').hidden = s.account;
  $('login').disabled = !s.ready;
  $('send').disabled = busy || !s.ready || !s.account;
  $('stop').hidden = !s.busy;
  $('new-chat').disabled = busy;
  $('mobile-new').disabled = busy;
  $('mode').disabled = busy || Boolean(s.chat);
  $('model').disabled = busy || Boolean(s.chat);
  $('working').hidden = !s.busy;
  $('notice').hidden = !s.error && !notice;
  $('notice').textContent = notice || s.error;
  $('chat-count').textContent = s.chats.length;
  renderSources(s.sources || []);
  renderAccess(s.access, s.providers);
  renderDesktop(s.desktop);
  if (!$('cwd').value) $('cwd').value = s.defaultCwd;
  const cwd = s.chat?.cwd || $('cwd').value;
  $('project-name').textContent = cwd.split(/[\\/]/).filter(Boolean).pop() || 'AI 工作空間';
  $('project-path').textContent = cwd || '選擇資料夾，開始一起工作';
  $('project-path').title = cwd;
  if (s.chat) $('mode').value = s.chat.mode;
  if ($('model').options.length !== s.models.length + 1) {
    const previous = $('model').value;
    $('model').replaceChildren(new Option('Codex 預設模型', ''), ...s.models.map(m => new Option(m.name, m.id)));
    $('model').value = previous;
  }
  $('history').replaceChildren(...s.chats.map(c => {
    const button = element('button', 'history-item' + (s.chat?.id === c.id ? ' active' : ''), c.title);
    button.title = c.title;
    button.disabled = busy;
    button.onclick = () => {
      closeHistoryDrawer();
      act('select', {id: c.id});
    };
    return button;
  }));
  if (!s.chats.length) $('history').append(element('p', 'empty', '還沒有對話，開始第一個任務吧。'));
  $('welcome').hidden = Boolean(s.chat);
  const pane = $('conversation');
  const atBottom = pane.scrollHeight - pane.scrollTop - pane.clientHeight < 100;
  const messages = s.chat?.messages || [];
  $('messages').replaceChildren(...messages.map(m => {
    const box = element('article', 'message ' + m.role);
    box.append(element('div', 'role', m.role === 'user' ? 'YOU' : '✦ MINI'), element('div', 'message-body', m.text));
    return box;
  }));
  if (atBottom) pane.scrollTop = pane.scrollHeight;
  const latestAssistant = [...messages].reverse().find(m => m.role === 'assistant' && m.text);
  if (latestAssistant && !s.busy && latestAssistant.id !== lastAssistantMessage) {
    if (hasRenderedMessages) speak(latestAssistant.text);
    lastAssistantMessage = latestAssistant.id;
  }
  hasRenderedMessages = true;
  $('pet-status').textContent = s.approvals.length ? '需要你的確認' : s.busy ? '正在努力中…' : s.chat ? '隨時可以繼續' : '準備開始';
  $('pet-description').textContent = s.busy ? '工作進度會即時更新。' : '你的下一個想法，我陪你完成。';
  const plan = s.chat?.plan || [];
  $('plan').replaceChildren(...(plan.length ? plan.map(p => element('li', '', (p.status === 'completed' ? '✓ ' : p.status === 'inProgress' ? '→ ' : '') + p.step)) : [element('li', 'empty', '任務開始後，計畫會顯示在這裡。')]));
  const activities = s.chat?.activity || [];
  $('activity').replaceChildren(...(activities.length ? activities.slice(-30).reverse().map(a => {
    const details = element('details', 'activity-item');
    details.append(element('summary', '', (a.status === 'completed' ? '✓ ' : a.status === 'failed' ? '× ' : '· ') + a.text));
    const changes = a.changes || [];
    details.append(element('pre', '', a.output || (changes.length ? JSON.stringify(changes, null, 2) : a.status)));
    return details;
  }) : [element('p', 'empty', '工具操作與檔案變更會同步顯示。')]));
  const approvalKey = JSON.stringify(s.approvals);
  if (lastApproval !== approvalKey) {
    lastApproval = approvalKey;
    $('approval').replaceChildren();
    for (const approval of s.approvals) {
      const box = element('div');
      box.append(element('strong', '', '需要你的核准'), element('pre', '', JSON.stringify(approval.details, null, 2)));
      for (const [label, decision] of [['允許這次操作', 'accept'], ['拒絕', 'decline']]) {
        const button = element('button', decision, label);
        button.onclick = () => act('approve', {id: approval.id, decision});
        box.append(button);
      }
      $('approval').append(box);
    }
  }
  $('approval').hidden = !s.approvals.length;
}

async function refresh() {
  try {
    const next = await api('state');
    if (revision !== next.revision) {
      revision = next.revision;
      render(next);
    }
  } catch (error) {
    showError(error);
    $('connection').textContent = '已離線';
    $('send').disabled = true;
  }
}

async function poll() {
  await refresh();
  setTimeout(poll, 800);
}

$('compose').onsubmit = async (event) => {
  event.preventDefault();
  const text = $('prompt').value.trim();
  if (!text || sending || state?.busy) return;
  sending = true;
  if (state) render(state);
  const result = await act('send', {text, cwd: $('cwd').value, mode: $('mode').value, model: $('model').value});
  sending = false;
  if (result) $('prompt').value = '';
  revision = -1;
  await refresh();
};
$('prompt').onkeydown = (event) => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    $('compose').requestSubmit();
  }
};
$('new-chat').onclick = () => { closeHistoryDrawer(); act('new'); };
$('import-history').onclick = async () => {
  const result = await act('import');
  if (result) {
    notice = `已匯入 ${result.imported} 個 Codex 對話；來源紀錄保持原樣。`;
    revision = -1;
    await refresh();
  }
};
$('sources-button').onclick = () => $('sources').showModal();
$('refresh-sources').onclick = () => act('sources', {subAction: 'refresh'});
$('stop').onclick = () => act('stop');
$('login').onclick = async () => {
  const popup = window.open('about:blank', '_blank');
  const result = await act('login');
  if (result?.url) {
    if (popup) popup.location = result.url;
    else location.href = result.url;
  } else {
    popup?.close();
  }
};
$('settings-button').onclick = () => $('settings').showModal();
$('settings').addEventListener('close', () => {
  if ($('settings').returnValue === 'save') {
    localStorage.setItem('mini-cwd', $('cwd').value);
    if (state) render(state);
  }
});
$('show-mini').onclick = () => act('desktop', {action: 'show'});
$('hide-mini').onclick = () => act('desktop', {action: 'hide'});
$('open-file').onclick = async () => {
  const result = await act('files', {
    action: 'choose_and_open',
    includePreview: $('file-preview').checked,
  });
  if (result) {
    notice = '桌面 Mini 正在顯示系統檔案選擇器；只有你在該視窗選取的檔案會被開啟。';
    revision = -1;
    await refresh();
  }
};
$('voice-input').onclick = toggleVoiceInput;
$('voice-output').onclick = () => setSpeechOutput(!speechEnabled);
$('zoom-out').onclick = () => setUiScale(uiScale - 0.05);
$('zoom-in').onclick = () => setUiScale(uiScale + 0.05);
$('zoom-reset').onclick = () => setUiScale(1);
$('history-button').onclick = toggleHistoryDrawer;
$('history-scrim').onclick = closeHistoryDrawer;
document.querySelectorAll('[data-prompt]').forEach(button => {
  button.onclick = () => {
    $('prompt').value = button.dataset.prompt;
    $('prompt').focus();
  };
});
document.addEventListener('keydown', (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'n') {
    event.preventDefault();
    if (!state?.busy) act('new');
  }
  if (event.key === 'Escape') closeHistoryDrawer();
});
document.querySelector('.brand').onclick = (event) => {
  event.preventDefault();
  if (!state?.busy) act('new');
};
$('mobile-new').onclick = () => act('new');
$('panel-button').onclick = () => document.querySelector('.inspector').classList.toggle('mobile-open');
$('panel-close').onclick = () => document.querySelector('.inspector').classList.remove('mobile-open');

setUiScale(Number.isFinite(uiScale) ? uiScale : 1);
setSpeechOutput(speechEnabled);
updateVoiceButton();
poll();
