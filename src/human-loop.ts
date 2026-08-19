/**
 * Human-in-the-Loop - 人机交互拦截
 *
 * 在 Agent 执行高风险操作前暂停，等用户确认：
 * - approve: 批准执行
 * - reject: 拒绝（Agent 会看到拒绝信息，自行调整）
 * - edit: 修改参数后执行
 *
 * 类比前端：像 window.confirm()，但给 Agent 用
 * 生产环境可替换为：Slack 通知 / Web UI 审批 / 邮件确认
 */

import * as readline from "readline";

export interface RiskRule {
  tools?: string[];        // 需要确认的工具名
  argsPattern?: string;   // 参数正则匹配（额外条件）
  reason: string;         // 为什么需要确认
}

export interface ConfirmResult {
  approved: boolean;
  modifiedArgs?: Record<string, any>;
}

export const DEFAULT_RISK_RULES: RiskRule[] = [
  {
    tools: ["export_figma_image"],
    reason: "导出图片会生成公开 URL，可能泄露设计内容",
  },
];

export class HumanLoop {
  private rules: RiskRule[];
  enabled: boolean;

  constructor(rules: RiskRule[] = DEFAULT_RISK_RULES, enabled = true) {
    this.rules = rules;
    this.enabled = enabled;
  }

  /** 检查工具调用是否高风险 */
  isRisky(toolName: string, args: Record<string, any>): { risky: boolean; reason?: string } {
    if (!this.enabled) return { risky: false };
    for (const rule of this.rules) {
      if (rule.tools?.includes(toolName)) {
        if (rule.argsPattern) {
          const regex = new RegExp(rule.argsPattern);
          if (!regex.test(JSON.stringify(args))) continue;
        }
        return { risky: true, reason: rule.reason };
      }
    }
    return { risky: false };
  }

  /** 暂停并等待用户确认 */
  async confirm(
    toolName: string,
    args: Record<string, any>,
    reason: string
  ): Promise<ConfirmResult> {
    console.log("\n" + "⚠️".repeat(25));
    console.log("  ⚠️  高风险操作需要确认");
    console.log("  工具: " + toolName);
    console.log("  参数: " + JSON.stringify(args, null, 2).split("\n").join("\n  "));
    console.log("  原因: " + reason);
    console.log("⚠️".repeat(25) + "\n");

    const answer = await this.ask("批准执行？(y=批准 / n=拒绝 / e=修改参数): ");

    if (answer === "y" || answer === "yes") return { approved: true };
    if (answer === "e" || answer === "edit") {
      const newArgsStr = await this.ask("输入修改后的参数 (JSON): ");
      try {
        return { approved: true, modifiedArgs: JSON.parse(newArgsStr) };
      } catch {
        console.log("⚠️ JSON 解析失败，拒绝执行");
        return { approved: false };
      }
    }
    return { approved: false };
  }

  private ask(prompt: string): Promise<string> {
    return new Promise((resolve) => {
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      rl.question(prompt, (answer) => {
        rl.close();
        resolve(answer.trim().toLowerCase());
      });
    });
  }
}
