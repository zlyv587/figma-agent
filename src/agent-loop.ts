/**
 * Agent Loop - 核心循环引擎（平台无关输出）
 *
 * 所有的输出都通过 OutputHandler.emit() 发事件
 * 不再直接写 process.stdout / console.log
 *
 * 不同平台只需换 handler：
 *   CLI     -> ConsoleHandler（process.stdout）
 *   Web     -> SSEHandler（HTTP SSE 推送）
 *   微信    -> WeChatHandler（攒批发送）
 */

import type { LlmClient } from "./llm-client.js";
import type { McpClient } from "./mcp-client.js";
import type { Skill } from "./skill-loader.js";
import type { Observability } from "./observability.js";
import type { HumanLoop } from "./human-loop.js";
import type { ToolCallLog } from "./eval.js";
import type { OutputHandler } from "./output-handler.js";
import { ConsoleHandler } from "./output-handler.js";
import { composeSystemPrompt } from "./prompts.js";
import { manageContext, countMessageTokens } from "./context-manager.js";

export interface LoopOptions {
  maxIterations?: number;
  maxTokens?: number;
  timeoutMs?: number;
  verbose?: boolean;
  matchedSkills?: Skill[];
  streaming?: boolean;
  humanLoop?: HumanLoop;
  observability?: Observability;
  outputHandler?: OutputHandler;
  maxContextTokens?: number; // 上下文窗口大小（超出自动压缩）
}

export interface LoopResult {
  answer: string;
  iterations: number;
  tokensUsed: number;
  elapsedMs: number;
  toolCalls: ToolCallLog[];
  stoppedReason: "completed" | "max_iterations" | "token_budget" | "timeout";
  activeSkills: string[];
  sessionId?: string;
}

// ─── 流式 Think：文本通过 handler.emit 发送 ───
async function thinkWithStreaming(
  llm: LlmClient,
  messages: any[],
  tools: any[],
  handler: OutputHandler
): Promise<{ message: any; tokens: number }> {
  let content = "";
  const toolMap = new Map<number, { id: string; function: { name: string; arguments: string } }>();
  let tokens = 0;

  for await (const chunk of llm.streamChat(messages, tools)) {
    const delta = chunk.choices[0]?.delta;
    if (delta?.content) {
      // ✅ 关键变化：不直接写 stdout，而是通过 handler 发事件
      await handler.emit({ type: "text", content: delta.content });
      content += delta.content;
    }
    if (delta?.tool_calls) {
      for (const tc of delta.tool_calls) {
        if (!toolMap.has(tc.index))
          toolMap.set(tc.index, { id: "", function: { name: "", arguments: "" } });
        const ex = toolMap.get(tc.index)!;
        if (tc.id) ex.id = tc.id;
        if (tc.function?.name) ex.function.name += tc.function.name;
        if (tc.function?.arguments) ex.function.arguments += tc.function.arguments;
      }
    }
    if (chunk.usage) tokens = chunk.usage.total_tokens || 0;
  }

  const toolCalls = [...toolMap.values()].map((tc) => ({
    id: tc.id, type: "function" as const, function: tc.function,
  }));
  return {
    message: { role: "assistant", content: content || null, tool_calls: toolCalls.length ? toolCalls : undefined },
    tokens,
  };
}

