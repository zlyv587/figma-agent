#!/usr/bin/env node

import "dotenv/config";
import { join } from "path";
import { LlmClient } from "./llm-client.js";
import { McpClient } from "./mcp-client.js";
import { runAgentLoop } from "./agent-loop.js";
import { SYSTEM_PROMPT } from "./prompts.js";
import { SkillLoader } from "./skill-loader.js";
import { OpenAIEmbedder } from "./embedder.js";
import { SkillRouter } from "./skill-router.js";
import { Observability } from "./observability.js";
import { HumanLoop } from "./human-loop.js";
import { EvalRunner, DEFAULT_EVAL_CASES } from "./eval.js";
import type { EvalResult } from "./eval.js";
import { WeChatHandler } from "./output-handler.js";

const apiKey = process.env.OPENAI_API_KEY || process.env.LLM_API_KEY || "";
const baseURL = process.env.LLM_BASE_URL || undefined;
const model = process.env.LLM_MODEL || "gpt-4o";
const embeddingApiKey = process.env.EMBEDDING_API_KEY || apiKey;
const embeddingBaseURL = process.env.EMBEDDING_BASE_URL || baseURL;
const embeddingModel = process.env.EMBEDDING_MODEL || "text-embedding-3-small";
const maxContextTokens = parseInt(process.env.MAX_CONTEXT_TOKENS || "128000");
const figmaServerPath = process.env.FIGMA_SERVER_PATH || "../figma-mcp-server/src/index.ts";
const skillsDir = process.env.SKILLS_DIR || join(process.cwd(), "skills");

function createEmbedder() {
  if (!embeddingApiKey) throw new Error("需要 Embedding API Key");
  return new OpenAIEmbedder({ apiKey: embeddingApiKey, baseURL: embeddingBaseURL, model: embeddingModel });
}

// ─── --stats ───
async function statsMode() {
  const obs = new Observability();
  const s = obs.getStats();
  console.log("┌──────────────────────────────────────┐");
  console.log("│  Agent 可观测性统计                    │");
  console.log("└──────────────────────────────────────┘\n");
  console.log("📊 总 Session: " + s.totalSessions);
  console.log("🔄 平均迭代: " + s.avgIterations.toFixed(1));
  console.log("💰 平均 Token: " + Math.round(s.avgTokens).toLocaleString());
  console.log("⏱️  平均耗时: " + (s.avgDurationMs / 1000).toFixed(1) + "s");
  if (Object.keys(s.toolUsage).length) {
    console.log("\n🔧 工具使用:");
    const max = Math.max(...Object.values(s.toolUsage));
    for (const [name, count] of Object.entries(s.toolUsage)) {
      const bar = "█".repeat(Math.round((count / max) * 15));
      console.log("  " + name.padEnd(20) + " " + bar + " " + count);
    }
  }
}

// ─── --traces ───
async function tracesMode() {
  const obs = new Observability();
  const sessions = obs.listSessions(20);
  console.log("┌──────────────────────────────────────┐");
  console.log("│  Agent Traces - 最近 " + sessions.length + " 条          │");
  console.log("└──────────────────────────────────────┘\n");
  if (!sessions.length) { console.log("暂无 trace 记录"); return; }
  for (const s of sessions) {
    const d = new Date(s.startedAt);
    const status = s.status === "completed" ? "✅" : s.status === "timeout" ? "⏱️" : "⚠️";
    const dur = s.endedAt ? ((s.endedAt - s.startedAt) / 1000).toFixed(1) + "s" : "?";
    console.log(status + " " + s.id);
    console.log("  " + d.toLocaleString() + " | " + (s.totalIterations || "?") + "迭代 | " +
      (s.totalTokens || 0).toLocaleString() + " token | " + dur);
    console.log("  📝 " + s.query.substring(0, 60));
    if (s.skills?.length) console.log("  🎯 " + s.skills.join(", "));
    console.log();
  }
}

// ─── --trace <id> ───
async function traceMode(id: string) {
  const obs = new Observability();
  const s = obs.getSession(id);
  if (!s) { console.log("❌ 未找到 trace: " + id); return; }
  console.log("┌──────────────────────────────────────┐");
  console.log("│  Trace: " + s.id);
  console.log("└──────────────────────────────────────┘\n");
  console.log("📝 查询: " + s.query);
  if (s.skills?.length) console.log("🎯 技能: " + s.skills.join(", "));
  console.log("📊 Token: " + (s.totalTokens || 0).toLocaleString());
  console.log("🔄 迭代: " + (s.totalIterations || 0));
  console.log("⏱️ 耗时: " + (s.endedAt ? ((s.endedAt - s.startedAt) / 1000).toFixed(1) + "s" : "未完成"));
  console.log("\n──────────── Events (" + s.events.length + ") ────────────\n");
  for (const e of s.events) {
    const ts = new Date(e.timestamp).toLocaleTimeString();
    let line = "[" + e.iteration + "] " + e.phase.padEnd(12) + " ";
    if (e.toolName) line += e.toolName;
    if (e.tokens) line += "  " + e.tokens + " token";
    if (e.latencyMs) line += "  " + (e.latencyMs / 1000).toFixed(1) + "s";
    console.log(line);
    if (e.result) console.log("     " + e.result.substring(0, 120));
  }
}

