const statusEl      = document.getElementById('status');
const chatArea      = document.getElementById('chatArea');
const welcome       = document.getElementById('welcome');
const userInput     = document.getElementById('userInput');
const sendBtn       = document.getElementById('sendBtn');
const modelBadge    = document.getElementById('modelBadge');
const modelPicker   = document.getElementById('modelPicker');
const modelDropdown = document.getElementById('modelDropdown');
const modelFilter   = document.getElementById('modelFilter');
const modelList     = document.getElementById('modelList');
const refreshBtn    = document.getElementById('refreshBtn');
const faviconEl     = document.getElementById('favicon');

// Set favicon from the active tab
chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
  if (tab?.favIconUrl) faviconEl.src = tab.favIconUrl;
});

let currentMarkdown     = '';
let isBusy              = false;
let availableModels     = [];
let modelToUse          = 'gemma3:1b';
let conversationHistory = [];  // [{role, content}]

const DEFAULT_MODEL  = 'gemma3:1b';
const STORAGE_KEY    = 'sucof_preferred_model';

// ── Model dropdown ───────────────────────────────────────────────────────────

function buildDropdown(filter = '') {
  modelList.innerHTML = '';
  const q = filter.toLowerCase();
  for (const name of availableModels) {
    if (q && !name.toLowerCase().includes(q)) continue;
    const btn = document.createElement('button');
    btn.className = 'model-option' + (name === modelToUse ? ' active' : '');
    btn.dataset.model = name;
    btn.innerHTML = `<span>${name}</span><span class="model-check">✓</span>`;
    btn.addEventListener('click', () => {
      modelToUse = name;
      localStorage.setItem(STORAGE_KEY, name);
      modelBadge.textContent = name;
      modelDropdown.classList.remove('open');
      buildDropdown();
    });
    modelList.appendChild(btn);
  }
}

modelFilter.addEventListener('input', () => buildDropdown(modelFilter.value));

modelBadge.addEventListener('click', (e) => {
  e.stopPropagation();
  if (availableModels.length === 0) return;
  const opening = !modelDropdown.classList.contains('open');
  modelDropdown.classList.toggle('open');
  if (opening) {
    modelFilter.value = '';
    buildDropdown();
    modelFilter.focus();
  }
});

document.addEventListener('click', (e) => {
  if (!modelPicker.contains(e.target)) modelDropdown.classList.remove('open');
});

// ── Connect to Ollama on startup ─────────────────────────────────────────────

(async () => {
  try {
    const res = await fetch('http://localhost:11434/api/tags');
    if (!res.ok) throw new Error('bad status');
    const data = await res.json();
    availableModels = data.models?.map(m => m.name) ?? [];

    if (availableModels.length === 0) {
      statusEl.textContent = 'No Ollama models found — pull one first.';
      modelBadge.textContent = 'no models';
    } else {
      // Prefer saved preference, then default, then first available
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved && availableModels.includes(saved)) {
        modelToUse = saved;
      } else if (availableModels.includes(DEFAULT_MODEL)) {
        modelToUse = DEFAULT_MODEL;
      } else {
        modelToUse = availableModels[0];
      }
      modelBadge.textContent = modelToUse;
      buildDropdown();
      statusEl.textContent = 'Ready · send a message to get started';
    }
  } catch {
    statusEl.textContent = 'Ollama not running — start it first.';
    modelBadge.textContent = 'offline';
  }
})();

// ── Auto-resize textarea ─────────────────────────────────────────────────────

userInput.addEventListener('input', () => {
  userInput.style.height = 'auto';
  userInput.style.height = Math.min(userInput.scrollHeight, 110) + 'px';
});

// ── Markdown / page utilities ────────────────────────────────────────────────

const turndown = new TurndownService({
  headingStyle:     'atx',
  bulletListMarker: '-',
  codeBlockStyle:   'fenced',
  fence:            '```',
  hr:               '---',
  strongDelimiter:  '**',
  emDelimiter:      '*',
});

const STRIP = [
  'script', 'style', 'noscript', 'svg', 'canvas', 'picture',
  'iframe', 'frame', 'frameset', 'template', 'head', 'link', 'meta',
].join(',');

function cleanHtml(rawHtml) {
  const doc = new DOMParser().parseFromString(rawHtml, 'text/html');
  doc.querySelectorAll(STRIP).forEach(el => el.remove());
  return doc.body.innerHTML;
}

