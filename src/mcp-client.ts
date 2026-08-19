/**
 * MCP Client - MCP Server 连接器
 *
 * 这是你写的 Figma MCP Server 的"客户端"：
 * - 启动 MCP Server 子进程
 * - 通过 stdio 管道通信
 * - 列出可用工具
 * - 调用工具并返回结果
 *
 * 类比前端：这就像 WebSocket 客户端连接 WebSocket 服务端。
 * 只不过这里用的是 stdin/stdout 管道，协议是 JSON-RPC。
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

export interface McpServerConfig {
  command: string;  // 启动命令，如 "npx"
  args: string[];   // 启动参数，如 ["tsx", "../figma-mcp-server/src/index.ts"]
}

export class McpClient {
  private client: Client;
  private transport: StdioClientTransport;

  constructor(config: McpServerConfig) {
    // StdioClientTransport 会 spawn 一个子进程
    // 子进程继承父进程的环境变量（包括 FIGMA_ACCESS_TOKEN）
    this.transport = new StdioClientTransport({
      command: config.command,
      args: config.args,
    });
    this.client = new Client({
      name: "figma-agent",
      version: "1.0.0",
    });
  }

  /** 连接 MCP Server，完成 JSON-RPC 握手 */
  async connect() {
    await this.client.connect(this.transport);
  }

  /** 列出 Server 提供的所有工具 */
  async listTools() {
    const { tools } = await this.client.listTools();
    return tools;
  }

  /** 调用指定工具 */
  async callTool(name: string, args: Record<string, any>): Promise<any> {
    return this.client.callTool({ name, arguments: args });
  }

  /** 断开连接，关闭子进程 */
  async disconnect() {
    await this.client.close();
  }
}
