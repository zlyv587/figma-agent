/**
 * Security - 安全防护模块
 *
 * 生产级 Agent 的三道安全防线：
 *
 * 1. Prompt 注入检测（Input Guard）
 *    用户输入 -> 检测恶意模式 -> 拦截 / 警告
 *    防："ignore previous instructions"、"act as"、"reveal your prompt" 等
 *
 * 2. 工具参数校验（Tool Guard）
 *    LLM 生成的参数 -> 校验 JSON Schema -> 通过 / 拒绝
 *    防：LLM 瞎编参数、缺失必填、类型错误、注入额外字段
 *
 * 3. 密钥脱敏（Secret Masking）
 *    日志 / Trace / 观测数据 -> 自动遮蔽 API Key / Token
 *    防：FIGMA_ACCESS_TOKEN 泄露到 trace 文件里
 *
 * 类比前端：
 * - 注入检测 像 XSS 过滤（输入净化）
 * - 参数校验 像 Zod validate（API 层参数校验）
 * - 密钥脱敏 像 console 里密码字段显示 ****
 */

// ════════════════════════════════════════════════════════════
// 第一道防线：Prompt 注入检测
// ════════════════════════════════════════════════════════════

export type InjectionSeverity = "low" | "medium" | "high";

export interface InjectionRule {
  /** 规则名（用于日志展示） */
  name: string;
  /** 匹配正则（不区分大小写） */
  pattern: RegExp;
  /** 严重程度 */
  severity: InjectionSeverity;
  /** 说明 */
  description: string;
}

/**
 * 常见 Prompt 注入攻击模式库
 *
 * 这些模式覆盖了 OwASP LLM Top 10 中 LLM01 (Prompt Injection) 的主要攻击手法
 */
