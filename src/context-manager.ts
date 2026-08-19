/**
 * Context Manager - 上下文窗口管理
 *
 * 解决问题：Agent 循环多轮后，消息历史越来越长，超出模型上下文窗口。
 *
 * 策略：滑动窗口 + 摘要压缩
 *
 *   压缩前:
 *   [system] [user] [asst+工具] [tool结果] [asst+工具] [tool结果] ... [asst+工具] [tool结果]
 *    └─────────── 压缩这些 ──────────┘└──── 保留最近 N 轮 ────┘
 *
 *   压缩后:
 *   [system] [摘要] [user] [asst+工具] [tool结果] ... [asst+工具] [tool结果]
 *
 * 类比前端：像虚拟列表（react-window），只渲染可见区域，上面的内容滚动出视口时移除。
 */

import type { LlmClient } from "./llm-client.js";

// ─────────────────────────────────────
// Token 估算
// ─────────────────────────────────────

/**
 * 粗略估算 token 数
 * - 英文：~4 字符 = 1 token
 * - 中文：~1.5 字符 = 1 token（中文字符信息密度更高）
 *
 * 生产环境应该用 tiktoken / gpt-tokenizer 精确计算
 * 这里用估算足以决定"何时该压缩"
 */
export function estimateTokens(text: string): number {
  const chineseChars = (text.match(/[\u4e00-\u9fff]/g) || []).length;
  const otherChars = text.length - chineseChars;
  return Math.ceil(chineseChars / 1.5 + otherChars / 4);
}

/** 计算消息数组的总 token 数 */
export function countMessageTokens(messages: any[]): number {
  let total = 0;
  for (const msg of messages) {
    let content = "";
    if (typeof msg.content === "string") {
      content = msg.content;
    } else if (Array.isArray(msg.content)) {
      content = msg.content.map((c: any) => c.text || JSON.stringify(c)).join("");
    }
    // tool_calls 也占 token
    if (msg.tool_calls) {
      content += JSON.stringify(msg.tool_calls);
    }
    // 每条消息有 ~4 token 的结构开销
    total += estimateTokens(content) + 4;
  }
  return total;
}

// ─────────────────────────────────────
// 压缩逻辑
// ─────────────────────────────────────

export interface CompressionResult {
  compressed: boolean;
  tokensBefore: number;
  tokensAfter: number;
  summary?: string;
  keptRounds: number;
}

export interface ContextOptions {
  maxTokens: number;          // 上下文窗口大小
  threshold?: number;         // 压缩触发阈值（默认 0.75 = 75%）
  keepLastRounds?: number;    // 保留最近几轮（默认 3）
}

/**
 * 找到第 N 轮（从末尾数）的起始位置
 * 一轮 = assistant(有 tool_calls) + 后续的 tool 结果
 */
function findRoundStart(messages: any[], keepRounds: number): number {
  let found = 0;
  for (let i = messages.length - 1; i >= 2; i--) {
    if (messages[i].role === "assistant" && messages[i].tool_calls?.length) {
      found++;
      if (found >= keepRounds) return i;
    }
  }
  return 2; // 找不到足够的轮次，从 index 2 开始
}

/**
 * 用 LLM 总结对话历史
 * 保留：调了哪些工具、获得了什么信息、做了什么决策
 */
async function summarizeWithLLM(messages: any[], llm: LlmClient): Promise<string> {
  const convo = messages.map((m) => {
    if (m.role === "assistant" && m.tool_calls) {
      return `助手: 调用工具 ${m.tool_calls.map((tc: any) => tc.function.name).join(", ")}`;
    }
    if (m.role === "assistant") {
      return "助手: " + (m.content || "").substring(0, 200);
    }
    if (m.role === "tool") {
      return "工具结果: " + (m.content || "").substring(0, 150);
    }
    return m.role + ": " + (m.content || "").substring(0, 100);
  }).join("\n");

  const resp = await llm.chat([
    {
      role: "system",
      content:
        "请将以下 Agent 对话历史压缩成简洁摘要（200字以内）。保留：1.调用了哪些工具 2.获得了什么关键信息 3.做了什么决策。不要包含代码。",
    },
    { role: "user", content: convo.substring(0, 8000) },
  ]);

  let summary = resp.choices[0]?.message?.content || "对话摘要不可用";
  if (summary.length > 1000) summary = summary.substring(0, 1000) + "...";
  return summary;
}

/**
 * 规则式摘要（无 LLM 时的 fallback）
 * 提取工具名和结果摘要
 */
function extractSummary(messages: any[]): string {
  const tools: string[] = [];
  const findings: string[] = [];

  for (const m of messages) {
    if (m.role === "assistant" && m.tool_calls) {
      for (const tc of m.tool_calls) tools.push(tc.function.name);
    }
    if (m.role === "tool" && m.content) {
      // 提取结果的前 80 个字符
      findings.push(m.content.substring(0, 80));
    }
  }

  let summary = `已调用工具: ${tools.join(", ")}`;
  if (findings.length) {
    summary += `\n关键结果: ${findings.join(" | ")}`;
  }
  return summary.substring(0, 800);
}

/**
 * 上下文管理：检查是否需要压缩，如果需要则压缩
 * 直接修改 messages 数组（原地替换）
 */
export async function manageContext(
  messages: any[],
  llm: LlmClient | undefined,
  options: ContextOptions
): Promise<CompressionResult> {
  const { maxTokens, threshold = 0.75, keepLastRounds = 3 } = options;

  const tokensBefore = countMessageTokens(messages);

  // 未超过阈值，不需要压缩
  if (tokensBefore < maxTokens * threshold) {
    return { compressed: false, tokensBefore, tokensAfter: tokensBefore, keptRounds: 0 };
  }

  // 逐步压缩：先保留 keepLastRounds 轮，不够再减
  let rounds = keepLastRounds;
  let summary: string | undefined;
  let currentMessages = [...messages];
  const userMsg = messages[1]; // 保存原始用户消息
  let tokens = tokensBefore;

  while (tokens >= maxTokens * threshold && rounds >= 1) {
    const boundary = findRoundStart(currentMessages, rounds);
    if (boundary <= 2) break; // 没有可压缩的内容了

    const toCompress = currentMessages.slice(2, boundary);
    const toKeep = currentMessages.slice(boundary);
    if (toCompress.length === 0) break;

    // 生成摘要
    summary = llm
      ? await summarizeWithLLM(toCompress, llm)
      : extractSummary(toCompress);

    // 重组消息：[system, 摘要, user, ...最近的轮次]
    currentMessages = [
      currentMessages[0], // system prompt
      { role: "system", content: `[之前的对话摘要]\n${summary}` },
      userMsg, // 原始用户指令（始终保留）
      ...toKeep,
    ];

    tokens = countMessageTokens(currentMessages);
    rounds--; // 还不够就再少保留一轮
  }

  // 原地替换 messages（agent loop 持有同一个引用）
  messages.length = 0;
  messages.push(...currentMessages);
  const tokensAfter = countMessageTokens(messages);

  return { compressed: true, tokensBefore, tokensAfter, summary, keptRounds: rounds + 1 };
}
