/**
 * Retry - 错误恢复与重试
 *
 * 生产环境的现实：
 * - OpenAI API 会 429 限流（特别是高峰期）
 * - API 会 500/502/503 服务端抖动
 * - 网络会超时、断连（ECONNRESET / ETIMEDOUT）
 * - MCP 工具会偶发失败
 *
 * 当前 Agent 遇到这些就直接报错，循环里 push 一条错误消息。
 * 生产级 Agent 应该：
 *   1. 识别"可重试"错误（限流/网络抖动）vs"不可重试"错误（参数错误/权限不足）
 *   2. 指数退避重试（避免打爆 API）
 *   3. 429 尊重 Retry-After 响应头
 *   4. 重试有上限，超限后优雅降级
 *
 * 类比前端：
 * - 像 axios-retry，但给 Agent 用
 * - chat() 像 fetch 请求 -> 失败自动重试
 * - streamChat() 像 SSE 连接 -> 连接失败重试，流中断不重试
 */

// ════════════════════════════════════════════════════════════
// 错误分类
// ════════════════════════════════════════════════════════════

export type ErrorKind = "rate_limit" | "server_error" | "network" | "client_error" | "unknown";

export interface ClassifiedError {
  kind: ErrorKind;
  retryable: boolean;
  /** 429 时的 Retry-After 秒数（如果 API 返回了） */
  retryAfterMs?: number;
  message: string;
}

/**
 * 判断一个错误是否可重试
 *
 * 可重试：429 限流、5xx 服务端错误、网络超时/断连
 * 不可重试：4xx 客户端错误（参数错、权限不足、模型不存在等）
 */
export function classifyError(err: any): ClassifiedError {
  const status = err?.status || err?.statusCode || err?.response?.status;
  const code = err?.code || "";
  const message = err?.message || String(err);

  // ── HTTP 状态码判断 ──
  if (status === 429) {
    // 尝试读取 Retry-After 头（秒 -> 毫秒）
    const retryAfter = err?.headers?.["retry-after"] || err?.response?.headers?.["retry-after"];
    const retryAfterMs = retryAfter ? parseFloat(retryAfter) * 1000 : undefined;
    return { kind: "rate_limit", retryable: true, retryAfterMs, message };
  }

  if (status && status >= 500 && status < 600) {
    return { kind: "server_error", retryable: true, message };
  }

  if (status && status >= 400 && status < 500) {
    return { kind: "client_error", retryable: false, message };
  }

  // ── 网络错误码判断 ──
  const networkErrors = ["ETIMEDOUT", "ECONNRESET", "ECONNREFUSED", "EPIPE", "EAI_AGAIN", "ENOTFOUND"];
  if (networkErrors.includes(code)) {
    return { kind: "network", retryable: true, message: code + ": " + message };
  }

  // ── 超时判断（OpenAI SDK 的 APITimeoutError）──
  if (err?.name === "APITimeoutError" || message.toLowerCase().includes("timeout")) {
    return { kind: "network", retryable: true, message };
  }

  // ── 连接错误（OpenAI SDK 的 APIConnectionError）──
  if (err?.name === "APIConnectionError" || message.toLowerCase().includes("connection")) {
    return { kind: "network", retryable: true, message };
  }

  return { kind: "unknown", retryable: false, message };
}

// ════════════════════════════════════════════════════════════
// 重试配置
// ════════════════════════════════════════════════════════════

export interface RetryOptions {
  /** 最大重试次数（不含首次调用）*/
  maxRetries?: number;
  /** 初始退避延迟（毫秒）*/
  initialDelayMs?: number;
  /** 最大退避延迟（毫秒）*/
  maxDelayMs?: number;
  /** 退避乘数（指数底数）*/
  backoffMultiplier?: number;
  /** 是否加抖动（避免雷鸣群效应）*/
  jitter?: boolean;
  /** 回调：每次重试时通知（用于 emit 事件 / 写日志）*/
  onRetry?: (info: RetryInfo) => void;
}

export interface RetryInfo {
  attempt: number;        // 第几次重试（0 = 首次失败，1 = 第一次重试）
  error: ClassifiedError;
  delayMs: number;        // 本次等待的延迟
  totalElapsedMs: number; // 从首次失败到现在的总耗时
}

