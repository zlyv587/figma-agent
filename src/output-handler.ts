/**
 * Output Handler - 输出抽象层
 *
 * 核心思想：Agent Loop 不应该直接写 stdout，
 * 而是通过 handler.emit() 发事件，由具体平台决定怎么展示。
 *
 * Agent Loop ──emit(event)──▶ OutputHandler（接口）
 *                                │
 *              ┌─────────┬───────┼───────┬──────────┐
 *              ▼         ▼       ▼       ▼          ▼
 *         Console    SSE    WeChat   Slack    WebSocket
 *         (CLI)    (Web)   (微信)  (企业IM)   (实时双向)
 *
 * 每个平台有自己的约束：
 * - CLI:     无限长，实时输出
 * - Web SSE: 实时流式，HTTP 长连接
 * - 微信:    ❌ 不支持流式！必须攒批发送，5秒超时要异步
 * - 企业微信:  ✅ 支持卡片更新，可以模拟流式
 */

import type { ServerResponse } from "http";

// ─────────────────────────────────────
// 事件定义
// ─────────────────────────────────────

export interface AgentEvent {
  type:
    | "session_start"    // Agent 开始
    | "think_start"      // Think 阶段开始
    | "text"             // 流式文本块（LLM 输出的 token）
    | "tool_call"        // 工具调用
    | "tool_result"      // 工具结果
    | "human_pause"      // Human-in-the-Loop 暂停
    | "human_resume"     // 用户确认后恢复
    | "error"            // 错误
    | "context_compressed"
    | "security_alert"   // 安全告警（注入拦截 / 参数校验失败）
    | "complete";        // 完成
  iteration?: number;
  content?: string;
  toolName?: string;
  toolArgs?: Record<string, any>;
  result?: string;
  success?: boolean;
  sessionId?: string;
  metadata?: Record<string, any>;
}

export interface OutputHandler {
  emit(event: AgentEvent): void | Promise<void>;
}

// ─────────────────────────────────────
// 1. ConsoleHandler（CLI 终端）
// ─────────────────────────────────────

export class ConsoleHandler implements OutputHandler {
  constructor(private verbose = true) {}

  async emit(e: AgentEvent) {
    if (!this.verbose && e.type !== "complete") return;
    switch (e.type) {
      case "session_start":
        if (e.sessionId) console.log("\n📡 Session: " + e.sessionId);
        break;
      case "think_start":
        console.log("\n🧠 [Think] 迭代 " + e.iteration);
        break;
      case "text":
        process.stdout.write(e.content || "");
        break;
      case "tool_call":
        console.log("🔧 [Act] " + e.toolName + "(...)");
        break;
      case "tool_result":
        console.log((e.success ? "📊" : "❌") + " [Observe] " + (e.result || "").substring(0, 200));
        break;
      case "human_pause":
        console.log("\n⏸️  Human-in-the-Loop: " + e.toolName);
        break;
      case "human_resume":
        console.log("   " + (e.success ? "✅ 已批准" : "❌ 已拒绝"));
        break;
      case "security_alert":
        console.log("\n🔒 [Security] " + (e.content || ""));
        if (e.metadata?.risk) console.log("   风险等级: " + e.metadata.risk);
        if (e.metadata?.shouldBlock) console.log("   ⛔ 已拦截");
        break;
      case "error":
        console.log("❌ " + (e.content || ""));
        break;
      case "context_compressed":
        console.log("\n📦 [Context] 压缩: " + (e.content || ""));
        break;
      case "complete":
        console.log("\n✅ 完成");
        break;
    }
  }
}

// ─────────────────────────────────────
// 2. SSEHandler（Web UI，通过 HTTP SSE 推送）
// ─────────────────────────────────────
//
// 前端用 fetch + ReadableStream 接收：
//
//   const res = await fetch("/api/chat", { method: "POST", body: ... });
//   const reader = res.body.getReader();
//   while (true) {
//     const { done, value } = await reader.read();
//     if (done) break;
//     // 解析 SSE 事件，渲染到页面
//   }

export class SSEHandler implements OutputHandler {
  constructor(private res: ServerResponse) {
    this.res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "Access-Control-Allow-Origin": "*",
    });
  }

  async emit(e: AgentEvent) {
    this.res.write("data: " + JSON.stringify(e) + "\n\n");
  }

  end() {
    this.res.end();
  }
}

// ─────────────────────────────────────
// 3. WeChatHandler（微信，不支持流式，攒批发送）
// ─────────────────────────────────────
//
// 微信约束：
// - 公众号：5秒响应超时，长任务要先回"处理中"，再用客服消息异步推送
// - 企业微信：支持卡片更新，可以反复 update 模拟流式
// - 不支持 SSE/WebSocket
//
// 策略：攒到一定量或间隔到了就发一次

export class WeChatHandler implements OutputHandler {
  private textBuffer = "";
  private lastFlush = Date.now();
  private readonly FLUSH_INTERVAL = 2000; // 2秒发一次
  private readonly MAX_MSG_LEN = 2000;    // 微信单条消息限制
  private messages: string[] = [];        // 发送历史（模拟）

  constructor(
    private userId: string,
    private sendFn?: (userId: string, text: string) => Promise<void>
  ) {}

  async emit(e: AgentEvent) {
    switch (e.type) {
      case "think_start":
        // 发送状态消息（企业微信会更新卡片，公众号发新消息）
        await this.send("🤔 正在思考（第" + e.iteration + "轮）...");
        break;

      case "text":
        // ⚠️ 微信不支持流式！必须攒批
        this.textBuffer += e.content;
        await this.maybeFlush();
        break;

      case "tool_call":
        // 工具调用时先把攒的文本发出去
        await this.flush();
        await this.send("🔧 调用工具: " + e.toolName);
        break;

      case "tool_result":
        if (!e.success) await this.send("⚠️ 工具执行出错");
        break;

      case "complete":
        await this.flush();
        await this.send("✅ 处理完成");
        break;

      case "security_alert":
        await this.flush();
        await this.send("🔒 安全告警: " + (e.content || ""));
        break;
      case "error":
        await this.flush();
        await this.send("❌ 出错了: " + e.content);
        break;
    }
  }

  /** 检查是否到了该发送的时间 */
  private async maybeFlush() {
    if (Date.now() - this.lastFlush >= this.FLUSH_INTERVAL) {
      await this.flush();
    }
  }

  /** 把攒的文本发出去 */
  private async flush() {
    if (!this.textBuffer) return;
    // 微信消息长度限制，超长要分段
    while (this.textBuffer.length > this.MAX_MSG_LEN) {
      await this.send(this.textBuffer.substring(0, this.MAX_MSG_LEN));
      this.textBuffer = this.textBuffer.substring(this.MAX_MSG_LEN);
    }
    if (this.textBuffer) {
      await this.send(this.textBuffer);
      this.textBuffer = "";
    }
    this.lastFlush = Date.now();
  }

  /** 实际发送（真实环境调用微信 API，这里模拟） */
  private async send(text: string) {
    this.messages.push(text);
    if (this.sendFn) {
      // 真实环境：await this.sendFn(this.userId, text)
      await this.sendFn(this.userId, text);
    } else {
      // 模拟环境：打印到控制台
      console.log("  [微信 -> " + this.userId + "] " + text.substring(0, 80) + (text.length > 80 ? "..." : ""));
    }
  }

  /** 获取发送历史（测试用） */
  getMessages() {
    return this.messages;
  }
}
