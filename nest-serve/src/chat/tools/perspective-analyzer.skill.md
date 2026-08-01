---
name: perspective_analyzer
version: "1.0.0"
category: rag_loose
description: "针对评价类问题拆解多维度，并行调用RAG多路召回，流式聚合"
triggers:
  keywords:
    - "怎么看"
    - "你认为"
    - "意味着"
    - "评价"
    - "优缺点"
    - "影响"
    - "意义"
    - "趋势"
    - "对比"
    - "分析"
  patterns:
    - "(你怎么看|你认为|你觉得).{0,20}"
    - "(意味着|代表|说明).{0,30}"
    - "(评价|分析|看法|观点)"
    - "(优缺点|优劣|利弊)"
rag_binding: "loose"
max_recursion_depth: 1
token_budget: 2000
dimension_config:
  min_dimensions: 2
  max_dimensions: 4
  parallel_execution: true
  streaming_aggregation: true
  sub_agent_timeout_ms: 8000
  token_budget_per_dimension: 400
  summarization_action: "condense"
parameters:
  - name: question
    type: string
    required: true
    description: "用户的原始评价类问题"
  - name: dimensions
    type: "array[object]"
    required: false
    description: "预拆解的评价维度（若不提供则由主Agent动态拆解）"
  - name: context_entities
    type: "array[string]"
    required: false
    description: "问题涉及的实体（用于Fact-Retriever补充检索）"
---

# Perspective-Analyzer — 多维评价分析工具

## 职责

针对「你怎么看 / 意味着什么 / 评价」等评价类问题，**将问题拆解为多个评价维度**，每个维度独立发起 RAG 检索（子Agent），采用**流式管道模式**边召回边生成，避免上下文窗口溢出。

## 核心创新：解决「无限递归」问题

传统方案把维度结果全量返回主 Agent → 上下文溢出或遗忘原始维度。本方案用**流式管道模式**：并行启动子 Agent（每个 8s 超时），先到的先整合，每个子 Agent 最多返回 Top3。

## 关键设计约束

| 约束 | 值 | 原因 |
|------|-----|------|
| 每维最大返回数 | 3 | 控制总量 ≤ 维度数 × 3 |
| 子Agent超时 | 8s | 防止某维度阻塞整体响应 |
| 主Agent等待模式 | 不等待全量 | 先到的先整合输出 |
| **单维Token预算** | **400 tokens** | **单维度返回内容超限时强制摘要浓缩** |

## 单维 Token 预算与摘要浓缩（硬性执行）

- **Token 计算方式**：服务端粗估 `Math.ceil(content.length / 3)`
- **浓缩用轻量模型**：调用快速模型，不消耗主模型配额
- **浓缩必须保留**：核心论点/结论、关键数据/数字、来源文档标题、正反两方观点
- **浓缩可以丢弃**：冗余的过渡句、重复论证、过长的原文逐字引用

## 维度拆解规则

主 Agent 在路由阶段即完成维度拆解（轻量操作，不查库）：

```
用户问题: "{question}"

请将该评价类问题拆解为 2~4 个独立的评价维度。每个维度应：
1. 角度互不重叠
2. 每个维度都能转化为一个具体的事实检索问题
3. 适合从学术/科研文档中找到支撑材料

输出JSON数组:
[
  {"name": "维度名", "query": "该维度对应的检索问题", "weight": 0~1}
]
```

### 常见评价类问题的维度模板

| 问题类型 | 推荐维度 |
|---------|---------|
| 怎看某个政策 | 经济影响、社会效应、技术可行性、国际比较 |
| 怎看某个方法 | 原理创新、实验效果、局限性、应用场景 |
| 怎看某个现象 | 成因分析、发展趋势、应对策略、典型案例 |
| A vs B 对比 | 性能对比、成本对比、适用场景、生态成熟度 |

## 输出格式

```json
{
  "intent_type": "perspective",
  "question": "你怎么看RAG检索增强生成?",
  "dimensions": [
    {
      "name": "技术优势",
      "status": "completed",
      "key_points": ["减轻大模型幻觉问题", "支持知识实时更新", "答案可溯源"],
      "sources": [{ "doc_title": "RAG综述.pdf", "excerpt": "..." }],
      "confidence": 0.88
    },
    {
      "name": "未来方向",
      "status": "timeout",
      "key_points": [],
      "sources": [],
      "confidence": 0,
      "note": "该维度检索超时，基于模型通用知识补充"
    }
  ],
  "overall_assessment": "RAG作为检索增强生成范式...",
  "has_factual_basis": true
}
```

## 二义性问题的特殊处理：内部 hybrid 组合策略

hybrid 不是用户可见的"第四态路由结果"，而是**服务端内部的组合优化策略**。当用户问题同时命中 fact + perspective 触发词时：

1. **Fact 先行**（非并行），检索结果作为「事实基线」
2. Fact 结果注入各子 Agent 的 system prompt，避免重复查已知事实
3. 输出分区：最终回答分为「📌 事实确认」+「🔍 多维评价」
4. Token 预算：Fact 30% : Perspective 70%

用户只看到三种分类：clarify / fact / perspective。hybrid 对用户完全透明。
