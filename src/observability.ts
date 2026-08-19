/**
 * Observability - 可观测性
 *
 * 记录 Agent 每一轮循环的完整 trace：
 * - Think 阶段：token 消耗、延迟
 * - Act 阶段：工具名、参数、延迟
 * - Observe 阶段：结果摘要
 * - Human 暂停/恢复
 * - 错误
 *
 * 存储方式：JSON 文件（无依赖，生产环境可换 SQLite/Postgres）
 *
 * 类比前端：像 Sentry / DataDog，但给 Agent 用
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import { join } from "path";

export interface TraceEvent {
  iteration: number;
  phase: "think" | "act" | "observe" | "error" | "human_pause" | "human_resume";
  toolName?: string;
  toolArgs?: Record<string, any>;
  result?: string;
  tokens?: number;
  latencyMs?: number;
  timestamp: number;
}

export interface TraceSession {
  id: string;
  query: string;
  startedAt: number;
  endedAt?: number;
  status?: string;
  totalTokens?: number;
  totalIterations?: number;
  skills?: string[];
  events: TraceEvent[];
}

export interface ObservabilityStats {
  totalSessions: number;
  avgIterations: number;
  avgTokens: number;
  avgDurationMs: number;
  toolUsage: Record<string, number>;
}

export class Observability {
  private dataFile: string;
  private sessions = new Map<string, TraceSession>();

  constructor(dataDir?: string) {
    const dir = dataDir || join(process.cwd(), ".data");
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    this.dataFile = join(dir, "traces.json");
    this.load();
  }

  private load() {
    try {
      const data = readFileSync(this.dataFile, "utf-8");
      for (const s of JSON.parse(data)) this.sessions.set(s.id, s);
    } catch { /* 首次运行无文件 */ }
  }

  private save() {
    writeFileSync(this.dataFile, JSON.stringify([...this.sessions.values()], null, 2));
  }

  startSession(query: string, skills: string[]): string {
    const id = "sess_" + Date.now() + "_" + Math.random().toString(36).slice(2, 8);
    this.sessions.set(id, { id, query, startedAt: Date.now(), skills, events: [] });
    this.save();
    return id;
  }

  logEvent(sessionId: string, event: Omit<TraceEvent, "timestamp">) {
    const s = this.sessions.get(sessionId);
    if (!s) return;
    s.events.push({ ...event, timestamp: Date.now() });
    this.save();
  }

  endSession(sessionId: string, result: { status: string; totalTokens: number; totalIterations: number }) {
    const s = this.sessions.get(sessionId);
    if (!s) return;
    Object.assign(s, {
      endedAt: Date.now(),
      status: result.status,
      totalTokens: result.totalTokens,
      totalIterations: result.totalIterations,
    });
    this.save();
  }

  getSession(id: string) { return this.sessions.get(id); }

  listSessions(limit = 10): TraceSession[] {
    return [...this.sessions.values()]
      .sort((a, b) => b.startedAt - a.startedAt)
      .slice(0, limit);
  }

  getStats(): ObservabilityStats {
    const all = [...this.sessions.values()];
    if (!all.length) return { totalSessions: 0, avgIterations: 0, avgTokens: 0, avgDurationMs: 0, toolUsage: {} };
    const done = all.filter((s) => s.endedAt);
    const toolUsage: Record<string, number> = {};
    for (const s of all)
      for (const e of s.events)
        if (e.phase === "act" && e.toolName)
          toolUsage[e.toolName] = (toolUsage[e.toolName] || 0) + 1;
    const n = done.length || 1;
    return {
      totalSessions: all.length,
      avgIterations: done.reduce((s, x) => s + (x.totalIterations || 0), 0) / n,
      avgTokens: done.reduce((s, x) => s + (x.totalTokens || 0), 0) / n,
      avgDurationMs: done.reduce((s, x) => s + ((x.endedAt! - x.startedAt) || 0), 0) / n,
      toolUsage,
    };
  }
}
