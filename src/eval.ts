/**
 * Eval - 评估框架
 *
 * 衡量 Agent 输出质量，三种打分方式：
 * 1. 关键词匹配：期望的关键词是否出现在回答中（规则）
 * 2. 工具匹配：期望的工具是否被调用（规则）
 * 3. LLM-as-Judge：用 LLM 按评分标准打分（智能）
 *
 * 类比前端：像 Lighthouse / Jest，但给 Agent 输出打分
 * 生产环境可替换为：LangSmith / Braintrust / Phoenix
 */

import type { LlmClient } from "./llm-client.js";

export interface ToolCallLog {
  name: string;
  args: Record<string, any>;
  result: string;
  success: boolean;
}

export interface EvalCase {
  id: string;
  query: string;
  description: string;
  expectedKeywords?: string[];
  expectedTools?: string[];
  expectedSkills?: string[];
  rubric: string;
}

export interface EvalScore {
  keywordMatch: number;
  toolMatch: number;
  skillMatch: number;
  llmJudge: number;
  llmReasoning: string;
}

export interface EvalResult {
  caseId: string;
  query: string;
  answer: string;
  tools: string[];
  skills: string[];
  scores: EvalScore;
  overall: number;
  durationMs: number;
}

// 默认评估用例
export const DEFAULT_EVAL_CASES: EvalCase[] = [
  {
    id: "eval-001",
    query: "帮我生成代码: https://www.figma.com/design/abc123/MyApp",
    description: "代码生成场景",
    expectedKeywords: ["React", "import", "return"],
    expectedTools: ["get_figma_file", "get_figma_node"],
    expectedSkills: ["codegen"],
    rubric: "回答是否包含可直接运行的 React 组件代码？颜色是否用了 hex？布局是否用了 flexbox？",
  },
  {
    id: "eval-002",
    query: "审查一下这个设计稿: https://www.figma.com/design/abc123/MyApp",
    description: "设计审查场景",
    expectedKeywords: ["间距", "颜色", "字体"],
    expectedTools: ["get_figma_file", "get_figma_node"],
    expectedSkills: ["design-review"],
    rubric: "是否从间距、颜色、字体等维度审查？每项是否有✅/⚠️/❌标注？是否有总体评分？",
  },
  {
    id: "eval-003",
    query: "提取设计变量: https://www.figma.com/design/abc123/MyApp",
    description: "设计 Token 提取场景",
    expectedKeywords: ["--color", "tailwind", "config"],
    expectedTools: ["get_figma_styles"],
    expectedSkills: ["design-tokens"],
    rubric: "是否输出了 CSS 变量定义？是否输出了 Tailwind 配置？格式是否正确？",
  },
];

export class EvalRunner {
  private llm: LlmClient;

  constructor(llm: LlmClient) {
    this.llm = llm;
  }

  async evaluate(
    evalCase: EvalCase,
    answer: string,
    toolCalls: ToolCallLog[],
    skills: string[]
  ): Promise<EvalResult> {
    const start = Date.now();
    const scores: EvalScore = {
      keywordMatch: 0, toolMatch: 0, skillMatch: 0, llmJudge: 0, llmReasoning: "",
    };

    // 1. 关键词匹配
    if (evalCase.expectedKeywords?.length) {
      const matched = evalCase.expectedKeywords.filter((k) =>
        answer.toLowerCase().includes(k.toLowerCase())
      );
      scores.keywordMatch = matched.length / evalCase.expectedKeywords.length;
    }

    // 2. 工具匹配
    const usedTools = toolCalls.map((t) => t.name);
    if (evalCase.expectedTools?.length) {
      const matched = evalCase.expectedTools.filter((t) => usedTools.includes(t));
      scores.toolMatch = matched.length / evalCase.expectedTools.length;
    }

    // 3. 技能匹配
    if (evalCase.expectedSkills?.length) {
      const matched = evalCase.expectedSkills.filter((s) => skills.includes(s));
      scores.skillMatch = matched.length / evalCase.expectedSkills.length;
    }

    // 4. LLM-as-Judge
    try {
      const resp = await this.llm.chat([
        { role: "system", content: "你是 Agent 输出评估专家。按评分标准打分(0-10)。只返回JSON: {\"score\":数字,\"reasoning\":\"理由\"}" },
        { role: "user", content:
          `评分标准:\n${evalCase.rubric}\n\n用户指令:\n${evalCase.query}\n\nAgent回答:\n${answer.substring(0, 2000)}\n\n工具调用: ${usedTools.join(", ")}` },
      ]);
      const text = resp.choices[0]?.message?.content || "{}";
      const json = this.extractJson(text);
      scores.llmJudge = json.score ?? 0;
      scores.llmReasoning = json.reasoning ?? "";
    } catch {
      scores.llmReasoning = "LLM 评估失败";
    }

    // 加权综合分
    const overall = Math.round(
      (scores.keywordMatch * 2 + scores.toolMatch * 2 + scores.skillMatch * 1 + scores.llmJudge * 0.5) * 10
    ) / 10;

    return {
      caseId: evalCase.id,
      query: evalCase.query,
      answer,
      tools: usedTools,
      skills,
      scores,
      overall,
      durationMs: Date.now() - start,
    };
  }

  private extractJson(text: string): any {
    const m = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    try { return JSON.parse((m ? m[1] : text).trim()); }
    catch { return {}; }
  }

  formatReport(results: EvalResult[]): string {
    const lines = ["╔══════════════════════════════════════════════╗",
      "║          Agent Eval 评估报告                  ║",
      "╚══════════════════════════════════════════════╝\n"];

    let totalScore = 0;
    for (const r of results) {
      totalScore += r.overall;
      lines.push(`📋 ${r.caseId}: ${r.query.substring(0, 40)}...`);
      lines.push(`   关键词匹配: ${(r.scores.keywordMatch * 100).toFixed(0)}% | 工具匹配: ${(r.scores.toolMatch * 100).toFixed(0)}% | 技能匹配: ${(r.scores.skillMatch * 100).toFixed(0)}%`);
      lines.push(`   LLM 评分: ${r.scores.llmJudge}/10 | 综合: ${r.overall}/10`);
      if (r.scores.llmReasoning) lines.push(`   评语: ${r.scores.llmReasoning.substring(0, 100)}`);
      lines.push("");
    }

    const avg = (totalScore / results.length).toFixed(1);
    lines.push("─".repeat(50));
    lines.push(`📊 平均分: ${avg}/10 (${results.length} 个用例)`);
    const pass = results.filter((r) => r.overall >= 7).length;
    lines.push(`✅ 通过(≥7分): ${pass}/${results.length}`);

    return lines.join("\n");
  }
}
