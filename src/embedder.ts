/**
 * Embedder - 文本向量化
 *
 * 把文本转成数学向量，让计算机能算"语义相似度"。
 *
 * 两种实现：
 * 1. TfidfEmbedder: 基于 TF-IDF，纯本地计算，不需要 API
 *    - 适合 Demo / 无 API 场景
 *    - 中文用 2字 n-gram 分词
 * 2. OpenAIEmbedder: 调用 Embedding API，语义理解强
 *    - 需要 API Key
 *    - 生产环境推荐
 *
 * 类比前端：
 * - TF-IDF 像 CSS 的 grep 搜索（字面匹配）
 * - Embedding API 像语义搜索（理解意思）
 */

import OpenAI from "openai";

// ─────────────────────────────────────
// 接口
// ─────────────────────────────────────

export interface Embedder {
  embed(text: string): Promise<number[]>;
}

// ─────────────────────────────────────
// TF-IDF Embedder（无需 API）
// ─────────────────────────────────────

export class TfidfEmbedder implements Embedder {
  private vocabulary = new Map<string, number>();
  private idf = new Map<string, number>();
  private fitted = false;

  /**
   * 分词策略：
   * - 英文：按空格/标点分词
   * - 中文：2字 n-gram（"生成代码" -> "生成", "成代", "代码"）
   */
  private tokenize(text: string): string[] {
    const tokens: string[] = [];
    const segments = text.toLowerCase().split(/[\s,，。、；：!！?？()（）"'""''\-–·/]+/);
    for (const seg of segments) {
      if (!seg) continue;
      if (/^[a-z]+$/i.test(seg) && seg.length >= 2) {
        tokens.push(seg);
      } else {
        for (let i = 0; i < seg.length - 1; i++) {
          tokens.push(seg.substring(i, i + 2));
        }
        if (seg.length === 1) tokens.push(seg);
      }
    }
    return tokens;
  }

  /** 训练：用技能描述构建词汇表和 IDF 权重 */
  fit(documents: string[]): this {
    const df = new Map<string, number>(); // document frequency
    for (const doc of documents) {
      const tokens = new Set(this.tokenize(doc));
      for (const token of tokens) {
        df.set(token, (df.get(token) || 0) + 1);
      }
    }
    const N = documents.length;
    this.idf.clear();
    this.vocabulary.clear();
    let idx = 0;
    for (const [token, freq] of df) {
      // IDF = log(文档总数 / 含该词的文档数)
      this.idf.set(token, Math.log((N + 1) / (freq + 1)) + 1);
      this.vocabulary.set(token, idx++);
    }
    this.fitted = true;
    return this;
  }

  /** 向量化：TF-IDF + L2 归一化 */
  async embed(text: string): Promise<number[]> {
    if (!this.fitted) throw new Error("TfidfEmbedder 未训练，请先调用 fit()");
    const tokens = this.tokenize(text);
    const tf = new Map<string, number>();
    for (const token of tokens) {
      tf.set(token, (tf.get(token) || 0) + 1);
    }
    const vector = new Array(this.vocabulary.size).fill(0);
    for (const [token, freq] of tf) {
      const idx = this.vocabulary.get(token);
      if (idx !== undefined) {
        const idfVal = this.idf.get(token) || 1;
        vector[idx] = (freq / tokens.length) * idfVal;
      }
    }
    // L2 归一化后，cosine similarity = 点积
    const norm = Math.sqrt(vector.reduce((s, v) => s + v * v, 0));
    if (norm > 0) {
      for (let i = 0; i < vector.length; i++) vector[i] /= norm;
    }
    return vector;
  }

  get vocabSize() {
    return this.vocabulary.size;
  }
}

// ─────────────────────────────────────
// OpenAI Embedder（需要 API Key）
// ─────────────────────────────────────

export class OpenAIEmbedder implements Embedder {
  private client: OpenAI;
  private model: string;

  constructor(config: { apiKey: string; baseURL?: string; model?: string }) {
    this.client = new OpenAI({ apiKey: config.apiKey, baseURL: config.baseURL });
    this.model = config.model || "text-embedding-3-small";
  }

  async embed(text: string): Promise<number[]> {
    const response = await this.client.embeddings.create({
      model: this.model,
      input: text,
    });
    return response.data[0].embedding;
  }
}
