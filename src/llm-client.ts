/**
 * LLM Client - LLM 调用封装
 *
 * 支持两种调用模式：
 * 1. chat() - 一次性返回完整响应（默认）
 * 2. streamChat() - 流式返回，逐 token 输出（实时体验更好）
 */

import OpenAI from "openai";

import { retryWithBackoff, retryStreamWithBackoff, type RetryOptions } from "./retry.js";

export interface LlmConfig {
  apiKey: string;
  baseURL?: string;
  model: string;
  /** LLM 调用重试配置（默认最多重试 3 次）*/
  retryOptions?: RetryOptions;
}

export class LlmClient {
  private client: OpenAI;
  private model: string;
  private retryOptions?: RetryOptions;

  constructor(config: LlmConfig) {
    this.client = new OpenAI({ apiKey: config.apiKey, baseURL: config.baseURL });
    this.model = config.model;
    this.retryOptions = config.retryOptions;
  }

  /** 让 Agent Loop 注入重试回调（重试事件通过 handler 统一输出）*/
  setRetryCallback(onRetry: (info: import("./retry.js").RetryInfo) => void) {
    this.retryOptions = { ...(this.retryOptions || {}), onRetry };
  }

  /** 一次性调用（等待完整响应），自动重试 */
  async chat(messages: any[], tools?: any[]) {
    return retryWithBackoff(
      () => this.client.chat.completions.create({
        model: this.model,
        messages,
        tools: tools?.length ? tools : undefined,
        tool_choice: tools?.length ? "auto" : undefined,
      }),
      this.retryOptions,
    );
  }

  /**
   * 流式调用（逐 token 返回）
   * 返回 AsyncGenerator，每 yield 一个 chunk
   * chunk.choices[0].delta.content = 文本片段
   * chunk.choices[0].delta.tool_calls = 工具调用片段
   * chunk.usage = token 统计（仅在最后一个 chunk，需 stream_options）
   */
  async *streamChat(messages: any[], tools?: any[]) {
    // 流式重试：连接阶段失败会重试，流中断不重试（避免内容丢失）
    const retryGen = retryStreamWithBackoff(
      () => this.client.chat.completions.create({
        model: this.model,
        messages,
        tools: tools?.length ? tools : undefined,
        tool_choice: tools?.length ? "auto" : undefined,
        stream: true,
        stream_options: { include_usage: true },
      }) as Promise<AsyncIterable<any>>,
      this.retryOptions,
    );
    for await (const chunk of retryGen) {
      yield chunk;
    }
  }
}