// ─── 核心循环 ───
export async function runAgentLoop(
  llm: LlmClient,
  mcp: McpClient,
  userQuery: string,
  systemPrompt: string,
  options: LoopOptions = {}
): Promise<LoopResult> {
  const {
    maxIterations = 20, maxTokens = 200000, timeoutMs = 180000,
    verbose = true, matchedSkills = [], streaming = false,
    humanLoop, observability: obs,
  } = options;

  // 输出处理器：没传就用 ConsoleHandler
  const handler = options.outputHandler ?? new ConsoleHandler(verbose);

  const composedPrompt = composeSystemPrompt(systemPrompt, matchedSkills);

  // ─── 工具准备 ───
  const mcpTools = await mcp.listTools();
  let llmTools = mcpTools.map((t) => ({
    type: "function" as const,
    function: { name: t.name, description: t.description || "", parameters: t.inputSchema || { type: "object", properties: {} } },
  }));
  if (matchedSkills.length) {
    const names = [...new Set(matchedSkills.flatMap((s) => s.tools || []))];
    if (names.length) llmTools = llmTools.filter((t) => names.includes(t.function.name));
  }

  // ─── 可观测性 ───
  let sessionId: string | undefined;
  if (obs) {
    sessionId = obs.startSession(userQuery, matchedSkills.map((s) => s.name));
    await handler.emit({ type: "session_start", sessionId });
  }

  const messages: any[] = [
    { role: "system", content: composedPrompt },
    { role: "user", content: userQuery },
  ];

  let iterations = 0, tokensUsed = 0;
  const startTime = Date.now();
  const toolCallLog: ToolCallLog[] = [];
  let stoppedReason: LoopResult["stoppedReason"] = "max_iterations";

  // ═════════════ 核心循环 ═════════════
  while (iterations < maxIterations) {
    iterations++;

    if (tokensUsed >= maxTokens) { stoppedReason = "token_budget"; break; }
    if (Date.now() - startTime > timeoutMs) { stoppedReason = "timeout"; break; }

    // ─── 上下文窗口管理：超阈值时自动压缩 ───
    if (options.maxContextTokens) {
      const cr = await manageContext(messages, llm, { maxTokens: options.maxContextTokens });
      if (cr.compressed) {
        await handler.emit({ type: "context_compressed", content: cr.tokensBefore + " -> " + cr.tokensAfter + " tokens" });
        if (obs && sessionId)
          obs.logEvent(sessionId, { iteration: iterations, phase: "think", metadata: { compressed: true, tokensBefore: cr.tokensBefore, tokensAfter: cr.tokensAfter } });
      }
    }

    // ─── Think ───
    await handler.emit({ type: "think_start", iteration: iterations });
    const thinkStart = Date.now();
    let assistantMessage: any;
    let thinkTokens = 0;

    if (streaming) {
      const r = await thinkWithStreaming(llm, messages, llmTools, handler);
      assistantMessage = r.message;
      thinkTokens = r.tokens;
    } else {
      const resp = await llm.chat(messages, llmTools);
      assistantMessage = resp.choices[0]?.message;
      thinkTokens = resp.usage?.total_tokens || 0;
    }

    tokensUsed += thinkTokens;
    if (obs && sessionId)
      obs.logEvent(sessionId, { iteration: iterations, phase: "think", tokens: thinkTokens, latencyMs: Date.now() - thinkStart });

    messages.push(assistantMessage);

    // ─── 判断结束 ───
    const toolCalls = assistantMessage.tool_calls;
    if (!toolCalls || toolCalls.length === 0) {
      stoppedReason = "completed";
      await handler.emit({ type: "complete", metadata: { iterations, tokensUsed, elapsedMs: Date.now() - startTime, toolCalls: toolCallLog.length } });
      break;
    }

    // ─── Act + Observe ───
    for (const tc of toolCalls) {
      const fnName = tc.function.name;
      let fnArgs: Record<string, any>;
      try { fnArgs = JSON.parse(tc.function.arguments); } catch { fnArgs = {}; }

      // ── Human-in-the-Loop ──
      if (humanLoop) {
        const risk = humanLoop.isRisky(fnName, fnArgs);
        if (risk.risky) {
          await handler.emit({ type: "human_pause", toolName: fnName, toolArgs: fnArgs });
          if (obs && sessionId) obs.logEvent(sessionId, { iteration: iterations, phase: "human_pause", toolName: fnName, toolArgs: fnArgs });
          const conf = await humanLoop.confirm(fnName, fnArgs, risk.reason!);
          await handler.emit({ type: "human_resume", toolName: fnName, success: conf.approved });
          if (obs && sessionId) obs.logEvent(sessionId, { iteration: iterations, phase: "human_resume", toolName: fnName });
          if (!conf.approved) {
            messages.push({ role: "tool", tool_call_id: tc.id, content: "用户拒绝了此操作" });
            continue;
          }
          if (conf.modifiedArgs) fnArgs = conf.modifiedArgs;
        }
      }

      // ── 执行工具 ──
      await handler.emit({ type: "tool_call", toolName: fnName, toolArgs: fnArgs });
      const actStart = Date.now();
      try {
        const result = await mcp.callTool(fnName, fnArgs);
        const resultText = result.content?.map((c: any) => (c.type === "text" ? c.text : JSON.stringify(c))).join("\n") || JSON.stringify(result);
        await handler.emit({ type: "tool_result", toolName: fnName, result: resultText, success: !result.isError });

        if (obs && sessionId) {
          obs.logEvent(sessionId, { iteration: iterations, phase: "act", toolName: fnName, toolArgs: fnArgs, latencyMs: Date.now() - actStart });
          obs.logEvent(sessionId, { iteration: iterations, phase: "observe", toolName: fnName, result: resultText.substring(0, 500) });
        }

        toolCallLog.push({ name: fnName, args: fnArgs, result: resultText, success: !result.isError });
        messages.push({ role: "tool", tool_call_id: tc.id, content: resultText });
      } catch (err: any) {
        await handler.emit({ type: "error", content: err.message, toolName: fnName });
        if (obs && sessionId) obs.logEvent(sessionId, { iteration: iterations, phase: "error", toolName: fnName, result: err.message });
        toolCallLog.push({ name: fnName, args: fnArgs, result: "Error: " + err.message, success: false });
        messages.push({ role: "tool", tool_call_id: tc.id, content: "工具调用失败: " + err.message });
      }
    }
  }

  if (obs && sessionId)
    obs.endSession(sessionId, { status: stoppedReason, totalTokens: tokensUsed, totalIterations: iterations });

  const last = messages[messages.length - 1];
  return {
    answer: typeof last?.content === "string" ? last.content : "未完成任务",
    iterations, tokensUsed, elapsedMs: Date.now() - startTime,
    toolCalls: toolCallLog, stoppedReason,
    activeSkills: matchedSkills.map((s) => s.name), sessionId,
  };
}
