/**
 * Vector Store - 向量存储与相似度搜索
 *
 * 存储 embedding 向量，支持余弦相似度检索。
 *
 * 类比前端：像 IndexedDB，但存的是数学向量而非字符串。
 * 生产环境可替换为：Pinecone / Qdrant / Chroma / pgvector
 */

export interface VectorItem {
  id: string;
  embedding: number[];
  metadata: any;
}

export interface SearchResult {
  id: string;
  score: number;
  metadata: any;
}

export class VectorStore {
  private items: VectorItem[] = [];

  /** 添加一个向量 */
  add(id: string, embedding: number[], metadata: any) {
    this.items.push({ id, embedding, metadata });
  }

  /**
   * 余弦相似度搜索
   * 返回与查询向量最相似的 top-K 个结果
   */
  search(queryEmbedding: number[], topK: number = 5): SearchResult[] {
    const results = this.items.map((item) => ({
      id: item.id,
      score: this.cosineSimilarity(queryEmbedding, item.embedding),
      metadata: item.metadata,
    }));
    results.sort((a, b) => b.score - a.score); // 降序
    return results.slice(0, topK);
  }

  /**
   * 余弦相似度 = (a·b) / (|a| × |b|)
   * 衡量两个向量的方向相似度，值域 [-1, 1]，越接近 1 越相似
   */
  private cosineSimilarity(a: number[], b: number[]): number {
    let dot = 0, normA = 0, normB = 0;
    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }
    const denom = Math.sqrt(normA) * Math.sqrt(normB);
    return denom === 0 ? 0 : dot / denom;
  }

  get size() {
    return this.items.length;
  }
}
