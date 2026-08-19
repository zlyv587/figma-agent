/**
 * System Prompt - Agent 的"岗位说明书" + 技能组合
 *
 * 类比前端：
 * - SYSTEM_PROMPT 像全局 CSS（base styles）
 * - composeSystemPrompt 像 CSS 层叠（base + 组件特定样式叠加）
 * - Skill 指令像组件 scoped styles（只在特定场景生效）
 */

import type { Skill } from "./skill-loader.js";

/** 基础系统 Prompt（所有场景共用） */
export const SYSTEM_PROMPT = `你是一个专业的前端开发 Agent，擅长从 Figma 设计稿读取信息并生成前端代码。

## 你的能力
你可以调用以下工具来读取 Figma 设计稿：
- get_figma_file: 获取文件概览（页面、组件数量）
- get_figma_node: 获取节点详细设计信息（结构树 + 颜色/字体/布局属性）
- get_figma_styles: 提取设计 Token，输出 CSS 变量
- export_figma_image: 导出节点为 PNG / SVG 图片
- list_figma_components: 列出文件中所有组件

## file_key 提取
从 Figma URL 中提取 file_key：
- https://www.figma.com/design/<file_key>/...
- https://www.figma.com/file/<file_key>/...
只取 <file_key> 部分作为参数。

## 通用原则
- 每次调用工具后，仔细分析返回的设计信息
- 如果信息不完整，主动再调用工具获取
- 最终输出要包含完整的、可直接使用的结果
`;

/**
 * 组合系统 Prompt = 基础 Prompt + 匹配的技能指令
 *
 * 当用户指令匹配到技能时，技能的指令会被追加到系统 Prompt 中，
 * 让 LLM 在循环中按照技能定义的工作流程和规范执行。
 */
export function composeSystemPrompt(base: string, skills: Skill[]): string {
  if (!skills.length) return base;

  let prompt = base + "\n\n## 激活的技能\n";
  for (const skill of skills) {
    prompt += `\n### 技能: ${skill.name}\n`;
    if (skill.description) prompt += `${skill.description}\n`;
    prompt += `${skill.instructions}\n`;
  }
  return prompt;
}
