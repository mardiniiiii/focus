const readBtn  = document.getElementById('readBtn');
const copyBtn  = document.getElementById('copyBtn');
const statusEl = document.getElementById('status');
const htmlPanel = document.getElementById('htmlPanel');
const mdPanel   = document.getElementById('markdownPanel');
const ollamaPanel = document.getElementById('ollamaPanel');
const ollamaQuestion = document.getElementById('ollamaQuestion');
const ollamaAskBtn = document.getElementById('ollamaAskBtn');
const ollamaResponse = document.getElementById('ollamaResponse');
const tabs      = document.querySelectorAll('.tab');

let currentHtml     = '';
let currentMarkdown = '';
let activeTab       = 'html';
let ollamaRunning   = false;
let availableModels = [];
const DEFAULT_MODEL = 'gemma3:1b';

// Fetch available models on startup
(async () => {
  try {
    const response = await fetch('http://localhost:11434/api/tags');
    if (response.ok) {
      const data = await response.json();
      availableModels = data.models?.map(m => m.name) || [];
      console.log('Available models:', availableModels);
      if (availableModels.length === 0) {
        statusEl.textContent = 'No Ollama models available. Pull one first.';
      }
    }
  } catch (err) {
    console.error('Failed to fetch models:', err);
    statusEl.textContent = 'Ollama server not running.';
  }
})();

// ── Tab switching ────────────────────────────────────────────────────────────

tabs.forEach(tab => {
  tab.addEventListener('click', () => {
    activeTab = tab.dataset.tab;

    tabs.forEach(t => t.classList.toggle('active', t === tab));
    htmlPanel.classList.toggle('active', activeTab === 'html');
    mdPanel.classList.toggle('active',   activeTab === 'markdown');
    ollamaPanel.classList.toggle('active', activeTab === 'ollama');

    if (activeTab === 'markdown' && currentHtml && !currentMarkdown) {
      convertToMarkdown();
    }
  });
});

// ── Read page ────────────────────────────────────────────────────────────────

readBtn.addEventListener('click', async () => {
  statusEl.textContent = 'Reading…';
  resetPanels();

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => document.documentElement.outerHTML,
    });

    currentHtml     = results[0].result;
    currentMarkdown = ''; // invalidate cached markdown

    htmlPanel.textContent = currentHtml;
    htmlPanel.classList.remove('empty');

    statusEl.textContent =
      `Loaded ${currentHtml.length.toLocaleString()} chars from: ${tab.url}`;

    // If the markdown tab is already visible, convert immediately
    if (activeTab === 'markdown') convertToMarkdown();

  } catch (err) {
    htmlPanel.textContent = `Error: ${err.message}`;
    htmlPanel.classList.remove('empty');
    statusEl.textContent = 'Failed to read page HTML.';
  }
});

// ── Markdown conversion ──────────────────────────────────────────────────────

const turndown = new TurndownService({
  headingStyle:    'atx',
  bulletListMarker: '-',
  codeBlockStyle:  'fenced',
  fence:           '```',
  hr:              '---',
  strongDelimiter: '**',
  emDelimiter:     '*',
});

// Elements whose entire subtree is noise — strip before Turndown sees them
const STRIP = [
  'script', 'style', 'noscript',   // code & styles
  'svg', 'canvas', 'picture',       // graphics
  'iframe', 'frame', 'frameset',    // embeds
  'template',                       // inert HTML templates
  'head', 'link', 'meta',           // document infrastructure
].join(',');

function cleanHtml(rawHtml) {
  const doc = new DOMParser().parseFromString(rawHtml, 'text/html');
  doc.querySelectorAll(STRIP).forEach(el => el.remove());
  return doc.body.innerHTML;
}

function convertToMarkdown() {
  statusEl.textContent = 'Converting to markdown…';
  mdPanel.classList.add('empty');

  // Yield to the browser so the status update paints before the (sync) parse
  setTimeout(() => {
    try {
      currentMarkdown = turndown.turndown(cleanHtml(currentHtml));
      mdPanel.textContent = currentMarkdown;
      mdPanel.classList.remove('empty');
      statusEl.textContent =
        `Markdown: ${currentMarkdown.length.toLocaleString()} chars`;
    } catch (err) {
      mdPanel.textContent = `Conversion error: ${err.message}`;
      mdPanel.classList.remove('empty');
      statusEl.textContent = 'Markdown conversion failed.';
    }
  }, 0);
}

