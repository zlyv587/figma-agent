/**
 * Skill Router - 技能路由器（向量检索 + LLM 路由）
 *
 * 两阶段路由架构（类比搜索引擎）：
 *
 *   用户指令
 *      │
 *      ▼
 *  ┌───────────────┐
 *  │ Step 1: 召回   │  向量检索，快速找 top-K 候选
 *  │ (向量相似度)   │  快但可能不够准
 *  └───────┬───────┘
 *          │ top-K 候选技能
 *          ▼
 *  ┌───────────────┐
 *  │ Step 2: 精排   │  LLM 从候选中选真正需要的
 *  │ (LLM 决策)     │  准但需要一次额外调用
 *  └───────┬───────┘
 *          │ 1~N 个选中技能
 *          ▼
 *      注入 Agent Loop
 *
 * 类比：
 * - 召回 = Google 搜索第一轮（快，结果多）
 * - 精排 = Google 排序（准，结果少）
 */

import type { Embedder } from "./embedder.js";
import { VectorStore } from "./vector-store.js";
import type { LlmClient } from "./llm-client.js";
import type { Skill } from "./skill-loader.js";

export interface RouteCandidate {
  skill: Skill;
  score: number;
}

export interface RouteResult {
  skills: Skill[];              // 最终选中的技能
  candidates: RouteCandidate[]; // 向量检索的候选列表（含分数）
  llmDecision?: string;        // LLM 的原始回复（调试用）
}

export class SkillRouter {
  private embedder: Embedder;
  private llm: LlmClient | null;
  private skills: Skill[];
  private vectorStore: VectorStore;
  private initialized = false;

  constructor(embedder: Embedder, skills: Skill[], llm?: LlmClient) {
    this.embedder = embedder;
    this.skills = skills;
    this.llm = llm || null;
    this.vectorStore = new VectorStore();
  }

  /**
   * 初始化：为每个技能生成 embedding，存入向量库
   * 这一步只执行一次，结果缓存在内存中
   */
  async initialize() {
    if (this.initialized) return;

    for (const skill of this.skills) {
      // 用技能名+描述+触发词组成"技能画像"文本
      const text = `${skill.name} ${skill.description} ${skill.triggers.join(" ")}`;
      const embedding = await this.embedder.embed(text);
      this.vectorStore.add(skill.name, embedding, { skill });
    }

    this.initialized = true;
  }

  /**
   * 路由：两阶段从用户指令找到最合适的技能
   */
  async route(query: string, topK: number = 5): Promise<RouteResult> {
    await this.initialize();

    // ─── Step 1: 向量检索（召回）───
    const queryEmbedding = await this.embedder.embed(query);
    const searchResults = this.vectorStore.search(queryEmbedding, topK);

    const candidates: RouteCandidate[] = searchResults.map((r) => ({
      skill: r.metadata.skill as Skill,
      score: r.score,
    }));

    // ─── Step 2: LLM 路由（精排）───
    if (this.llm && candidates.length > 0) {
      const skillList = candidates
        .map((c) => `- ${c.skill.name}: ${c.skill.description} (相似度: ${c.score.toFixed(3)})`)
        .join("\n");

      const response = await this.llm.chat(
        [
          {
            role: "system",
            content:
              "你是技能路由器。根据用户指令，从候选技能中选出最适合的技能。" +
              "可以选多个，也可以不选。只返回技能名称，用逗号分隔。" +
              "如果不需要任何技能，返回 none。",
          },
          {
            role: "user",
            content: `用户指令: ${query}\n\n候选技能:\n${skillList}`,
          },
        ],
      );

      const answer = response.choices[0]?.message?.content?.trim() || "none";

      if (answer.toLowerCase() === "none") {
        return { skills: [], candidates, llmDecision: answer };
      }

      const selectedNames = answer.split(/[,，\n]/).map((s) => s.trim());
      const selected = this.skills.filter((s) =>
        selectedNames.includes(s.name)
      );

      return { skills: selected, candidates, llmDecision: answer };
    }

    // 没有 LLM 时：取相似度 > 阈值的候选
    const threshold = 0.1;
    const selected = candidates
      .filter((c) => c.score > threshold)
      .map((c) => c.skill);

    return { skills: selected, candidates };
  }
}
