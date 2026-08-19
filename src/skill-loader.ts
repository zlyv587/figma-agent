/**
 * Skill Loader - 技能加载器
 *
 * 技能（Skill）是 Agent 的"插件系统"：
 * - 每个 Skill 是一个目录，包含 SKILL.md 文件
 * - SKILL.md = YAML frontmatter（元数据）+ Markdown（指令）
 * - Agent 根据用户指令匹配技能，注入对应的知识和工具
 *
 * 类比前端：
 * - Skill 像 VS Code 扩展 / Webpack 插件
 * - SKILL.md 的 frontmatter 像 package.json（声明依赖和元数据）
 * - 指令部分像 README（告诉 Agent 怎么用）
 */

import { readFileSync, readdirSync } from "fs";
import { join } from "path";

// ─────────────────────────────────────
// 类型定义
// ─────────────────────────────────────

export interface Skill {
  name: string;
  description: string;
  triggers: string[];       // 触发词，用户指令包含时激活
  tools?: string[];         // 此技能使用的工具（用于过滤工具范围）
  priority?: number;        // 优先级（数字越小越优先）
  instructions: string;      // Markdown 指令内容
  sourcePath: string;        // SKILL.md 文件路径
}

// ─────────────────────────────────────
// SkillLoader
// ─────────────────────────────────────

export class SkillLoader {
  private skillsDir: string;

  constructor(skillsDir: string) {
    this.skillsDir = skillsDir;
  }

  /** 加载目录下所有技能 */
  loadAll(): Skill[] {
    const skills: Skill[] = [];

    let entries: string[];
    try {
      entries = readdirSync(this.skillsDir);
    } catch {
      // 目录不存在，返回空数组
      return skills;
    }

    for (const entry of entries) {
      const skillPath = join(this.skillsDir, entry, "SKILL.md");
      try {
        const content = readFileSync(skillPath, "utf-8");
        skills.push(this.parseSkill(content, skillPath));
      } catch {
        // 不是技能目录或读取失败，跳过
      }
    }

    // 按优先级排序（数字小的在前）
    return skills.sort((a, b) => (a.priority ?? 99) - (b.priority ?? 99));
  }

  /** 解析 SKILL.md：分离 YAML frontmatter 和 Markdown body */
  private parseSkill(content: string, path: string): Skill {
    // frontmatter 格式: ---\n...yaml...\n---\n...markdown...
    const match = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
    if (!match) {
      // 无 frontmatter，整篇当指令
      return {
        name: "unknown",
        description: "",
        triggers: [],
        instructions: content.trim(),
        sourcePath: path,
      };
    }

    const meta = this.parseFrontmatter(match[1]);
    return {
      name: meta.name || "unknown",
      description: meta.description || "",
      triggers: meta.triggers || [],
      tools: meta.tools,
      priority: meta.priority,
      instructions: match[2].trim(),
      sourcePath: path,
    };
  }

  /**
   * 简易 YAML frontmatter 解析器
   * 支持 key: value 和列表（- item），够用即可
   * 不引入 js-yaml 依赖，保持轻量
   */
  private parseFrontmatter(yaml: string): Record<string, any> {
    const result: Record<string, any> = {};
    let currentKey = "";

    for (const line of yaml.split("\n")) {
      if (!line.trim()) continue;

      // 列表项: "  - value"
      const listMatch = line.match(/^\s+-\s+(.+)/);
      if (listMatch && currentKey) {
        if (!Array.isArray(result[currentKey])) {
          result[currentKey] = [];
        }
        result[currentKey].push(
          listMatch[1].trim().replace(/^["']|["']$/g, "")
        );
        continue;
      }

      // 键值对: "key: value"
      const kvMatch = line.match(/^(\w+):\s*(.*)/);
      if (kvMatch) {
        currentKey = kvMatch[1];
        const val = kvMatch[2].trim();
        if (val === "" || val === "|") {
          // 空值或 | 表示后面是多行列表
          result[currentKey] = [];
        } else {
          result[currentKey] = val.replace(/^["']|["']$/g, "");
        }
      }
    }

    return result;
  }

  /**
   * 根据用户指令匹配技能
   * 策略：关键词匹配 - 用户指令包含触发词则激活
   *
   * 这是最简单的匹配策略，生产环境可以用 embedding 相似度匹配
   */
  matchSkills(query: string, skills: Skill[]): Skill[] {
    const lower = query.toLowerCase();
    return skills.filter((skill) =>
      skill.triggers.some((trigger) =>
        this.matchTrigger(trigger, lower)
      )
    );
  }

  /**
   * 触发词匹配策略：
   * - 英文触发词：简单子串匹配
   * - 中文触发词：拆成2字块，所有块都出现在查询中即匹配
   *   例如 "生成代码" -> ["生成", "代码"]
   *   "帮我生成首页代码" 同时包含 "生成" 和 "代码" -> 匹配 ✓
   */
  private matchTrigger(trigger: string, query: string): boolean {
    const t = trigger.toLowerCase();
    // 英文：直接子串匹配
    if (/^[\x00-\x7F]+$/.test(t)) {
      return query.includes(t);
    }
    // 中文：拆成2字块，全部命中才算匹配
    const chunks: string[] = [];
    for (let i = 0; i < t.length; i += 2) {
      chunks.push(t.substring(i, i + 2));
    }
    return chunks.every((c) => query.includes(c));
  }
}