// ── Copy ─────────────────────────────────────────────────────────────────────

copyBtn.addEventListener('click', async () => {
  const text = activeTab === 'markdown' ? currentMarkdown : currentHtml;
  if (!text) {
    statusEl.textContent = 'Nothing to copy — read a page first.';
    return;
  }
  await navigator.clipboard.writeText(text);
  statusEl.textContent = `Copied ${activeTab} to clipboard!`;
});

// ── Ollama Q&A ──────────────────────────────────────────────────────────────

ollamaAskBtn.addEventListener('click', async () => {
  const question = ollamaQuestion.value.trim();
  
  if (!question) {
    statusEl.textContent = 'Please enter a question.';
    return;
  }

  if (!currentMarkdown) {
    statusEl.textContent = 'Please load a page first.';
    return;
  }

  if (ollamaRunning) {
    statusEl.textContent = 'Request already in progress...';
    return;
  }

  ollamaRunning = true;
  ollamaAskBtn.disabled = true;
  statusEl.textContent = 'Loading model...';
  ollamaResponse.textContent = '';
  ollamaResponse.classList.remove('empty');

  try {
    // Use default model if available, otherwise first available, fallback to default
    let modelToUse = DEFAULT_MODEL;
    if (!availableModels.includes(DEFAULT_MODEL) && availableModels.length > 0) {
      modelToUse = availableModels[0];
    }
    console.log('Using model:', modelToUse);
    
    const prompt = `Based on this markdown content:\n\n${currentMarkdown}\n\n---\n\nAnswer this question: ${question}`;
    
    statusEl.textContent = 'Sending to Ollama...';
    const response = await fetch('http://localhost:11434/api/generate', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: modelToUse,
        prompt: prompt,
        stream: true,
      }),
    });

    if (!response.ok) {
      throw new Error(`API error: ${response.status} ${response.statusText}`);
    }

    let fullResponse = '';
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let isFirstChunk = true;
    let tokenCount = 0;

    statusEl.textContent = 'Receiving response...';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const chunk = decoder.decode(value);
      const lines = chunk.split('\n').filter(line => line.trim());

      for (const line of lines) {
        try {
          const data = JSON.parse(line);
          
          // Accumulate response text
          if (data.response) {
            if (isFirstChunk) {
              isFirstChunk = false;
              statusEl.textContent = 'Streaming response...';
            }
            fullResponse += data.response;
            ollamaResponse.textContent = fullResponse;
            tokenCount = data.eval_count || tokenCount;
            
            // Auto-scroll to bottom
            setTimeout(() => {
              ollamaResponse.scrollTop = ollamaResponse.scrollHeight;
            }, 0);
          }
          
          // Check if generation is complete
          if (data.done) {
            const duration = data.total_duration ? (data.total_duration / 1_000_000_000).toFixed(1) : '?';
            const tokens = data.eval_count || tokenCount || '?';
            statusEl.textContent = `Response complete ✓ (${tokens} tokens, ${duration}s)`;
            ollamaQuestion.value = '';
            return; // Exit early since generation is done
          }
        } catch (e) {
          // Skip non-JSON lines
        }
      }
    }
  } catch (err) {
    ollamaResponse.textContent = `Error: ${err.message}`;
    statusEl.textContent = 'Failed to get Ollama response.';
  } finally {
    ollamaRunning = false;
    ollamaAskBtn.disabled = false;
  }
});

// Allow Enter key to submit
ollamaQuestion.addEventListener('keypress', (e) => {
  if (e.key === 'Enter') {
    ollamaAskBtn.click();
  }
});

// ── Helpers ──────────────────────────────────────────────────────────────────

function resetPanels() {
  currentHtml     = '';
  currentMarkdown = '';

  htmlPanel.textContent = '';
  htmlPanel.classList.add('empty');
  mdPanel.textContent = '';
  mdPanel.classList.add('empty');
  ollamaResponse.textContent = '';
  ollamaResponse.classList.add('empty');
  ollamaQuestion.value = '';
}