// ─── --eval ───
async function evalMode() {
  if (!apiKey) { console.error("❌ Eval 需要 OPENAI_API_KEY"); process.exit(1); }
  const llm = new LlmClient({ apiKey, baseURL, model });
  const loader = new SkillLoader(skillsDir);
  const allSkills = loader.loadAll();
  const embedder = createEmbedder();
  const router = new SkillRouter(embedder, allSkills, llm);
  const evalRunner = new EvalRunner(llm);
  const obs = new Observability();

  const mcp = new McpClient({ command: "npx", args: ["tsx", figmaServerPath] });
  console.log("🔌 连接 MCP Server...");
  await mcp.connect();
  console.log("✅ 已连接\n");

  const results: EvalResult[] = [];
  for (const evalCase of DEFAULT_EVAL_CASES) {
    console.log("══════════════════════════════════════");
    console.log("📋 Eval " + evalCase.id + ": " + evalCase.description);
    console.log("📝 " + evalCase.query);
    const route = await router.route(evalCase.query);
    const result = await runAgentLoop(llm, mcp, evalCase.query, SYSTEM_PROMPT, {
      matchedSkills: route.skills, observability: obs, verbose: false, maxContextTokens,
    });
    const er = await evalRunner.evaluate(evalCase, result.answer, result.toolCalls, result.activeSkills);
    results.push(er);
    console.log("   关键词: " + (er.scores.keywordMatch * 100).toFixed(0) + "% | 工具: " +
      (er.scores.toolMatch * 100).toFixed(0) + "% | 技能: " + (er.scores.skillMatch * 100).toFixed(0) +
      "% | LLM: " + er.scores.llmJudge + "/10 | 综合: " + er.overall + "/10\n");
  }
  await mcp.disconnect();
  console.log(evalRunner.formatReport(results));
}

// ─── --route-test ───
async function routeTestMode() {
  const loader = new SkillLoader(skillsDir);
  const allSkills = loader.loadAll();
  if (!allSkills.length) { console.log("⚠️ 未找到技能"); return; }
  console.log("📚 技能库: " + allSkills.length + " 个\n");
  if (!embeddingApiKey) {
    console.log("⚠️ 需要 Embedding API Key\n");
    console.log("   请在 .env 中设置 OPENAI_API_KEY 或 EMBEDDING_API_KEY\n");
    console.log("   💡 不需要 API 的命令:");
    console.log("      npx tsx src/index.ts --list-skills");
    console.log("      npx tsx src/index.ts --list-tools");
    return;
  }
  const embedder = createEmbedder();
  console.log("📊 Embedding: " + embeddingModel + "\n");
  const llm = apiKey ? new LlmClient({ apiKey, baseURL, model }) : null;
  const router = new SkillRouter(embedder, allSkills, llm ?? undefined);
  const queries = ["帮我生成首页代码", "审查一下这个设计稿", "提取设计变量", "帮我把 Figma 设计转成 React 组件", "这个稿子间距规范吗", "生成 tailwind 主题配置"];
  for (const q of queries) {
    const r = await router.route(q, 5);
    console.log('📝 "' + q + '"');
    for (const c of r.candidates) {
      const b = "█".repeat(Math.round(c.score * 30)) + "░".repeat(30 - Math.round(c.score * 30));
      console.log("   " + c.skill.name.padEnd(16) + " " + c.score.toFixed(3) + " " + b);
    }
    const sel = r.skills.map((s) => s.name).join(", ") || "无";
    console.log("   -> " + (r.llmDecision ? "LLM 精排: " : "路由: ") + sel + "\n");
  }
}

// ─── --list-skills / --list-tools ───
async function listSkillsMode() {
  const skills = new SkillLoader(skillsDir).loadAll();
  console.log("📦 已加载 " + skills.length + " 个技能:\n");
  for (const s of skills) {
    console.log("  📝 " + s.name + " (优先级:" + (s.priority ?? "-") + ")");
    console.log("     " + s.description);
    console.log("     触发词: " + s.triggers.join(", ") + "\n");
  }
}
async function listToolsMode() {
  const mcp = new McpClient({ command: "npx", args: ["tsx", figmaServerPath] });
  await mcp.connect();
  const tools = await mcp.listTools();
  console.log("📦 可用工具 (" + tools.length + "):\n");
  for (const t of tools) console.log("  🛠️  " + t.name + "\n     " + t.description + "\n");
  await mcp.disconnect();
}

