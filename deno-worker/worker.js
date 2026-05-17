const PAGES_BASE = 'https://ladygreybrando.github.io/kelivo-skills-';
const SKILLS_INDEX = `${PAGES_BASE}/index.json`;

// Session store: sessionId → controller
const sessions = new Map();

// In-memory cache of skills index (fetched once, refreshed on demand)
let skillsCache = null;

async function getSkillsIndex() {
  if (skillsCache) return skillsCache;
  const resp = await fetch(SKILLS_INDEX);
  if (!resp.ok) throw new Error('Failed to fetch skill index');
  const text = await resp.text();
  try {
    skillsCache = JSON.parse(text);
  } catch (e) {
    throw new Error(`Invalid index.json: ${e.message}`);
  }
  return skillsCache;
}

function findSkill(name) {
  if (!skillsCache) return null;
  return skillsCache.skills.find(s => s.name === name);
}

export default {
  async fetch(request) {
    const url = new URL(request.url);
    const method = request.method;

    // CORS
    if (method === 'OPTIONS') {
      return cors();
    }

    // MCP SSE stream
    if (method === 'GET' && url.pathname !== '/health') {
      return handleSSE(url);
    }

    // All POST → JSON-RPC
    if (method === 'POST') {
      return handleMessage(request);
    }

    // Health check
    if (url.pathname === '/health') {
      return json({ status: 'ok' });
    }

    return new Response('Not Found', { status: 404 });
  }
};

// ---- Tools ----

function getTools() {
  return [
    {
      name: 'list_skills',
      description: '列出所有可用 Skill',
      inputSchema: { type: 'object', properties: {} }
    },
    {
      name: 'load_skill',
      description: '加载指定 Skill 的完整 SKILL.md',
      inputSchema: {
        type: 'object',
        properties: {
          skill_name: { type: 'string', description: 'Skill 目录名，通过 list_skills 获取' }
        },
        required: ['skill_name']
      }
    },
    {
      name: 'load_reference',
      description: '加载 Skill 的参考材料文件',
      inputSchema: {
        type: 'object',
        properties: {
          skill_name: { type: 'string', description: 'Skill 目录名' },
          ref_path: { type: 'string', description: 'references/ 下的相对路径，如 research/01-writings.md' }
        },
        required: ['skill_name', 'ref_path']
      }
    },
    {
      name: 'get_release_log',
      description: '获取最近一次 Skill 发布更新日志',
      inputSchema: {
        type: 'object',
        properties: {}
      }
    }
  ];
}

async function handleToolCall(toolName, args) {
  switch (toolName) {
    case 'list_skills': {
      try {
        const data = await getSkillsIndex();
        const text = data.skills
          .map(s => `- ${s.display} (${s.name}): ${s.description}`)
          .join('\n');
        return { content: [{ type: 'text', text }] };
      } catch (e) {
        return { content: [{ type: 'text', text: `Failed to load skills: ${e.message}` }] };
      }
    }
    case 'load_skill': {
      try {
        await getSkillsIndex();
        const skill = findSkill(args.skill_name);
        if (!skill) return { content: [{ type: 'text', text: `Skill '${args.skill_name}' not found in index` }] };
        const url = `${PAGES_BASE}${skill.path}SKILL.md`;
        const resp = await fetch(url);
        if (!resp.ok) return { content: [{ type: 'text', text: `Skill '${args.skill_name}' not found` }] };
        return { content: [{ type: 'text', text: await resp.text() }] };
      } catch (e) {
        return { content: [{ type: 'text', text: `Failed to load skill: ${e.message}` }] };
      }
    }
    case 'load_reference': {
      try {
        await getSkillsIndex();
        const skill = findSkill(args.skill_name);
        if (!skill) return { content: [{ type: 'text', text: `Skill '${args.skill_name}' not found in index` }] };
        const url = `${PAGES_BASE}${skill.path}references/${args.ref_path}`;
        const resp = await fetch(url);
        if (!resp.ok) return { content: [{ type: 'text', text: `Reference not found: ${args.ref_path}` }] };
        return { content: [{ type: 'text', text: await resp.text() }] };
      } catch (e) {
        return { content: [{ type: 'text', text: `Failed to load reference: ${e.message}` }] };
      }
    }
    case 'get_release_log': {
      const url = `${PAGES_BASE}/latest-release.md`;
      const resp = await fetch(url);
      if (!resp.ok) return { content: [{ type: 'text', text: '暂无更新日志' }] };
      return { content: [{ type: 'text', text: await resp.text() }] };
    }
    default:
      return { content: [{ type: 'text', text: `Unknown tool: ${toolName}` }], isError: true };
  }
}

// ---- MCP SSE Transport ----

function handleSSE(url) {
  const sessionId = url.searchParams.get('sessionId') || crypto.randomUUID();
  const encoder = new TextEncoder();

  const body = new ReadableStream({
    start(controller) {
      sessions.set(sessionId, controller);
      const endpointUrl = `${url.origin}/message?sessionId=${sessionId}`;
      controller.enqueue(encoder.encode(`event: endpoint\ndata: ${endpointUrl}\n\n`));
    },
    cancel() {
      sessions.delete(sessionId);
    }
  });

  return new Response(body, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*'
    }
  });
}

// ---- MCP JSON-RPC ----

async function handleMessage(request) {
  const body = await request.json();
  const { id, method, params } = body;

  let result;

  switch (method) {
    case 'initialize':
      result = {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'kelivo-skills-mcp', version: '1.0.0' }
      };
      break;

    case 'notifications/initialized':
      return new Response(null, { status: 202, headers: { 'Access-Control-Allow-Origin': '*' } });

    case 'tools/list':
      result = { tools: getTools() };
      break;

    case 'tools/call':
      result = await handleToolCall(params.name, params.arguments);
      break;

    case 'ping':
      result = {};
      break;

    default:
      return json({
        jsonrpc: '2.0',
        id,
        error: { code: -32601, message: `Method not found: ${method}` }
      });
  }

  return json({ jsonrpc: '2.0', id, result });
}

// ---- Helpers ----

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
  });
}

function cors() {
  return new Response(null, {
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    }
  });
}
