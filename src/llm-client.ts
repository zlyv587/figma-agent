/**
 * LLM Client - LLM 调用封装
 *
 * 支持两种调用模式：
 * 1. chat() - 一次性返回完整响应（默认）
 * 2. streamChat() - 流式返回，逐 token 输出（实时体验更好）
 */

import OpenAI from "openai";

export interface LlmConfig {
  apiKey: string;
  baseURL?: string;
  model: string;
}

export class LlmClient {
  private client: OpenAI;
  private model: string;

  constructor(config: LlmConfig) {
    this.client = new OpenAI({ apiKey: config.apiKey, baseURL: config.baseURL });
    this.model = config.model;
  }

  /** 一次性调用（等待完整响应） */
  async chat(messages: any[], tools?: any[]) {
    return this.client.chat.completions.create({
      model: this.model,
      messages,
      tools: tools?.length ? tools : undefined,
      tool_choice: tools?.length ? "auto" : undefined,
    });
  }

  /**
   * 流式调用（逐 token 返回）
   * 返回 AsyncGenerator，每 yield 一个 chunk
   * chunk.choices[0].delta.content = 文本片段
   * chunk.choices[0].delta.tool_calls = 工具调用片段
   * chunk.usage = token 统计（仅在最后一个 chunk，需 stream_options）
   */
  async *streamChat(messages: any[], tools?: any[]) {
    const stream = await this.client.chat.completions.create({
      model: this.model,
      messages,
      tools: tools?.length ? tools : undefined,
      tool_choice: tools?.length ? "auto" : undefined,
      stream: true,
      stream_options: { include_usage: true },
    });
    for await (const chunk of stream) {
      yield chunk;
    }
  }
}
