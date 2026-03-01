/**
 * mcp.js – Tool Definitions
 *
 * Add tools here so the AI can call them during a conversation.
 * Each tool needs:
 *   name        : string  – what the model calls the tool
 *   description : string  – what it does
 *   args        : object  – { argName: "type – description" } (shown in prompt)
 *   execute     : async (args, context) => string
 *
 * `context` passed to execute:
 *   pageMarkdown : string  – current page content (empty if not yet fetched)
 *   fetchPage    : async () => string  – fetches and returns page markdown
 *
 * ── Adding a tool ────────────────────────────────────────────────────────────
 * Push a new object into MCP_TOOLS. The model will automatically know about it.
 */

const MCP_TOOLS = [
  {
    name: 'get_page_content',
    description: 'Read the full content of the web page the user is viewing. Call this before answering questions about the page.',
    args: {},
    execute: async (_args, { fetchPage }) => fetchPage(),
  },

  {
    name: 'get_current_time',
    description: 'Get the current local date and time.',
    args: {},
    execute: async () => new Date().toLocaleString(),
  },

  {
    name: 'search_page',
    description: 'Search the page for lines containing a given term. Fetches the page first if needed. Returns up to 20 matches.',
    args: { query: 'string – term to search for (case-insensitive)' },
    execute: async ({ query }, { pageMarkdown, fetchPage }) => {
      const content = pageMarkdown || await fetchPage();
      const matches = content
        .split('\n')
        .filter(l => l.toLowerCase().includes(query.toLowerCase()));
      return matches.length
        ? matches.slice(0, 20).join('\n')
        : `No matches for "${query}".`;
    },
  },

  // Add your own tools below:
  //
  // {
  //   name: 'count_words',
  //   description: 'Count the total words on the current page.',
  //   args: {},
  //   execute: async (_args, { pageMarkdown, fetchPage }) => {
  //     const content = pageMarkdown || await fetchPage();
  //     return content.split(/\s+/).filter(Boolean).length + ' words';
  //   },
  // },
];

// ── Helpers used by popup.js ──────────────────────────────────────────────────

/**
 * Build the system prompt for the first turn.
 * Page content is NOT embedded here — the model uses get_page_content when needed.
 */
function buildSystemPrompt() {
  const toolLines = MCP_TOOLS.map(t => {
    const argStr = Object.keys(t.args).length
      ? JSON.stringify(Object.fromEntries(Object.keys(t.args).map(k => [k, '...'])))
      : '{}';
    return `  • ${t.name}: ${t.description}\n    args: ${argStr}`;
  }).join('\n');

  const toolSection = MCP_TOOLS.length
    ? `To call a tool (always include a brief content message so the user knows what you're doing):\n{"action":"tool","name":"tool_name","args":{},"content":"Brief message..."}\n\nAvailable tools:\n${toolLines}\n\n`
    : '';

  return `You are a helpful, friendly assistant. The user is viewing a web page.

You MUST reply with a single JSON object and nothing else — no markdown, no extra text.

To answer the user:
{"action":"respond","content":"your answer here"}

${toolSection}After receiving a tool result, reply with the final answer using the respond format.`;
}

/**
 * Fix mismatched brackets/braces that small models commonly produce
 * (e.g. `]` closing an object `{` instead of `}`).
 */
function repairJson(str) {
  const stack = [];
  let inString = false;
  let escaped = false;
  const chars = str.split('');
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i];
    if (escaped) { escaped = false; continue; }
    if (c === '\\' && inString) { escaped = true; continue; }
    if (c === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (c === '{' || c === '[') { stack.push(c); continue; }
    if (c === '}' || c === ']') {
      const open = stack.pop();
      if (open === '{' && c === ']') chars[i] = '}';
      else if (open === '[' && c === '}') chars[i] = ']';
    }
  }
  return chars.join('');
}

/**
 * Parse a JSON response from the model.
 * Tolerates markdown fences, leading/trailing text, and mismatched brackets.
 * Returns the parsed object, or null if parsing fails.
 */
function parseModelResponse(text) {
  const stripped = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  const match = stripped.match(/\{[\s\S]*[\}\]]/);
  if (!match) return null;
  // Strip trailing commas before } or ] — a common small-model mistake.
  const clean = match[0].replace(/,\s*([\}\]])/g, '$1');
  try {
    return JSON.parse(clean);
  } catch {
    try {
      return JSON.parse(repairJson(clean));
    } catch {
      return null;
    }
  }
}

/** Execute a tool by name. Always returns a string. */
async function runMCPTool(name, args, context) {
  const tool = MCP_TOOLS.find(t => t.name === name);
  if (!tool) return `Unknown tool: "${name}".`;
  try {
    return String(await tool.execute(args ?? {}, context));
  } catch (err) {
    return `Error in "${name}": ${err.message}`;
  }
}
