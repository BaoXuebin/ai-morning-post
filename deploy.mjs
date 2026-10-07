// 部署脚本：把 site/ 目录整体发布到 2AIGC Pages（走 MCP HTTP 接口）
// 用法：node deploy.mjs [项目名]（默认 ai-morning-post）
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));
const SITE = join(ROOT, 'site');
const PROJECT = process.argv[2] || 'ai-morning-post';

// 从 ZCode 配置读取 2AIGC Pages 的 MCP 地址（含 token），避免硬编码
const zcodeConfig = JSON.parse(
  readFileSync(join(process.env.HOME || process.env.USERPROFILE, '.zcode/cli/config.json'), 'utf8')
);
const ENDPOINT = zcodeConfig.mcp?.servers?.['2aigc-pages']?.url;
if (!ENDPOINT) {
  console.error('未在 ~/.zcode/cli/config.json 中找到 2aigc-pages 的 MCP 地址');
  process.exit(1);
}

function collectFiles(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...collectFiles(p));
    else if (['.html', '.css', '.js', '.json', '.svg', '.txt', '.xml'].includes(extname(p))) {
      out.push({ path: relative(SITE, p).replaceAll('\\', '/'), abs: p });
    }
  }
  return out;
}

const files = collectFiles(SITE).map((f) => ({
  path: f.path,
  content_base64: readFileSync(f.abs).toString('base64'),
}));
if (!files.some((f) => f.path === 'index.html')) {
  console.error('site 目录缺少 index.html，终止');
  process.exit(1);
}

let sessionId = null;
let idCounter = 0;

async function rpc(method, params, isNotification = false) {
  const body = {
    jsonrpc: '2.0',
    method,
    ...(isNotification ? {} : { id: ++idCounter }),
    ...(params ? { params } : {}),
  };
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      ...(sessionId ? { 'Mcp-Session-Id': sessionId } : {}),
    },
    body: JSON.stringify(body),
  });
  const sid = res.headers.get('mcp-session-id');
  if (sid) sessionId = sid;
  if (isNotification || !res.ok) return null;
  const raw = await res.text();
  // 响应可能是 SSE 流，取最后一条 data
  const lines = raw.split('\n').filter((l) => l.startsWith('data:'));
  const payload = lines.length ? lines[lines.length - 1].slice(5).trim() : raw;
  const json = JSON.parse(payload);
  if (json.error) throw new Error(`MCP 错误: ${JSON.stringify(json.error)}`);
  return json.result;
}

await rpc('initialize', {
  protocolVersion: '2024-11-05',
  capabilities: {},
  clientInfo: { name: 'ai-morning-post-deployer', version: '1.0.0' },
});
await rpc('notifications/initialized', undefined, true);

const totalKB = Math.round(files.reduce((s, f) => s + f.content_base64.length, 0) / 1024);
console.log(`上传 ${files.length} 个文件（约 ${totalKB} KB base64）到项目 ${PROJECT} ...`);

const result = await rpc('tools/call', {
  name: '2aigc_pages_deploy',
  arguments: { project: PROJECT, files },
});

const text = result?.content?.map((c) => c.text || '').join('\n') || JSON.stringify(result);
console.log(text);