async function fetchPageMarkdown() {
  statusEl.textContent = 'Reading page…';
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const results = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: () => document.documentElement.outerHTML,
  });
  const html = results[0].result;

  statusEl.textContent = 'Parsing…';
  await new Promise(r => setTimeout(r, 0)); // let status paint
  currentMarkdown = turndown.turndown(cleanHtml(html));

  const shortUrl = tab.url.length > 55 ? tab.url.slice(0, 55) + '…' : tab.url;
  statusEl.textContent = `Page loaded · ${shortUrl}`;
}

// ── Refresh button ───────────────────────────────────────────────────────────

refreshBtn.addEventListener('click', async () => {
  if (isBusy) return;
  currentMarkdown = '';
  conversationHistory = [];
  // Clear chat, restore welcome
  chatArea.innerHTML = '';
  chatArea.appendChild(welcome);
  statusEl.textContent = 'Page cleared — send a message to re-read it.';
});

// ── Chat UI helpers ──────────────────────────────────────────────────────────

function hideWelcome() {
  if (welcome.isConnected) welcome.remove();
}

/** Appends a bubble and returns the bubble element (for streaming updates). */
function addMessage(role, content) {
  hideWelcome();
  const wrap   = document.createElement('div');
  wrap.className = `message ${role}`;
  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  bubble.textContent = content;
  wrap.appendChild(bubble);
  chatArea.appendChild(wrap);
  chatArea.scrollTop = chatArea.scrollHeight;
  return bubble;
}

/** Appends an animated typing indicator and returns its wrapper element. */
function addTypingIndicator() {
  hideWelcome();
  const wrap   = document.createElement('div');
  wrap.className = 'message assistant';
  const bubble = document.createElement('div');
  bubble.className = 'bubble typing-dots';
  bubble.innerHTML = '<span></span><span></span><span></span>';
  wrap.appendChild(bubble);
  chatArea.appendChild(wrap);
  chatArea.scrollTop = chatArea.scrollHeight;
  return wrap;
}

// ── Send message ─────────────────────────────────────────────────────────────

sendBtn.addEventListener('click', sendMessage);

userInput.addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
});

async function sendMessage() {
  const question = userInput.value.trim();
  if (!question || isBusy) return;

  isBusy = true;
  sendBtn.disabled = true;
  userInput.value = '';
  userInput.style.height = 'auto';

  addMessage('user', question);
  let typingEl = addTypingIndicator();

  try {
    // Auto-fetch page if we don't have it yet
    if (!currentMarkdown) {
      await fetchPageMarkdown();
      // Reset conversation when page context changes
      conversationHistory = [];
    }

    // Seed the system message on the first turn
    if (conversationHistory.length === 0) {
      conversationHistory.push({
        role:    'system',
        content: `You are a helpful, friendly assistant. The user is viewing a web page. Answer their questions based on the page content below. Be concise and clear.\n\n---\n\n${currentMarkdown}`,
      });
    }

    conversationHistory.push({ role: 'user', content: question });
    statusEl.textContent = 'Thinking…';

    const res = await fetch('http://localhost:11434/api/chat', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        model:    modelToUse,
        messages: conversationHistory,
        stream:   true,
      }),
    });

    if (!res.ok) throw new Error(`Ollama error ${res.status}: ${res.statusText}`);

    // Swap typing indicator for a real bubble
    typingEl.remove();
    typingEl = null;
    const aiBubble = addMessage('assistant', '');

    let fullResponse = '';
    const reader  = res.body.getReader();
    const decoder = new TextDecoder();

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const lines = decoder.decode(value).split('\n').filter(l => l.trim());
      for (const line of lines) {
        try {
          const data = JSON.parse(line);
          if (data.message?.content) {
            fullResponse += data.message.content;
            aiBubble.textContent = fullResponse;
            chatArea.scrollTop = chatArea.scrollHeight;
          }
          if (data.done) {
            const secs = data.total_duration
              ? (data.total_duration / 1e9).toFixed(1)
              : '?';
            statusEl.textContent = `Done · ${secs}s`;
          }
        } catch { /* skip non-JSON lines */ }
      }
    }

    conversationHistory.push({ role: 'assistant', content: fullResponse });

  } catch (err) {
    typingEl?.remove();
    addMessage('assistant', `Something went wrong: ${err.message}`);
    statusEl.textContent = 'Error — is Ollama running?';
    // Roll back the user turn so history stays consistent
    if (conversationHistory.at(-1)?.role === 'user') conversationHistory.pop();
  } finally {
    isBusy = false;
    sendBtn.disabled = false;
    userInput.focus();
  }
}
