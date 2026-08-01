---
name: confidence_checker
version: "1.0.0"
category: post_process
description: "检验RAG返回结果是否有充分的事实依据支撑"
triggers:
  trigger_mode: "automatic"
  invoke_condition: "after_any_rag_call"
rag_binding: "none"
max_recursion_depth: 0
token_budget: 300
parameters:
  - name: rag_results
    type: "array[object]"
    required: true
    description: "RAG工具返回的结果列表"
  - name: original_question
    type: string
    required: true
    description: "用户的原始问题"
  - name: check_mode
    type: string
    enum: [strict, normal, relaxed]
    required: false
    default: "normal"
    description: "检验严格程度"
---

# Confidence-Checker — 置信度检验工具

## 职责

在任何 RAG 调用（Fact 或 Perspective）完成后，**自动触发**，检验返回结果是否有充分的事实依据支撑。这是一个**后处理工具**，不由用户输入直接触发。

## 检验维度

| 维度 | 权重 | 说明 |
|------|------|------|
| 来源可靠性 | 25% | 来源文档是否来自可信渠道（期刊/会议/官方报告） |
| 内容匹配度 | 30% | 摘录内容与问题的语义相关程度 |
| 引用完整性 | 20% | 是否有明确的出处定位（文档名+段落） |
| 一致性校验 | 25% | 多个来源之间是否存在矛盾 |

## 输出格式

```json
{
  "check_result": "pass" | "warn" | "fail",
  "overall_confidence": 0.87,
  "dimension_scores": {
    "source_reliability": 0.9,
    "content_relevance": 0.85,
    "citation_completeness": 0.8,
    "cross_source_consistency": 0.92
  },
  "warnings": ["source_reliability_below_threshold"],
  "recommended_action": {
    "action": "annotate_with_uncertainty",
    "detail": "建议在相关论段前添加「该观点的文献支撑较弱」标注",
    "affected_dimensions": ["经济影响维度"],
    "auto_executable": true
  }
}
```

## 判定标准与可执行动作

| 状态 | 条件 | recommended_action | 主Agent行为 |
|------|------|-------------------|------------|
| **pass** | confidence ≥ 0.8 | `{"action": "proceed"}` | 正常输出 |
| **warn** | 0.5 ≤ conf < 0.8 | `annotate_with_uncertainty` / `narrow_claim_scope` | **自动执行**对应动作 |
| **fail** | conf < 0.5 | `reject_or_fallback` | 拒绝回答或触发降级 |

### warn 状态的可执行动作明细

| action 类型 | 触发条件 | 具体指令 | 示例 |
|------------|---------|---------|------|
| `annotate_with_uncertainty` | 单维得分偏低(0.6~0.8) | 在受影响的论段加不确定性标注 | "据现有资料，X的影响约为Y%（注：该数据仅来自单一来源）" |
| `narrow_claim_scope` | 引用不完整 | 收窄断言范围，避免过度陈述 | 将"显著提升"改为"在某些场景下有提升" |
| `highlight_conflict` | 多源矛盾 | 标注矛盾点，呈现多方观点 | "A文献认为X，而B文献认为Y，两者存在分歧" |
| `suggest_more_sources` | 来源单一 | 建议用户补充更多文档 | "目前仅有1篇文献支撑该结论，建议上传更多资料" |

### fail 状态的处理

```json
{
  "check_result": "fail",
  "overall_confidence": 0.35,
  "recommended_action": {
    "action": "reject_or_fallback",
    "detail": "所有维度均低于阈值，且存在多源矛盾",
    "fallback_option": "general_knowledge_with_disclaimer",
    "user_message": "现有资料不足以支撑对该问题的可靠分析。如果你有更多相关文档，可以上传后重新提问。"
  }
}
```

## 与主Agent的集成方式

Confidence-Checker 作为**中间件**嵌入调用链：

```
RAG工具返回结果 → Confidence-Checker.autoCheck(results) →
  pass → 正常传递给主Agent生成回答
  warn → 附加 warning 标签 + recommended_action 传递
  fail → 触发降级/拒绝回答流程
```

主 Agent 在收到 `warn` 结果时，必须在回答末尾追加：
> **依据强度提示**：本回答的部分论点缺乏直接的文献支撑，建议以原始文献为准。