// ════════════════════════════════════════════════════════════
// 核心重试函数
// ════════════════════════════════════════════════════════════

/**
 * 带指数退避的重试执行器
 *
 * @param fn      要执行的异步函数
 * @param options 重试配置
 * @returns fn 的返回值
 * @throws 超过最大重试次数后抛出最后一个错误
 *
 * 用法：
 *   const result = await retryWithBackoff(() => llm.chat(messages, tools), {
 *     maxRetries: 3,
 *     onRetry: (info) => console.log(`第 ${info.attempt} 次重试，等待 ${info.delayMs}ms`),
 *   });
 */
export async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  options: RetryOptions = {}
): Promise<T> {
  const {
    maxRetries = 3,
    initialDelayMs = 1000,
    maxDelayMs = 30000,
    backoffMultiplier = 2,
    jitter = true,
    onRetry,
  } = options;

  const startTime = Date.now();
  let lastError: any;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err: any) {
      lastError = err;
      const classified = classifyError(err);

      // 不可重试的错误，直接抛出
      if (!classified.retryable || attempt === maxRetries) {
        throw err;
      }

      // 计算退避延迟
      let delayMs: number;
      if (classified.retryAfterMs) {
        // 429 且有 Retry-After 头 -> 尊重服务端的指示
        delayMs = classified.retryAfterMs;
      } else {
        // 指数退避：initialDelay * multiplier^attempt
        delayMs = initialDelayMs * Math.pow(backoffMultiplier, attempt);
        delayMs = Math.min(delayMs, maxDelayMs);
        // 抖动：随机 +-25%，避免所有客户端同时重试
        if (jitter) {
          const jitterRange = delayMs * 0.25;
          delayMs = delayMs + (Math.random() * 2 - 1) * jitterRange;
        }
      }

      const info: RetryInfo = {
        attempt: attempt + 1,
        error: classified,
        delayMs: Math.round(delayMs),
        totalElapsedMs: Date.now() - startTime,
      };

      // 回调通知（emit 事件 / 写日志）
      if (onRetry) onRetry(info);

      // 等待
      await sleep(delayMs);
    }
  }

  // 理论上不会走到这里，但 TS 需要这行
  throw lastError;
}

/** sleep 工具函数 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 流式重试包装器
 *
 * 流式调用的特殊点：
 * - 连接阶段失败（还没收到任何 chunk）-> 可以重试
 * - 流中断（已经收到部分 chunk）-> 不能重试（会丢失已输出内容，且不好拼接）
 *
 * 所以只在"连接建立"阶段重试，一旦开始 yield 就不重试。
 *
 * @param fn  返回 AsyncGenerator 的工厂函数
 * @param options 重试配置
 */
export async function* retryStreamWithBackoff<T>(
  fn: () => Promise<AsyncIterable<T>>,
  options: RetryOptions = {}
): AsyncGenerator<T> {
  const { maxRetries = 3, onRetry } = options;
  const startTime = Date.now();
  let lastError: any;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    // 关键标记：是否已经开始往外吐 chunk
    // 一旦吐过，就不能重试了（重试会导致消费者收到重复内容）
    let startedYielding = false;
    try {
      const stream = await fn();
      // 连接成功，逐 chunk 消费
      for await (const chunk of stream) {
        startedYielding = true; // 第一个 chunk 输出后，标记为不可重试
        yield chunk;
      }
      return; // 流正常结束
    } catch (err: any) {
      lastError = err;

      // 已经输出过 chunk -> 直接抛出，不重试
      // 因为消费者已经收到了部分内容，重试会从头再来导致重复
      if (startedYielding) throw err;

      const classified = classifyError(err);

      if (!classified.retryable || attempt === maxRetries) {
        throw err;
      }

      let delayMs = classified.retryAfterMs || options.initialDelayMs || 1000;
      delayMs = Math.min(delayMs * Math.pow(options.backoffMultiplier || 2, attempt), options.maxDelayMs || 30000);
      if (options.jitter !== false) {
        delayMs += (Math.random() * 2 - 1) * delayMs * 0.25;
      }

      if (onRetry) {
        onRetry({
          attempt: attempt + 1,
          error: classified,
          delayMs: Math.round(delayMs),
          totalElapsedMs: Date.now() - startTime,
        });
      }

      await sleep(delayMs);
    }
  }

  throw lastError;
}