export const DEFAULT_INJECTION_RULES: InjectionRule[] = [
  // ── 直接指令覆盖 ──
  {
    name: "ignore_instructions",
    pattern: /ignore\s+(all\s+)?(previous|prior|above)\s+(instructions?|prompts?|rules?)/i,
    severity: "high",
    description: "试图让模型忽略原有指令",
  },
  {
    name: "disregard_above",
    pattern: /disregard\s+(all\s+)?(the\s+)?(above|previous|prior)/i,
    severity: "high",
    description: "试图让模型忽略上文",
  },
  {
    name: "forget_rules",
    pattern: /forget\s+(all\s+)?(your\s+)?(rules?|instructions?|guidelines?)/i,
    severity: "high",
    description: "试图让模型遗忘规则",
  },
  // ── 角色劫持 ──
  {
    name: "act_as",
    pattern: /(act|pretend|play)\s+as\s+(a|an|if)/i,
    severity: "medium",
    description: "试图改变模型角色设定",
  },
  {
    name: "you_are_now",
    pattern: /you\s+are\s+now\s+(a|an|the|in)/i,
    severity: "medium",
    description: "试图重新定义模型身份",
  },
  {
    name: "new_instructions",
    pattern: /(here|these)\s+are\s+(your\s+)?new\s+(instructions?|rules?|directives?)/i,
    severity: "high",
    description: "试图注入新指令",
  },
  // ── 系统提示窃取 ──
  {
    name: "reveal_prompt",
    pattern: /(reveal|show|print|repeat|output)\s+(your\s+)?(system\s+)?(prompt|instructions?|rules?|directives?)/i,
    severity: "medium",
    description: "试图套取系统提示词",
  },
  {
    name: "what_is_prompt",
    pattern: /what\s+(is|are)\s+your\s+(system\s+)?(prompt|instructions?|rules?)/i,
    severity: "low",
    description: "询问系统提示内容",
  },
  // ── 分隔符逃逸 ──
  {
    name: "role_injection",
    pattern: /<\s*\/?\s*(system|assistant|developer)\s*>/i,
    severity: "high",
    description: "试图注入角色标签逃逸上下文",
  },
  {
    name: "delimiter_escape",
    pattern: /```(system|assistant|developer)/i,
    severity: "high",
    description: "用代码块分隔符逃逸上下文边界",
  },
  // ── 越权执行 ──
  {
    name: "repeat_after_me",
    pattern: /repeat\s+(after\s+me|the\s+following)/i,
    severity: "medium",
    description: "经典的 'repeat after me' 攻击",
  },
  {
    name: "base64_instruction",
    pattern: /(decode|base64|from\s+base64)/i,
    severity: "low",
    description: "可能的编码绕过（base64 藏指令）",
  },
];

export interface InjectionResult {
  /** 是否检测到注入 */
  detected: boolean;
  /** 匹配到的规则 */
  matchedRules: InjectionRule[];
  /** 最高风险等级 */
  risk: InjectionSeverity | "none";
  /** 是否应当拦截（high -> true） */
  shouldBlock: boolean;
}

/**
 * Prompt 注入检测器
 *
 * 用法：
 *   const checker = new SecurityChecker();
 *   const result = checker.detectInjection(userQuery);
 *   if (result.shouldBlock) { // 拒绝处理 }
 */
export function detectPromptInjection(
  text: string,
  rules: InjectionRule[] = DEFAULT_INJECTION_RULES
): InjectionResult {
  const matched: InjectionRule[] = [];

  for (const rule of rules) {
    if (rule.pattern.test(text)) {
      matched.push(rule);
    }
  }

  if (!matched.length) {
    return { detected: false, matchedRules: [], risk: "none", shouldBlock: false };
  }

  // 取最高风险等级
  const severityOrder: InjectionSeverity[] = ["low", "medium", "high"];
  let maxSeverity: InjectionSeverity = "low";
  for (const m of matched) {
    if (severityOrder.indexOf(m.severity) > severityOrder.indexOf(maxSeverity)) {
      maxSeverity = m.severity;
    }
  }

  return {
    detected: true,
    matchedRules: matched,
    risk: maxSeverity,
    // high 级别直接拦截，medium/low 只警告
    shouldBlock: maxSeverity === "high",
  };
}

// ════════════════════════════════════════════════════════════
// 第二道防线：工具参数校验（轻量 JSON Schema Validator）
// ════════════════════════════════════════════════════════════
//
// MCP Server 用 Zod 定义工具参数，SDK 会转成 JSON Schema。
// Agent 从 listTools() 拿到的 inputSchema 就是标准 JSON Schema。
//
// 我们实现一个轻量校验器，覆盖 Zod 常生成的关键字：
//   type, required, properties, enum, additionalProperties,
//   minLength, maxLength, pattern, minimum, maximum
//
// 不用 ajv（虽然纯 JS，但为了零依赖原则自己写）

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

/**
 * 校验一个值是否符合 JSON Schema
 *
 * @param value   待校验的值（LLM 生成的工具参数）
 * @param schema  JSON Schema（MCP 工具的 inputSchema）
 * @param path    当前路径（用于错误定位，如 ".file_key"）
 */
function validateValue(
  value: any,
  schema: any,
  path: string = ""
): string[] {
  const errors: string[] = [];

  // ── type 校验 ──
  if (schema.type) {
    const expected = Array.isArray(schema.type) ? schema.type : [schema.type];
    const actual = Array.isArray(value)
      ? "array"
      : value === null
        ? "null"
        : typeof value;
    // JSON Schema 的 integer 对应 JS 的 number（整数）
    const actualNorm = expected.includes("integer") && actual === "number" && Number.isInteger(value)
      ? "integer"
      : actual;
    if (!expected.includes(actualNorm)) {
      errors.push(`${path || "(root)"}: 期望类型 ${expected.join("|")}, 实际 ${actualNorm}`);
      return errors; // 类型都不对，后面的检查没意义
    }
  }

  // ── enum 校验 ──
  if (schema.enum !== undefined && !schema.enum.includes(value)) {
    errors.push(`${path}: 值 "${value}" 不在允许范围 [${schema.enum.join(", ")}]`);
  }

  // ── 字符串约束 ──
  if (typeof value === "string") {
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      errors.push(`${path}: 字符串长度 ${value.length} < 最小 ${schema.minLength}`);
    }
    if (schema.maxLength !== undefined && value.length > schema.maxLength) {
      errors.push(`${path}: 字符串长度 ${value.length} > 最大 ${schema.maxLength}`);
    }
    if (schema.pattern) {
      try {
        const re = new RegExp(schema.pattern);
        if (!re.test(value)) {
          errors.push(`${path}: 不匹配模式 ${schema.pattern}`);
        }
      } catch {
        // pattern 无效时跳过
      }
    }
  }

  // ── 数字约束 ──
  if (typeof value === "number") {
    if (schema.minimum !== undefined && value < schema.minimum) {
      errors.push(`${path}: 值 ${value} < 最小 ${schema.minimum}`);
    }
    if (schema.maximum !== undefined && value > schema.maximum) {
      errors.push(`${path}: 值 ${value} > 最大 ${schema.maximum}`);
    }
  }

  // ── 对象校验 ──
  if (schema.type === "object" && typeof value === "object" && value !== null && !Array.isArray(value)) {
    // 必填字段
    if (schema.required) {
      for (const req of schema.required) {
        if (value[req] === undefined || value[req] === null) {
          errors.push(`${path}.${req}: 缺少必填字段`);
        }
      }
    }

    // 递归校验每个属性
    if (schema.properties) {
      for (const [key, propSchema] of Object.entries(schema.properties)) {
        if (value[key] !== undefined) {
          errors.push(...validateValue(value[key], propSchema, `${path}.${key}`));
        }
      }
    }

    // 拒绝额外字段（additionalProperties: false）
    if (schema.additionalProperties === false && schema.properties) {
      const allowed = new Set(Object.keys(schema.properties));
      for (const key of Object.keys(value)) {
        if (!allowed.has(key)) {
          errors.push(`${path}.${key}: 不允许的字段（模型可能注入了额外参数）`);
        }
      }
    }
  }

  // ── 数组校验 ──
  if (schema.type === "array" && Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      errors.push(`${path}: 数组长度 ${value.length} < 最小 ${schema.minItems}`);
    }
    if (schema.maxItems !== undefined && value.length > schema.maxItems) {
      errors.push(`${path}: 数组长度 ${value.length} > 最大 ${schema.maxItems}`);
    }
    if (schema.items) {
      value.forEach((item, i) => {
        errors.push(...validateValue(item, schema.items, `${path}[${i}]`));
      });
    }
  }

  return errors;
}

/**
 * 校验 LLM 生成的工具参数是否符合 MCP 工具的 inputSchema
 *
 * @param args   LLM 生成的参数（JSON.parse 后的对象）
 * @param schema MCP 工具的 inputSchema（JSON Schema 格式）
 * @returns 校验结果
 */
export function validateToolArgs(
  args: Record<string, any>,
  schema: any
): ValidationResult {
  // 没有 schema 就不校验（某些工具可能没有 inputSchema）
  if (!schema || Object.keys(schema).length === 0) {
    return { valid: true, errors: [] };
  }

  const errors = validateValue(args, schema, "");
  return { valid: errors.length === 0, errors };
}

// ════════════════════════════════════════════════════════════
// 第三道防线：密钥脱敏
// ════════════════════════════════════════════════════════════
//
// Agent 运行时，工具参数、返回结果、trace 日志里
// 都可能意外包含 API Key / Token。
//
// 比如：
//   - LLM 在参数里传了完整的 Figma URL（带 token）
//   - 工具返回结果里包含 figd_xxx
//   - 环境变量值被打印到日志
//
// 脱敏策略：保留前 4 + 后 4 字符，中间用 **** 代替
//   sk-abc1234567890xyz -> sk-a****xyz
//

export interface SecretPattern {
  name: string;
  /** 匹配正则 */
  pattern: RegExp;
  /** 脱敏函数 */
  mask: (match: string) => string;
}

export const DEFAULT_SECRET_PATTERNS: SecretPattern[] = [
  // OpenAI API Key
  {
    name: "openai_key",
    pattern: /\bsk-[a-zA-Z0-9]{20,}\b/g,
    mask: (m) => m.slice(0, 6) + "****" + m.slice(-4),
  },
  // Figma Token
  {
    name: "figma_token",
    pattern: /\bfigd_[a-zA-Z0-9]{20,}\b/g,
    mask: (m) => m.slice(0, 8) + "****" + m.slice(-4),
  },
  // AWS Access Key
  {
    name: "aws_key",
    pattern: /\bAKIA[A-Z0-9]{16}\b/g,
    mask: (m) => m.slice(0, 8) + "****",
  },
  // Bearer Token
  {
    name: "bearer_token",
    pattern: /\bBearer\s+[a-zA-Z0-9\-_\.]{20,}\b/g,
    mask: (m) => m.slice(0, 10) + "****",
  },
  // GitHub Token
  {
    name: "github_token",
    pattern: /\bgh[pousr]_[a-zA-Z0-9]{36,}\b/g,
    mask: (m) => m.slice(0, 6) + "****" + m.slice(-4),
  },
  // 通用长 Token（32+ 位十六进制或 base64）
  {
    name: "generic_token",
    pattern: /\b[a-fA-F0-9]{32,}\b/g,
    mask: (m) => m.slice(0, 4) + "****" + m.slice(-4),
  },
  // 环境变量赋值：KEY=value 或 TOKEN=value
  {
    name: "env_assignment",
    pattern: /((?:API_KEY|TOKEN|SECRET|PASSWORD|PASS)\s*=\s*)([^\s"']{8,})/gi,
    mask: (m) => {
      // 保留 KEY= 前缀，脱敏值
      const eq = m.indexOf("=");
      return m.slice(0, eq + 1) + "****";
    },
  },
];

/**
 * 对文本进行密钥脱敏
 *
 * @param text     原始文本
 * @param patterns 脱敏规则（默认全部）
 * @returns 脱敏后的文本
 */
export function maskSecrets(
  text: string,
  patterns: SecretPattern[] = DEFAULT_SECRET_PATTERNS
): string {
  if (!text || typeof text !== "string") return text;

  let result = text;
  for (const p of patterns) {
    // 重置 lastIndex（全局正则复用问题）
    p.pattern.lastIndex = 0;
    result = result.replace(p.pattern, (match) => p.mask(match));
  }
  return result;
}

/**
 * 递归脱敏一个对象/值（用于工具参数、trace 等）
 *
 * @param obj 任意值
 * @returns 脱敏后的深拷贝
 */
export function maskSecretsDeep<T>(obj: T): T {
  if (typeof obj === "string") {
    return maskSecrets(obj) as unknown as T;
  }
  if (Array.isArray(obj)) {
    return obj.map((v) => maskSecretsDeep(v)) as unknown as T;
  }
  if (obj && typeof obj === "object") {
    const result: any = {};
    for (const [k, v] of Object.entries(obj)) {
      // key 本身也可能含密钥（罕见但安全起见）
      result[maskSecrets(k)] = maskSecretsDeep(v);
    }
    return result;
  }
  return obj;
}

// ════════════════════════════════════════════════════════════
// SecurityChecker - 整合三道防线的统一入口
// ════════════════════════════════════════════════════════════

export interface SecurityConfig {
  /** 是否启用注入检测 */
  enableInjectionCheck: boolean;
  /** 是否启用参数校验 */
  enableArgValidation: boolean;
  /** 是否启用密钥脱敏 */
  enableSecretMasking: boolean;
  /** 自定义注入规则 */
  injectionRules?: InjectionRule[];
  /** 自定义脱敏规则 */
  secretPatterns?: SecretPattern[];
}

export class SecurityChecker {
  private config: SecurityConfig;
  /** 检测到的安全事件计数 */
  stats = { injectionsBlocked: 0, argsRejected: 0, secretsMasked: 0 };

  constructor(config: Partial<SecurityConfig> = {}) {
    this.config = {
      enableInjectionCheck: true,
      enableArgValidation: true,
      enableSecretMasking: true,
      ...config,
    };
  }

  /** 第一道：检测 Prompt 注入 */
  checkInjection(text: string): InjectionResult {
    if (!this.config.enableInjectionCheck) {
      return { detected: false, matchedRules: [], risk: "none", shouldBlock: false };
    }
    const result = detectPromptInjection(text, this.config.injectionRules);
    if (result.shouldBlock) this.stats.injectionsBlocked++;
    return result;
  }

  /** 第二道：校验工具参数 */
  checkToolArgs(args: Record<string, any>, schema: any): ValidationResult {
    if (!this.config.enableArgValidation) {
      return { valid: true, errors: [] };
    }
    const result = validateToolArgs(args, schema);
    if (!result.valid) this.stats.argsRejected++;
    return result;
  }

  /** 第三道：脱敏（字符串） */
  mask(text: string): string {
    if (!this.config.enableSecretMasking) return text;
    this.stats.secretsMasked++;
    return maskSecrets(text, this.config.secretPatterns);
  }

  /** 第三道：脱敏（深度对象） */
  maskDeep<T>(obj: T): T {
    if (!this.config.enableSecretMasking) return obj;
    return maskSecretsDeep(obj);
  }

  /** 获取安全统计 */
  getStats() {
    return { ...this.stats };
  }
}