// ─── Agent 模式（支持 --stream --human --observe）───
async function agentMode(query: string, flags: string[]) {
  if (!apiKey) { console.error("❌ 需要 OPENAI_API_KEY"); process.exit(1); }
  const streaming = flags.includes("--stream");
  const human = flags.includes("--human");
  const observe = flags.includes("--observe");
  const wechat = flags.includes("--wechat");

  console.log("┌──────────────────────────────────────────┐");
  console.log("│  Figma Agent - 设计稿 -> 代码生成         │");
  console.log("└──────────────────────────────────────────┘\n");
  console.log("📝 " + query);
  console.log("🤖 " + model + (baseURL ? " @ " + baseURL : ""));
  const features = [];
  if (streaming) features.push("🌊流式");
  if (human) features.push("⏸️HumanLoop");
  if (observe) features.push("📡可观测");
  if (wechat) features.push("💬微信");
  if (features.length) console.log("🔧 " + features.join(" "));
  console.log();

  const llm = new LlmClient({ apiKey, baseURL, model });
  const allSkills = new SkillLoader(skillsDir).loadAll();
  const embedder = createEmbedder();
  const router = new SkillRouter(embedder, allSkills, llm);
  const routeResult = await router.route(query);

  console.log("🎯 路由: " + (routeResult.skills.map((s) => s.name).join(", ") || "无匹配，全工具"));
  for (const c of routeResult.candidates)
    console.log("   " + c.skill.name.padEnd(16) + " " + c.score.toFixed(3));

  const mcp = new McpClient({ command: "npx", args: ["tsx", figmaServerPath] });
  console.log("\n🔌 连接 MCP...");
  await mcp.connect();

  try {
    const result = await runAgentLoop(llm, mcp, query, SYSTEM_PROMPT, {
      matchedSkills: routeResult.skills,
      streaming, humanLoop: human ? new HumanLoop() : undefined,
      observability: observe ? new Observability() : undefined,
      outputHandler: wechat ? new WeChatHandler("user_" + Date.now()) : undefined,
      maxContextTokens,
    });
    console.log("\n" + "═".repeat(60));
    console.log("📋 结果:\n" + "═".repeat(60));
    console.log(result.answer);
    console.log("\n" + "─".repeat(60));
    console.log("迭代:" + result.iterations + " Token:" + result.tokensUsed.toLocaleString() +
      " 耗时:" + (result.elapsedMs / 1000).toFixed(1) + "s 工具:" + result.toolCalls.length + "次 状态:" + result.stoppedReason);
    if (result.sessionId) console.log("Session: " + result.sessionId);
  } finally { await mcp.disconnect(); }
}

// ─── CLI ───
const args = process.argv.slice(2);
if (args.includes("--route-test")) routeTestMode().catch(console.error);
else if (args.includes("--list-skills")) listSkillsMode().catch(console.error);
else if (args.includes("--list-tools")) listToolsMode().catch(console.error);
else if (args.includes("--eval")) evalMode().catch(console.error);
else if (args.includes("--traces")) tracesMode().catch(console.error);
else if (args.includes("--stats")) statsMode().catch(console.error);
else if (args.includes("--trace")) {
  const i = args.indexOf("--trace");
  if (args[i + 1]) traceMode(args[i + 1]);
  else console.log("用法: npx tsx src/index.ts --trace <session-id>");
} else {
  const flags = args.filter((a) => a.startsWith("--"));
  const queryArgs = args.filter((a) => !a.startsWith("--"));
  if (queryArgs[0]) agentMode(queryArgs[0], flags).catch(console.error);
  else {
    console.log("┌──────────────────────────────────────────────────┐");
    console.log("│  Figma Agent - 生产级 Agent 系统                   │");
    console.log("└──────────────────────────────────────────────────┘");
    console.log("\n运行 Agent:");
    console.log('  npx tsx src/index.ts "你的指令" [--stream] [--human] [--observe] [--wechat]');
    console.log("\nWeb UI:");
    console.log("  npx tsx src/server.ts  # http://localhost:3000");
    console.log("\n评估 & 分析:");
    console.log("  npx tsx src/index.ts --eval          # 📊 运行 Eval 评估套件");
    console.log("  npx tsx src/index.ts --traces        # 📡 查看 trace 列表");
    console.log("  npx tsx src/index.ts --trace <id>    # 🔍 查看单条 trace 详情");
    console.log("  npx tsx src/index.ts --stats        # 📈 聚合统计");
    console.log("\n其他:");
    console.log("  npx tsx src/index.ts --route-test   # 🔬 路由测试");
    console.log("  npx tsx src/index.ts --list-skills   # 技能列表");
    console.log("  npx tsx src/index.ts --list-tools    # MCP 工具");
    console.log("\n示例:");
    console.log('  npx tsx src/index.ts "生成代码: https://www.figma.com/design/xxx/App" --stream --observe');
  }
}
