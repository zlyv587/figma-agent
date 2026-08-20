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
import type { SecurityChecker } from "./security.js";
import { retryWithBackoff, type RetryOptions } from "./retry.js";
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
  maxContextTokens?: number;
  initialMessages?: any[]; // 续接历史会话
  securityChecker?: SecurityChecker;
  /** 工具调用重试配置（默认最多 3 次）*/
  retryOptions?: RetryOptions;
  /** 并行工具调用（默认开启，LLM 一次生成多个 tool_call 时并行执行）*/
  parallelTools?: boolean;
}

export interface LoopResult {
  answer: string;
  iterations: number;
  tokensUsed: number;
  elapsedMs: number;
  toolCalls: ToolCallLog[];
  stoppedReason: "completed" | "max_iterations" | "token_budget" | "timeout" | "security_blocked";
  activeSkills: string[];
  sessionId?: string;
  messages: any[];
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
    humanLoop, observability: obs, securityChecker: sec, retryOptions: retryOpts, parallelTools = true,
  } = options;

  // 输出处理器：没传就用 ConsoleHandler
  const handler = options.outputHandler ?? new ConsoleHandler(verbose);

  // 注入 LLM 重试回调：让重试事件走 handler 统一输出
  if (retryOpts) {
    llm.setRetryCallback(async (info) => {
      await handler.emit({ type: "retry", content: info.error.message, metadata: { attempt: info.attempt, delayMs: info.delayMs, kind: info.error.kind } });
      if (obs && sessionId) obs.logEvent(sessionId, { iteration: 0, phase: "error", result: "Retry #" + info.attempt + " (" + info.error.kind + ") wait " + info.delayMs + "ms" });
    });
  }

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

  // 工具参数 Schema 映射（用于安全校验 LLM 生成的参数）
  const toolSchemaMap = new Map(mcpTools.map((t) => [t.name, t.inputSchema]));

  // 并行安全标记：只有 MCP 声明 readOnlyHint=true 的工具才允许并行
  // 非只读工具可能有副作用 / 依赖关系，必须串行
  const nonParallelSafeToolNames = new Set(
    mcpTools.filter((t) => !t.annotations?.readOnlyHint).map((t) => t.name)
  );

  // ─── 可观测性 ───
  let sessionId: string | undefined;
  if (obs) {
    sessionId = obs.startSession(userQuery, matchedSkills.map((s) => s.name));
    await handler.emit({ type: "session_start", sessionId });
  }

  const messages: any[] = options.initialMessages
    ? [
        { role: "system", content: composedPrompt },
        ...options.initialMessages.slice(1),
        { role: "user", content: userQuery },
      ]
    : [
        { role: "system", content: composedPrompt },
        { role: "user", content: userQuery },
      ];

  let iterations = 0, tokensUsed = 0;
  const startTime = Date.now();
  const toolCallLog: ToolCallLog[] = [];
  let stoppedReason: LoopResult["stoppedReason"] = "max_iterations";

  // ─── 安全检测（第一道防线）：Prompt 注入 ───
  if (sec) {
    const inj = sec.checkInjection(userQuery);
    if (inj.shouldBlock) {
      const names = inj.matchedRules.map((r) => r.name).join(", ");
      await handler.emit({ type: "security_alert", content: "检测到 Prompt 注入（" + names + "），已拦截", metadata: { risk: inj.risk, shouldBlock: true } });
      if (obs && sessionId) obs.logEvent(sessionId, { iteration: 0, phase: "error", result: "Security: 注入拦截 (" + names + ")" });
      stoppedReason = "security_blocked";
      if (obs && sessionId) obs.endSession(sessionId, { status: stoppedReason, totalTokens: 0, totalIterations: 0 });
      return { answer: "⛔ 请求已被安全防护拦截：检测到潜在的 Prompt 注入攻击。", iterations: 0, tokensUsed: 0, elapsedMs: Date.now() - startTime, toolCalls: [], stoppedReason, activeSkills: matchedSkills.map((s) => s.name), sessionId, messages };
    }
    if (inj.detected) {
      const names = inj.matchedRules.map((r) => r.name).join(", ");
      await handler.emit({ type: "security_alert", content: "检测到可疑模式（" + names + "），已标记但继续处理", metadata: { risk: inj.risk, shouldBlock: false } });
      if (obs && sessionId) obs.logEvent(sessionId, { iteration: 0, phase: "error", result: "Security: 可疑模式 (" + names + ")" });
    }
  }

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

    // ─── Act + Observe（两阶段：顺序校验 + 并行执行）───
    // 第一阶段：解析参数 + 安全校验 + Human-in-the-Loop（必须顺序，因为需要用户交互）
    const pendingCalls: { tc: any; fnName: string; fnArgs: Record<string, any> }[] = [];

    for (const tc of toolCalls) {
      const fnName = tc.function.name;
      let fnArgs: Record<string, any>;
      try { fnArgs = JSON.parse(tc.function.arguments); } catch { fnArgs = {}; }

      // ── 安全检测：工具参数校验 ──
      if (sec) {
        const schema = toolSchemaMap.get(fnName);
        const vr = sec.checkToolArgs(fnArgs, schema);
        if (!vr.valid) {
          const msg = "参数校验失败: " + vr.errors.join("; ");
          await handler.emit({ type: "security_alert", content: msg, toolName: fnName, metadata: { risk: "medium", shouldBlock: false } });
          if (obs && sessionId) obs.logEvent(sessionId, { iteration: iterations, phase: "error", toolName: fnName, result: "Security: " + msg });
          messages.push({ role: "tool", tool_call_id: tc.id, content: "\u274c 参数校验失败，请修正后重试: " + vr.errors.join("; ") });
          continue;
        }
      }

      // ── Human-in-the-Loop ──
      if (humanLoop) {
        const risk = humanLoop.isRisky(fnName, fnArgs);
        if (risk.risky) {
          await handler.emit({ type: "human_pause", toolName: fnName, toolArgs: fnArgs });
          if (obs && sessionId) obs.logEvent(sessionId, { iteration: iterations, phase: "human_pause", toolName: fnName, toolArgs: sec ? sec.maskDeep(fnArgs) : fnArgs });
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

      pendingCalls.push({ tc, fnName, fnArgs });
    }

    // 第二阶段：执行工具
    if (pendingCalls.length > 0) {
      // 只有一个工具调用 -> 不需要并行
      // 批次里有任何非只读工具 -> 回退串行（工具可能有副作用/依赖，并行会出错）
      const allReadOnly = pendingCalls.every((pc) => !nonParallelSafeToolNames.has(pc.fnName));
      if (pendingCalls.length === 1 || !parallelTools || !allReadOnly) {
        await handler.emit({ type: "parallel_skip", metadata: { count: pendingCalls.length, reason: !allReadOnly ? "包含非只读工具（可能有依赖/副作用），回退串行" : "关并行或仅单个工具" } });
        if (obs && sessionId) obs.logEvent(sessionId, { iteration: iterations, phase: "act", metadata: { parallel: false, reason: !allReadOnly ? "非只读工具" : "single/serial" } });
        // ── 串行执行 ──
        for (const pc of pendingCalls) {
          await handler.emit({ type: "tool_call", toolName: pc.fnName, toolArgs: pc.fnArgs });
          await executeTool(pc, iterations, handler, obs, sessionId, sec, retryOpts, mcp, messages, toolCallLog);
        }
      } else {
        // ── 并行执行 ──
        // 先发出所有 tool_call 事件
        for (const pc of pendingCalls)
          await handler.emit({ type: "tool_call", toolName: pc.fnName, toolArgs: pc.fnArgs });

        await handler.emit({ type: "parallel_start", metadata: { count: pendingCalls.length } });
        const parallelStart = Date.now();
        let sequentialSumMs = 0; // 记录每个工具各自的耗时（串行总时间 = 各个之和）

        // 并行执行：Promise.allSettled 保证一个失败不影响其他
        const results = await Promise.allSettled(
          pendingCalls.map(async (pc) => {
            const toolStart = Date.now();
            try {
              const result = await retryWithBackoff(
                () => mcp.callTool(pc.fnName, pc.fnArgs),
                { ...retryOpts, onRetry: async (info: any) => {
                  await handler.emit({ type: "retry", content: "工具 " + pc.fnName + ": " + info.error.message, metadata: { attempt: info.attempt, delayMs: info.delayMs, kind: info.error.kind, toolName: pc.fnName } });
                  if (obs && sessionId) obs.logEvent(sessionId, { iteration: iterations, phase: "error", toolName: pc.fnName, result: "Retry #" + info.attempt + " (" + info.error.kind + ") wait " + info.delayMs + "ms" });
                } }
              );
              const toolMs = Date.now() - toolStart;
              return { pc, result, toolMs, error: null as any };
            } catch (err: any) {
              return { pc, result: null, toolMs: Date.now() - toolStart, error: err };
            }
          })
        );

        // 按原始顺序处理结果（保证 tool_call_id 对应正确）
        for (const settled of results) {
          if (settled.status !== "fulfilled") continue;
          const { pc, result, toolMs, error } = settled.value;
          sequentialSumMs += toolMs;

          if (error) {
            await handler.emit({ type: "error", content: error.message, toolName: pc.fnName });
            if (obs && sessionId) obs.logEvent(sessionId, { iteration: iterations, phase: "error", toolName: pc.fnName, result: error.message });
            toolCallLog.push({ name: pc.fnName, args: pc.fnArgs, result: "Error: " + error.message, success: false });
            messages.push({ role: "tool", tool_call_id: pc.tc.id, content: "工具调用失败: " + error.message });
          } else {
            const resultText = result.content?.map((c: any) => (c.type === "text" ? c.text : JSON.stringify(c))).join("\n") || JSON.stringify(result);
            await handler.emit({ type: "tool_result", toolName: pc.fnName, result: resultText, success: !result.isError });
            if (obs && sessionId) {
              const maskedArgs = sec ? sec.maskDeep(pc.fnArgs) : pc.fnArgs;
              const maskedResult = sec ? sec.mask(resultText).substring(0, 500) : resultText.substring(0, 500);
              obs.logEvent(sessionId, { iteration: iterations, phase: "act", toolName: pc.fnName, toolArgs: maskedArgs, latencyMs: toolMs });
              obs.logEvent(sessionId, { iteration: iterations, phase: "observe", toolName: pc.fnName, result: maskedResult });
            }
            toolCallLog.push({ name: pc.fnName, args: pc.fnArgs, result: resultText, success: !result.isError });
            messages.push({ role: "tool", tool_call_id: pc.tc.id, content: resultText });
          }
        }

        const parallelMs = Date.now() - parallelStart;
        const speedup = (sequentialSumMs / parallelMs).toFixed(1);
        await handler.emit({ type: "parallel_done", metadata: { count: pendingCalls.length, parallelMs, sequentialMs: sequentialSumMs, speedup } });
        if (obs && sessionId) obs.logEvent(sessionId, { iteration: iterations, phase: "act", metadata: { parallel: true, count: pendingCalls.length, parallelMs, sequentialMs: sequentialSumMs, speedup } });
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
    activeSkills: matchedSkills.map((s) => s.name), sessionId, messages,
  };
}


// ─── 串行执行单个工具的辅助函数 ───
async function executeTool(
  pc: { tc: any; fnName: string; fnArgs: Record<string, any> },
  iterations: number,
  handler: OutputHandler,
  obs: Observability | undefined,
  sessionId: string | undefined,
  sec: SecurityChecker | undefined,
  retryOpts: any,
  mcp: McpClient,
  messages: any[],
  toolCallLog: any[]
) {
  const actStart = Date.now();
  try {
    const result = await retryWithBackoff(
      () => mcp.callTool(pc.fnName, pc.fnArgs),
      { ...retryOpts, onRetry: async (info: any) => {
        await handler.emit({ type: "retry", content: "工具 " + pc.fnName + ": " + info.error.message, metadata: { attempt: info.attempt, delayMs: info.delayMs, kind: info.error.kind, toolName: pc.fnName } });
        if (obs && sessionId) obs.logEvent(sessionId, { iteration: iterations, phase: "error", toolName: pc.fnName, result: "Retry #" + info.attempt + " (" + info.error.kind + ") wait " + info.delayMs + "ms" });
      } }
    );
    const resultText = result.content?.map((c: any) => (c.type === "text" ? c.text : JSON.stringify(c))).join("\n") || JSON.stringify(result);
    await handler.emit({ type: "tool_result", toolName: pc.fnName, result: resultText, success: !result.isError });
    if (obs && sessionId) {
      const maskedArgs = sec ? sec.maskDeep(pc.fnArgs) : pc.fnArgs;
      const maskedResult = sec ? sec.mask(resultText).substring(0, 500) : resultText.substring(0, 500);
      obs.logEvent(sessionId, { iteration: iterations, phase: "act", toolName: pc.fnName, toolArgs: maskedArgs, latencyMs: Date.now() - actStart });
      obs.logEvent(sessionId, { iteration: iterations, phase: "observe", toolName: pc.fnName, result: maskedResult });
    }
    toolCallLog.push({ name: pc.fnName, args: pc.fnArgs, result: resultText, success: !result.isError });
    messages.push({ role: "tool", tool_call_id: pc.tc.id, content: resultText });
  } catch (err: any) {
    await handler.emit({ type: "error", content: err.message, toolName: pc.fnName });
    if (obs && sessionId) obs.logEvent(sessionId, { iteration: iterations, phase: "error", toolName: pc.fnName, result: err.message });
    toolCallLog.push({ name: pc.fnName, args: pc.fnArgs, result: "Error: " + err.message, success: false });
    messages.push({ role: "tool", tool_call_id: pc.tc.id, content: "工具调用失败: " + err.message });
  }
}
