/**
 * Conversation Manager - 多轮会话管理
 *
 * 功能：
 * - 创建新会话（首次对话）
 * - 加载历史会话（继续对话）
 * - 保存对话历史（Agent 运行后自动保存）
 * - 列出/删除会话
 *
 * 存储：JSON 文件（与 observability 同目录 .data/）
 * 生产环境可换 PostgreSQL / Redis
 *
 * 类比前端：像 localStorage 存聊天记录，
 * 但这里是服务端持久化，刷新/重启不丢。
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import { join } from "path";

export interface Conversation {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messages: any[];        // 完整对话历史（Agent Loop 的 messages 数组）
  skills: string[];       // 激活过的技能
  sessionId?: string;     // 关联的可观测性 session
}

export class ConversationManager {
  private dataFile: string;
  private conversations = new Map<string, Conversation>();

  constructor(dataDir?: string) {
    const dir = dataDir || join(process.cwd(), ".data");
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    this.dataFile = join(dir, "conversations.json");
    this.load();
  }

  private load() {
    try {
      for (const c of JSON.parse(readFileSync(this.dataFile, "utf-8")))
        this.conversations.set(c.id, c);
    } catch { /* 首次运行无文件 */ }
  }

  private save() {
    writeFileSync(this.dataFile, JSON.stringify([...this.conversations.values()], null, 2));
  }

  /** 创建新会话 */
  create(query: string, skills: string[]): string {
    const id = "conv_" + Date.now() + "_" + Math.random().toString(36).slice(2, 8);
    this.conversations.set(id, {
      id, title: this.generateTitle(query),
      createdAt: Date.now(), updatedAt: Date.now(),
      messages: [], skills,
    });
    this.save();
    return id;
  }

  /** 获取会话 */
  get(id: string): Conversation | undefined {
    return this.conversations.get(id);
  }

  /** 更新会话（Agent 运行后保存） */
  update(id: string, messages: any[], skills: string[], sessionId?: string) {
    const conv = this.conversations.get(id);
    if (!conv) return;
    conv.messages = messages;
    conv.skills = skills;
    conv.sessionId = sessionId;
    conv.updatedAt = Date.now();
    this.save();
  }

  /** 列出会话（按更新时间倒序） */
  list(limit = 20): Conversation[] {
    return [...this.conversations.values()]
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, limit);
  }

  /** 删除会话 */
  delete(id: string): boolean {
    const existed = this.conversations.delete(id);
    if (existed) this.save();
    return existed;
  }

  /** 从用户指令生成标题 */
  private generateTitle(query: string): string {
    const t = query.trim();
    return t.length <= 40 ? t : t.substring(0, 40) + "...";
  }
}
