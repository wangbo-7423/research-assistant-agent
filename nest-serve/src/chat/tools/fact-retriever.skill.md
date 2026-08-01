---
name: fact_retriever
version: "1.0.0"
category: rag_strong
description: "针对事实类问题进行高精度单路检索，强制要求原文出处"
triggers:
  keywords:
    - "是什么"
    - "谁是"
    - "什么时候"
    - "多少"
    - "哪里"
    - "如何定义"
    - "概念"
    - "原理"
    - "公式"
    - "步骤"
  patterns:
    - "(是什么|谁是|何时|多少|哪里)"
    - "(定义|概念|原理|公式)"
    - ".{0,10}(特朗普|RAG|Transformer|BERT)"
rag_binding: "strong"
max_recursion_depth: 0
token_budget: 800
retrieval_config:
  strategy: "single_path_precise"
  top_k: 3
  rerank_threshold: 0.75
  require_source: true
  fallback_on_empty: "general_knowledge"
parameters:
  - name: query
    type: string
    required: true
    description: "经过澄清后的最终检索问题"
  - name: entities
    type: "array[string]"
    required: false
    description: "问题中提取的实体名称列表"
  - name: expected_answer_type
    type: string
    enum: [definition, quantity, time, person, place, method]
    required: false
    description: "期望的答案类型，用于优化检索策略"
fallback_config:
  max_consecutive_fallbacks: 2
  action_on_exhaustion: "reject_and_guide"
  rejection_message: "我在你的知识库中没有找到与这个问题相关的资料。如果你手头有相关文档，可以上传到知识库后再问我，这样我能给你更准确的回答。"
  reset_condition: "on_successful_hit"
---

# Fact-Retriever — 事实溯源工具

## 职责

针对「是什么 / 谁 / 何时 / 多少」等事实类问题，执行**高精度单路检索**。核心原则：**宁可少不可错**，只返回高置信度结果，且每条结果必须附带原文出处。

## 与旧架构的区别

| 维度 | 旧架构（意图识别） | 新架构（Fact-Retriever） |
|------|-------------------|------------------------|
| 检索路数 | 混合检索取 Top5 | 单路精搜 + Rerank |
| 返回数量 | 5 条片段 | Top 3（高阈值过滤后） |
| 出处要求 | 无强制要求 | **必须**附 docTitle + 原文定位 |
| 无命中处理 | 占位符 | 降级为通用知识回答 + 明确标注 |

## 检索流程

```
Query → 实体提取 → Embedding → Milvus 向量搜索(候选20)
                                     ↓
                              Rerank 模型精排
                                     ↓
                              阈值 ≥ 0.75 过滤
                                     ↓
                              取 Top 3 + 附原文出处
                                     ↓
                        Confidence-Checker 校验
                                     ↓
                      返回结构化事实结果
```

## 输出格式

```json
{
  "intent_type": "fact",
  "query": "什么是注意力机制",
  "results": [
    {
      "rank": 1,
      "score": 0.89,
      "source": {
        "doc_id": "xxx",
        "doc_title": "Attention Is All You Need.pdf",
        "excerpt": "注意力机制可以描述为将 query 和 key-value 映射到输出的...",
        "offset_start": 120,
        "offset_end": 280
      },
      "answer_summary": "注意力机制是一种通过计算 query 与 key 的相关性来加权聚合 value 信息的机制",
      "confidence_score": 0.92
    }
  ],
  "has_factual_basis": true,
  "total_candidates": 20,
  "above_threshold": 3
}
```

## Rerank 策略

使用交叉编码器（Cross-Encoder）对向量检索的候选结果做精排：

1. **候选集**：向量搜索取 Top 20
2. **Rerank 模型**：`bge-reranker-v2-m3` 或同级别模型（当前后端以阈值融合分近似，后续接入独立 Rerank 服务）
3. **阈值过滤**：score < 0.75 直接丢弃
4. **上限兜底**：如果过阈值后不足 1 条，降级取 Top 1（并标注低置信度）

## 无命中降级策略

当所有候选 score 均低于阈值时，返回 `has_factual_basis: false`，由主 Agent 标注"未检索到依据"。

## Fallback 熔断规则（硬性执行）

| 会话状态 | 行为 |
|---------|------|
| 第 1 次 fallback | 正常返回通用知识 + 标注 ⚠️ |
| 第 2 次 fallback | 正常返回通用知识 + 标注 ⚠️ + 内部计数器 +1 |
| **第 3 次 fallback** | **❌ 拒绝回答 + 引导上传文档** |
| 中间有任何一次成功命中 | 计数器归零，重新开始 |

- **计数器作用域**：按 `kbId + userId` 维度维护（不同知识库独立计数）
- **持久化位置**：Redis 或内存缓存（TTL = 30min）
- **第 3 次的响应**：直接返回预设文案，不再调用 LLM 生成 fallback 回答
