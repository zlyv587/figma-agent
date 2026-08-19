# 🤖 Figma Agent - 设计稿转代码 Agent

一个完整的 Agent Loop 实现：读取 Figma 设计稿 → 理解设计 → 自动生成前端代码。

## 🏗️ 架构

```
用户指令                            最终结果（代码）
  │                                    ▲
  ▼                                    │
┌─────────────────────────────────────────────┐
│              Agent Loop                       │
│                                              │
│  ┌────────┐  ┌────────┐  ┌────────┐          │
│  │ Think  │→ │  Act   │→ │Observe │→ 循环    │
│  │ LLM推理 │  │调MCP工具│  │看结果  │          │
│  └────────┘  └────┬───┘  └────────┘          │
│                     │                         │
└─────────────────────┼─────────────────────────┘
                      │
                      ▼
              ┌───────────────┐
              │  MCP Client   │
              │  (stdio)      │
              └───────┬───────┘
                      │ spawn 子进程
                      ▼
              ┌───────────────┐
              │ Figma MCP     │
              │ Server        │
              │ (你之前写的)   │
              └───────┬───────┘
                      │ HTTP
                      ▼
              ┌───────────────┐
              │  Figma API    │
              └───────────────┘
```

## 📁 项目结构

```
figma-agent/
├── src/
│   ├── index.ts          # CLI 入口，组装所有组件
│   ├── agent-loop.ts     # ★ 核心循环引擎（Think-Act-Observe）
│   ├── llm-client.ts     # LLM 调用封装（OpenAI 兼容）
│   ├── mcp-client.ts     # MCP Client（连接 Figma MCP Server）
│   ├── skill-loader.ts   # ★ 技能加载器（加载/匹配 SKILL.md）
│   └── prompts.ts        # System Prompt + 技能指令组合
├── skills/               # ★ 技能目录
│   ├── codegen/          # 代码生成技能
│   │   └── SKILL.md
│   ├── design-review/    # 设计审查技能
│   │   └── SKILL.md
│   └── design-tokens/    # 设计Token提取技能
│       └── SKILL.md
├── .env.example
├── package.json
└── tsconfig.json
```

## 📋 前置条件

- Node.js 18+
- **figma-mcp-server** 项目（同级目录下）
- 一个 LLM API Key（OpenAI / DeepSeek / Qwen / Moonshot 任选）
- 一个 Figma Access Token

## 📦 安装

```bash
cd figma-agent
cp .env.example .env
# 编辑 .env 填入你的 API Key
npm install
```

## ⚙️ 配置 .env

```bash
# LLM（必填）- 支持 OpenAI 或任何兼容 API
OPENAI_API_KEY=sk-xxx

# 可选：用国产模型（DeepSeek 示例）
LLM_BASE_URL=https://api.deepseek.com/v1
LLM_MODEL=deepseek-chat

# Figma Token（必填）
FIGMA_ACCESS_TOKEN=figd_xxx

# MCP Server 路径（默认同级目录）
FIGMA_SERVER_PATH=../figma-mcp-server/src/index.ts
```

## 🚀 使用

### 测试 MCP 连接（不需要 LLM Key）

```bash
npx tsx src/index.ts --list-tools
```

### 运行完整 Agent

```bash
npx tsx src/index.ts "读取这个设计稿并生成首页 React 代码: https://www.figma.com/design/abc123/MyApp"
```

你会看到完整的 Think-Act-Observe 循环过程：

```
🧠 [Think] 迭代 1/20 ...
🔧 [Act] 调用: get_figma_file({"file_key":"abc123"})
📊 [Observe] 结果: 📁 文件: MyApp | 📦 组件: 5 个...

🧠 [Think] 迭代 2/20 ...
🔧 [Act] 调用: get_figma_node({"file_key":"abc123","node_id":"1:2"})
📊 [Observe] 结果: [FRAME] "Homepage" 375×812 | flex-col...

🧠 [Think] 迭代 3/20 ...
✅ 任务完成！
   迭代次数: 3
   Token 消耗: 15,234
   工具调用: 2 次
```

## 🧠 Agent Loop 工作原理

每一轮循环：

| 阶段 | 做什么 | 代码位置 |
|------|--------|---------|
| **Think** | 把对话历史 + 工具列表发给 LLM，LLM 决定下一步 | `llm.chat(messages, tools)` |
| **Act** | 如果 LLM 请求调用工具，通过 MCP 执行 | `mcp.callTool(name, args)` |
| **Observe** | 把工具结果加入对话历史，LLM 下一轮能看到 | `messages.push({role:"tool",...})` |
| **终止判断** | LLM 不再请求工具 = 任务完成 | `!toolCalls?.length` |

终止条件（4 重保险）：
1. LLM 主动结束（正常完成）
2. 最大迭代次数（防无限循环）
3. Token 预算耗尽（防成本失控）
4. 超时（防卡死）

## 🧩 技能系统

Agent 支持技能插件，根据用户指令自动匹配技能，注入对应的知识、工作流程和工具范围。

### 技能格式

每个技能是一个目录，包含 `SKILL.md` 文件（YAML frontmatter + Markdown 指令）：

```markdown
---
name: codegen
description: 从 Figma 设计稿生成前端代码
triggers:
  - 生成代码
  - 写代码
tools:
  - get_figma_file
  - get_figma_node
priority: 1
---

## 工作流程
1. 读取设计稿结构
2. 生成代码

## 代码规范
- 使用 React + TypeScript + Tailwind CSS
```

### 内置技能

| 技能 | 触发词示例 | 工具范围 |
|------|-----------|---------|
| codegen | 生成代码, 写代码, 还原设计 | file, node, styles |
| design-review | 审查设计, 检查设计, review | + components |
| design-tokens | 设计 token, CSS 变量, tailwind 配置 | file, styles, components |

### 匹配原理

- **英文触发词**：简单子串匹配
- **中文触发词**：拆成2字块，所有块都出现在查询中即匹配
  - 例如 "生成代码" -> ["生成", "代码"]
  - "帮我生成首页代码" 同时包含两者 -> 匹配 ✓

### 查看技能

```bash
npx tsx src/index.ts --list-skills   # 查看已加载技能 + 匹配测试
npx tsx src/index.ts --list-tools   # 查看 MCP 工具
```

### 自定义技能

在 `skills/` 下创建新目录，添加 `SKILL.md` 即可，无需改代码。

```bash
mkdir skills/my-skill
# 编辑 skills/my-skill/SKILL.md
```

## 🔧 支持的 LLM

| 服务 | baseURL | model |
|------|---------|-------|
| OpenAI | （默认） | gpt-4o |
| DeepSeek | https://api.deepseek.com/v1 | deepseek-chat |
| 通义千问 | https://dashscope.aliyuncs.com/compatible-mode/v1 | qwen-plus |
| Moonshot | https://api.moonshot.cn/v1 | moonshot-v1-8k |
| 本地 Ollama | http://localhost:11434/v1 | llama3 |
