/**
 * Web Server - SSE 流式 Web UI
 *
 * 启动后访问 http://localhost:3000 即可使用
 *
 * 架构：
 *   浏览器 (fetch + ReadableStream)
 *     │ POST /api/chat
 *     ▼
 *   Node HTTP Server
 *     │ 创建 SSEHandler(res)
 *     ▼
 *   Agent Loop (handler.emit -> SSE 推送)
 *     │ 每个事件 = 一条 SSE data 消息
 *     ▼
 *   浏览器实时渲染（think/text/tool/complete）
 */

import "dotenv/config";
import { createServer, type IncomingMessage, type ServerResponse } from "http";
import { join } from "path";
import { LlmClient } from "./llm-client.js";
import { McpClient } from "./mcp-client.js";
import { runAgentLoop } from "./agent-loop.js";
import { SYSTEM_PROMPT } from "./prompts.js";
import { SkillLoader } from "./skill-loader.js";
import { OpenAIEmbedder } from "./embedder.js";
import { SkillRouter } from "./skill-router.js";
import { SSEHandler } from "./output-handler.js";
import { Observability } from "./observability.js";

const apiKey = process.env.OPENAI_API_KEY || "";
const baseURL = process.env.LLM_BASE_URL || undefined;
const model = process.env.LLM_MODEL || "gpt-4o";
const embeddingApiKey = process.env.EMBEDDING_API_KEY || apiKey;
const embeddingBaseURL = process.env.EMBEDDING_BASE_URL || baseURL;
const embeddingModel = process.env.EMBEDDING_MODEL || "text-embedding-3-small";
const figmaServerPath = process.env.FIGMA_SERVER_PATH || "../figma-mcp-server/src/index.ts";
const skillsDir = process.env.SKILLS_DIR || join(process.cwd(), "skills");
const PORT = parseInt(process.env.PORT || "3000");

const HTML = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Figma Agent</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}body{font-family:system-ui;padding:20px;max-width:800px;margin:auto;background:#fafafa}
h1{margin-bottom:16px;font-size:18px;color:#333}
#input{display:flex;gap:8px;margin-bottom:16px}
#query{flex:1;padding:10px;border:1px solid #ddd;border-radius:8px;font-size:14px}
button{padding:10px 20px;background:#2563eb;color:#fff;border:none;border-radius:8px;cursor:pointer;font-size:14px}
button:disabled{background:#999}
#output{background:#fff;border:1px solid #ddd;border-radius:8px;padding:16px;min-height:300px;white-space:pre-wrap;font-size:14px;line-height:1.6}
.think{color:#6366f1;font-weight:bold;margin:8px 0;padding:4px 8px;background:#eef2ff;border-radius:4px;display:inline-block}
.tool{color:#f59e0b;font-weight:bold;margin:8px 0;padding:4px 8px;background:#fffbeb;border-radius:4px;display:inline-block}
.done{color:#10b981;font-weight:bold;margin:8px 0}
.err{color:#ef4444}
</style></head><body>
<h1>🎨 Figma Agent - Web UI（SSE 流式）</h1>
<div id="input"><input id="query" placeholder="输入指令，如：生成代码 https://www.figma.com/design/xxx/App" value=""/>
<button onclick="send()">发送</button></div>
<div id="output"></div>
<script>
async function send(){
  const q=document.getElementById('query').value;if(!q)return;
  const out=document.getElementById('output');out.innerHTML='';
  const res=await fetch('/api/chat',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({query:q})});
  const reader=res.body.getReader();const dec=new TextDecoder();let buf='';
  while(true){const{done,value}=await reader.read();if(done)break;
    buf+=dec.decode(value);const parts=buf.split('\\n\\n');buf=parts.pop();
    for(const part of parts){if(!part.startsWith('data: '))continue;
      const e=JSON.parse(part.slice(6));render(e);}}
  if(buf.startsWith('data: ')){const e=JSON.parse(buf.slice(6));render(e);}}
function render(e){
  const o=document.getElementById('output');
  switch(e.type){
    case'think_start':o.innerHTML+='<div class="think">🧠 Think #'+e.iteration+'</div>';break;
    case'text':o.innerHTML+=(e.content||'').replace(/</g,'&lt;');break;
    case'tool_call':o.innerHTML+='<div class="tool">🔧 '+e.toolName+'</div>';break;
    case'tool_result':o.innerHTML+='<div style="color:#888;font-size:12px;margin:4px 0;">'+(e.result||'').substring(0,100)+'...</div>';break;
    case'human_pause':o.innerHTML+='<div class="tool">⏸️ 等待确认: '+e.toolName+'</div>';break;
    case'complete':o.innerHTML+='<div class="done">✅ 完成</div>';break;
    case'error':o.innerHTML+='<div class="err">❌ '+(e.content||'')+'</div>';break;
  }
}
</script></body></html>`;

async function main() {
  if (!apiKey) { console.error("❌ 需要 OPENAI_API_KEY"); process.exit(1); }

  const llm = new LlmClient({ apiKey, baseURL, model });
  const allSkills = new SkillLoader(skillsDir).loadAll();
  const embedder = new OpenAIEmbedder({ apiKey: embeddingApiKey, baseURL: embeddingBaseURL, model: embeddingModel });
  const router = new SkillRouter(embedder, allSkills, llm);
  const mcp = new McpClient({ command: "npx", args: ["tsx", figmaServerPath] });
  await mcp.connect();

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    if (req.method === "GET" && req.url === "/") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(HTML);
      return;
    }

    if (req.method === "POST" && req.url === "/api/chat") {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", async () => {
        try {
          const { query } = JSON.parse(body);
          const handler = new SSEHandler(res);
          const route = await router.route(query);
          const obs = new Observability();
          await runAgentLoop(llm, mcp, query, SYSTEM_PROMPT, {
            matchedSkills: route.skills, streaming: true,
            outputHandler: handler, observability: obs,
          });
          handler.end();
        } catch (err: any) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: err.message }));
        }
      });
      return;
    }

    res.writeHead(404);
    res.end("Not found");
  });

  server.listen(PORT, () => {
    console.log("┌──────────────────────────────────────┐");
    console.log("│  🌐 Figma Agent Web UI               │");
    console.log("└──────────────────────────────────────┘");
    console.log("\n📍 访问: http://localhost:" + PORT);
    console.log("📡 SSE 流式输出已启用");
    console.log("🤖 模型: " + model);
    console.log("📚 技能: " + allSkills.length + " 个\n");
  });
}

main().catch(console.error);
