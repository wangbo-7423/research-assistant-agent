# 四工具 RAG 架构重构设计方案

> 基于截图思路 + Anthropic Skill 模型，解决递归风险、二义性路由、工具定义格式三大痛点

---

## 一、架构总览

```
用户输入
    ↓
┌───────────────────────────────────────────┐
│   Main Agent（轻量意图路由器）              │
│   分类：clarify / fact / perspective      │
│   （hybrid 为内部组合策略，用户不可见）     │
└──────┬──────────┬───────────┬────────────┘
       │          │           │
       ▼          ▼           ▼
  ┌─────────┐ ┌─────────┐ ┌──────────────┐
  │ Clarify │ │  Fact   │ │ Perspective  │
  │ (无RAG) │ │(强绑定)  │ │ (松耦合)     │
  └────┬────┘ └────┬────┘ └──────┬───────┘
       │          │    ┌──────────┴───┐
       │          │    │  hybrid 组合   │ ← 内部优化：
       │          │    │ Fact+Perspective│ 并行执行
       │          │    └──────┬────────┘ 用户无感知
       │           │              │ 多路并行
       │           ▼              ▼
       │    ┌──────────┐   ┌────────────┐
       │    │Confidence│   │ 子Agent流式 │
       │    │ Checker  │   │ RAG召回     │
       │    └────┬─────┘   └──────┬─────┘
       │         │                │
       └─────────┴────────────────┘
                         ↓
              主Agent整合输出（带引用标记）
```

---

## 二、四大工具定义（Anthropic Skill 模型）

### 格式规范

每个工具采用 **YAML 头信息 + Markdown 正文** 的渐进式披露结构：

```yaml
---
name: 工具名
version: "1.0"
category: intent_router | rag_strong | rag_loose | post_process
triggers:
  keywords: [...]
  patterns: [...]
  input_length_threshold: number | null
rag_binding: "none" | "strong" | "loose"
max_recursion_depth: 0 | 1
token_budget: number
parameters:
  - name: string
    type: string
    required: boolean
    description: string
---
# Markdown 正文：Prompt 指令 + 示例
```

---

### Tool 1: Clarify（模糊澄清）

**文件**: `src/chat/tools/clarify.skill.md`

```yaml
---
name: clarify
version: "1.0.0"
category: intent_router
description: "识别用户模糊/续问指令，基于上下文生成自然语言反问，引导用户明确意图"
triggers:
  keywords:
    - "然后呢"
    - "咋整"
    - "所以呢"
    - "接下来"
    - "还有吗"
    - "再说点"
    - "怎么办"
    - "这该怎么办"
    - "啊"
    - "嗯"
    - "哦"
  patterns:
    - "^.{0,5}$"                    # 输入 ≤ 5 字
    - "^(然后|所以|那|接着|再).{0,4}$" # 典型续问前缀+短尾
    - "(咋整|怎么办|怎么搞)"          # 口语化求助
  input_length_threshold: 5          # 字数 ≤ 5 时强制触发
  rag_binding: "none"               # 不走 RAG
  max_recursion_depth: 0             # 不触发子Agent
  token_budget: 200                 # 轻量级，控制 token
parameters:
  - name: user_input
    type: string
    required: true
    description: "用户的原始输入"
  - name: conversation_context
    type: string
    required: false
    description: "最近3轮对话摘要（由调用方注入）"
---

# Clarify — 模糊意图澄清工具

## 职责

当用户输入模糊、过短、或明显是续问/追问时，**不查询知识库**，
仅基于对话上下文分析用户可能想问的问题，以**自然语言反问文本**的形式直接返回给前端展示。
像真人助手那样问用户："你是在问 A 吗？还是想了解 B？"

**核心原则：这是对话，不是选择题。**

## 触发条件（满足任一即触发）

1. 用户输入 ≤ 5 个字符
2. 输入包含典型模糊词：然后呢、咋整、所以呢、接下来、还有吗、再说点...
3. 纯语气词：啊、嗯、哦、哈

## ⚠️ 隐忧防护：候选项必须从上下文实体派生（硬性约束）

> **问题**：如果生成的候选项语义不精确，用户顺着回答后发现检索不到内容，
> 信任度会崩塌。更严重的是，模型可能凭空引入上下文中从未出现过的新实体。

**硬性约束（必须在 Prompt 中强制执行）**：

> 生成的候选项必须能从前序对话的「隐含实体」中派生，**不得凭空引入新实体**。
>
> 示例：
> - 上文讨论 "Transformer" → 候选项只能是 "Transformer 的变体"、"Transformer 的训练"、
>   "Transformer vs 其他架构"，**不能突然变成 "CNN"、"LSTM" 等未提及的实体**
> - 上文讨论 "RAG 检索" → 候选项只能是 RAG 相关的延伸（重排序、召回率评估等），
>   **不能跳到 "微调"、"提示工程" 等无关话题**

### 实体派生规则

1. **提取隐含实体池**：从前 2~3 轮对话中提取所有已出现的学术概念、方法名、模型名、数据集名
2. **候选项 = 实体 + 关系/属性/操作**：每个猜测必须是「已知实体 + 已知实体的某个方面」
3. **禁止跨域跳跃**：不能从讨论 A 突然跳到 B（除非 B 在上下文中被明确对比过）
4. **禁止泛化过度**：不能把具体方法泛化为完全不相关的大领域

## 输出格式

Clarify 工具直接返回**自然语言文本**（非结构化 JSON），作为助手的回复内容流式推送给前端：

```
你是在问 Transformer 自注意力机制的具体实现细节吗？
还是想了解它和普通注意力机制的区别？
或者你想知道如何在代码中实现自注意力？
```

内部同时携带结构化元数据（供日志/分析使用，不暴露给前端用户）：

```json
{
  "intent_type": "clarify",
  "display_text": "你是在问 Transformer 自注意力机制的具体实现细节吗？还是想了解它和普通注意力机制的区别？或者你想知道如何在代码中实现自注意力？",
  "inferred_intents": [
    {
      "text": "Transformer 自注意力机制的具体实现细节",
      "source_entity": "自注意力机制",
      "relation": "实现细节",
      "confidence": 0.85,
      "entity_from_context": true
    },
    {
      "text": "它和普通注意力机制的区别",
      "source_entity": ["自注意力机制", "注意力机制"],
      "relation": "对比",
      "confidence": 0.72,
      "entity_from_context": true
    },
    {
      "text": "如何在代码中实现自注意力",
      "source_entity": "自注意力机制",
      "relation": "代码实现",
      "confidence": 0.58,
      "entity_from_context": true
    }
  ],
  "entity_pool": ["Transformer", "自注意力机制", "注意力机制"]
}
```

## 生成规则

1. **自然语言优先**：输出必须是连贯的自然语言反问，像真人助手在确认需求
2. **必须结合上下文**：不能凭空生成，必须参考最近 2~3 轮对话主题
3. **🔒 实体封闭性**（硬性约束）：所有候选项的实体必须来自上下文实体池，严禁引入新实体
4. **表述口语化**：不要像学术目录，要像人在说话
5. **去重**：与最近已问过的问题不能重复
6. **数量控制**：2~3 个猜测，用"是...还是...或者..."的句式串联
7. **置信度排序**：最可能的猜测放在最前面

## 反面示例（违反实体封闭性约束）

| 上下文 | 用户输入 | ❌ 错误生成 | ✅ 正确生成 |
|--------|---------|------------|------------|
| 讨论 Transformer 架构 | "还有吗" | "要不要了解一下 CNN？"（❌ 引入新实体CNN） | "Transformer 的 Encoder 和 Decoder 还有什么细节？" |
| 讨论 RAG 混合检索 | "然后呢" | "微调怎么做？"（❌ 跨域到微调） | "RAG 的重排序策略还有哪些？" |
| 讨论某篇论文的方法 | "咋整" | "BERT 怎么用？"（❌ 跳到BERT） | "这个方法的实验复现步骤是什么？" |

## 正面示例

| 上下文 | 用户输��� | 生成结果（自然语言反问） |
|--------|---------|----------------------|
| 讨论 RAG 检索原理 | "然后呢" | "你是想了解 RAG 检索后的重排序怎么做？还是想知道召回率怎么评估？或者是混合检索里向量检索和关键词检索的权重怎么调？" |
| 讨论论文中的方法 | "咋整啊" | "你是想问这个方法的具体实现步骤？还是需要什么数据集？或者代码在哪里能找到？" |
| 首轮对话（无上下文） | "嗯" | "你好！你可以告诉我你想了解什么研究方向吗？比如检索某篇论文、解读一个文档、或者询问某个学术概念？" |

## 前端交互协议

Clarify 的输出就是一条普通的 `type: "answer"` 消息，**不需要特殊的事件类型**。
前端正常渲染为助手回复文本即可——因为它本质上就是助手在反问用户。

```json
{
  "type": "answer",
  "content": "你是在问 Transformer 自注意力机制的具体实现细节吗？还是想了解它和普通注意力机制的区别？"
}
```

用户看到这条消息后，直接用自然语言回复自己真正想问的内容即可（就像在微信里跟朋友聊天一样）。

---

### ⚠️ 隐忧防护：pendingConfirmation 防死循环机制

> **问题场景（这是本方案最大的 UX 漏洞）**：
> 用户说"是"或"对的"来回应 Clarify 的反问，
> 但这类短输入**再次命中了 Clarify 的触发条件**（≤5字 / 包含确认词），
> 导致系统再次生成反问 → 用户再次说"是" → **无限循环**。
>
> **如果不加这个机制，用户体验会完全崩塌。**

#### 解决方案：会话状态机 + pendingConfirmation 标记

**核心思路**：当 Clarify 被触发后，在会话状态中设置一个 **pendingConfirmation** 标记，
标记后续的 N 轮输入进入「确认解析模式」，不再重新触发 Clarify。

##### 状态流转图

```
                    ┌─────────────────┐
                    │   normal 状态     │ ← 默认状态
                    │  正常意图路由      │
                    └────────┬────────┘
                             │ 用户输入命中 Clarify 触发条件
                             ▼
                    ┌─────────────────┐
              ┌────→│ pendingConfirm   │ ← 进入「等待确认」状态
              │     │ (TTL: 3轮或60s)  │
              │     └────────┬────────┘
              │              │
              │    ┌─────────┼─────────┐
              │    ▼         ▼         ▼
              │  [自然语言   ["是/对/好"  [模糊词但非
              │   具体问题]   等确认词]    确认语境]
              │    │         │         │
              │    ▼         ▼         ▼
              │  退出pending  映射到最  降级为
              │  → normal    可能的意图  normal处理
              │             → 执行     (不触发clarify)
              │
              └──── TTL超时 → 自动退出到 normal
```

##### 实现细节

**1. 会话状态扩展**

```typescript
interface ConversationState {
  // ... 现有字段
  
  // 🆕 Clarify 防死循环
  clarifyState?: {
    mode: 'pending_confirmation' | null
    setAt: number              // 设置时间戳
    clarificationId: string    // 对应的澄清消息ID
    inferredIntents: Array<{   // 上次澄清生成的候选项
      text: string
      confidence: number
    }>
    maxTurns: 3               // 最多等待 3 轮
    currentTurn: number        // 当前第几轮
  }
}
```

**2. IntentRouter 中增加前置检查**

```typescript
async function classifyIntent(
  userInput: string,
  conversationContext?: string,
  state?: ConversationState
): Promise<IntentRouteResult> {
  
  // 🆕 前置检查：如果处于 pendingConfirmation 状态
  if (state?.clarifyState?.mode === 'pending_confirmation') {
    return this.handlePendingConfirmation(userInput, state.clarifyState)
  }
  
  // 正常的三态分类逻辑...
}
```

**3. pendingConfirmation 状态下的输入解析逻辑**

```typescript
private handlePendingConfirmation(
  userInput: string,
  clarifyState: ClarifyState
): IntentRouteResult {
  
  const input = userInput.trim()
  
  // Case 1: 用户给出了具体问题（长度 > 10 或包含疑问词）
  if (input.length > 10 || /[?？]|什么|怎么|为什么|如何/.test(input)) {
    return { intent: this.reclassify(input), exitPending: true }
  }
  
  // Case 2: 用户说"是/对/好的/没错"等纯确认词
  if (/^(是|对|好的|没错|嗯|ok|OK|yes)$/.test(input)) {
    const topIntent = clarifyState.inferredIntents[0]
    return {
      intent: 'fact',
      resolvedQuery: topIntent.text,
      exitPending: true,
      reasoning: '用户确认，映射到最高置信度候选项'
    }
  }
  
  // Case 3: 用户说"不是/不对/另一个"等否定词
  if (/^(不是|不对|另一个|或者|第.*个)$/.test(input)) {
    const secondIntent = clarifyState.inferredIntents[1]
    if (secondIntent) {
      return {
        intent: 'fact',
        resolvedQuery: secondIntent.text,
        exitPending: true,
        reasoning: '用户否定第一选项，映射到第二候选项'
      }
    }
    return { intent: 'clarify_force_exit', exitPending: true }
  }
  
  // Case 4: 其他短输入 — 降级为 normal 处理，不再触发 clarify
  return { intent: this.reclassify(input), exitPending: true }
}
```

**4. TTL 自动退出**

```typescript
if (state?.clarifyState?.mode === 'pending_confirmation') {
  const elapsed = Date.now() - state.clarifyState.setAt
  if (elapsed > 60_000 || state.clarifyState.currentTurn >= 3) {
    state.clarifyState.mode = null
  } else {
    state.clarifyState.currentTurn++
  }
}
```

**5. 前端无需改动**

整个防死循环机制是**服务端状态机**，前端完全无感知。
前端只需要正常渲染消息、正常发送用户输入即可。
```

---

### Tool 2: Fact-Retriever（事实溯源）

**文件**: `src/chat/tools/fact-retriever.skill.md`

```yaml
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
    - ".{0,10}(特朗普|RAG|Transformer|BERT)"  # 含明确实体名
  rag_binding: "strong"               # 强绑定 RAG
  max_recursion_depth: 0              # 单路，不拆维度
  token_budget: 800
  retrieval_config:
    strategy: "single_path_precise"
    top_k: 3                          # 只取 Top 3
    rerank_threshold: 0.75            # 高阈值过滤
    require_source: true              # 必须附原文出处
    fallback_on_empty: "general_knowledge"  # 无命中时降级
parameters:
  - name: query
    type: string
    required: true
    description: "经过澄清后的最终检索问题"
  - name: entities
    type: array[string]
    required: false
    description: "问题中提取的实体名称列表"
  - name: expected_answer_type
    type: string
    enum: [definition, quantity, time, person, place, method]
    required: false
    description: "期望的答案类型，用于优化检索策略"
---

# Fact-Retriever — 事实溯源工具

## 职责

针对「是什么 / 谁 / 何时 / 多少」等事实类问题，执行**高精度单路检索**。
核心原则：**宁可少不可错**，只返回高置信度结果，且每条结果必须附带原文出处。

## 与旧架构的区别

| 维度 | 旧架构（意图识别） | 新架构（Fact-Retriever） |
|------|-------------------|------------------------|
| 检索路数 | 混合检索取 Top5 | 单路精搜 + Rerank |
| 返回数量 | 5 条片段 | Top 3（高阈值过滤后） |
| 出处要求 | 无强制要求 | **必须**附 docTitle + 原文定位 |
| 无命中处理 | 占位符 &没有检索到& | 降级为通用知识回答 + 明确标注 |
| Token 消耗 | 全量注入上下文 | 截断控制 + 摘要优先 |

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
  "after_rerank": 8,
  "above_threshold": 3
}
```

## Rerank 策略

使用交叉编码器（Cross-Encoder）对向量检索的候选结果做精排：

1. **候选集**：向量搜索取 Top 20
2. **Rerank 模型**：`qwen3-vl-rerank` 或同级别模型
3. **阈值过滤**：score < 0.75 直接丢弃
4. **上限兜底**：如果过阈值后不足 1 条，降级取 Rerank Top 1（并标注低置信度）

## 无命中降级策略

当所有候选 score 均低于阈值时：

```json
{
  "intent_type": "fact",
  "results": [],
  "has_factual_basis": false,
  "fallback_response": {
    "strategy": "general_knowledge",
    "disclaimer": "以下内容基于通用知识库，未从你的个人知识库中检索到直接依据",
    "answer": "根据通用学术知识..."
  }
}
```

主 Agent 收到 `has_factual_basis: false` 后，在回复开头必须标注：
> ⚠️ 未在你的知识库中检索到直接依据，以下基于通用知识回答

---

### ⚠️ 隐忧防护：连续降级「污染」上下文

> **问题场景**：你设计了 `has_factual_basis: false` 时降级为通用知识，
> 并让主 Agent 标注"未检索到依据"。但如果用户**连续问 3 个库内没有的事实问题**，
> Fact-Retriever 会连续返回 3 次 fallback 通用知识。
>
> **后果**：主 Agent 的上下文会被大量"负样本"占据，
> 导致后续真正命中时模型反而犹豫不决（被之前的失败记录干扰判断）。

#### 解决方案：连续 Fallback 熔断机制

在 `fact-retriever.skill.md` 的 YAML 头和 Markdown 正文中同时增加熔断规则：

**YAML 头新增字段**：

```yaml
fallback_config:
  max_consecutive_fallbacks: 2        # 连续最多允许 2 次 fallback
  action_on_exhaustion: "reject_and_guide" # 第 3 次直接拒绝
  rejection_message: >
    我在你的知识库中没有找到与这个问题相关的资料。
    如果你手头有相关文档，可以上传到知识库后再问我，
    这样我能给你更准确的回答。
  reset_condition: "on_successful_hit"   # 任何一次成功命中后重置计数器
```

**Markdown 正文新增规则**：

```markdown
## Fallback 熔断规则（硬性执行）

### 计数器逻辑

| 会话状态 | 行为 |
|---------|------|
| 第 1 次 fallback | 正常返回通用知识 + 标注 ⚠️ |
| 第 2 次 fallback | 正常返回通用知识 + 标注 ⚠️ + 内部计数器 +1 |
| **第 3 次 fallback** | **❌ 拒绝回答 + 引导上传文档** |
| 中间有任何一次成功命中 | 计数器归零，重新开始 |

### 实现要点

1. **计数器作用域**：按 `kbId + userId` 维度维护（不同知识库独立计数）
2. **持久化位置**：Redis 或内存缓存（TTL = 30min，避免长期影响）
3. **第 3 次的响应格式**：

```json
{
  "intent_type": "fact",
  "results": [],
  "has_factual_basis": false,
  "consecutive_fallback_count": 3,
  "action": "rejected",
  "message": "我在你的知识库中没有找到与「{query}」相关的资料。如果你手头有相关文档，可以上传到知识库后再问我，这样我能给你更准确的回答。",
  "suggestion": "upload_document"
}
```

4. **不消耗 Token 生成通用知识**：第 3 次直接返回预设文案，不再调用 LLM 生成 fallback 回答
```

#### 为什么这个设计有效

| 对比项 | 无熔断（旧方案） | 有熔断（新方案） |
|--------|-----------------|-----------------|
| 连续3次未命中时的Token消耗 | 3次 LLM 调用（生成通用知识） | 0次 LLM 调用（返回预设文案） |
| 上下文污染程度 | 3段"负样本"填满上下文 | 0段负样本（直接拒绝） |
| 用户体验 | 看到3次"未检索到依据"，信任感持续下降 | 第3次明确告知原因并引导行动 |
| 后续回答质量 | 被"负样本"干扰，模型犹豫 | 上下文干净，命中时正常输出 |
```

---

### Tool 3: Perspective-Analyzer（多维评价）

**文件**: `src/chat/tools/perspective-analyzer.skill.md`

```yaml
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
  rag_binding: "loose"                 # 松耦合 RAG
  max_recursion_depth: 1              # 允许拆维度调用子Agent
  token_budget: 2000                  # 评价类问题 token 预算较高
  dimension_config:
    min_dimensions: 2
    max_dimensions: 4                 # 最多拆 4 个维度
    parallel_execution: true          # 并行执行子Agent
    streaming_aggregation: true       # 流式聚合（防递归溢出）
    sub_agent_timeout_ms: 8000        # 单个子Agent超时
parameters:
  - name: question
    type: string
    required: true
    description: "用户的原始评价类问题"
  - name: dimensions
    type: array[object]
    required: false
    description: "预拆解的评价维度（若不提供则由主Agent动态拆解）"
  - name: context_entities
    type: array[string]
    required: false
    description: "问题涉及的实体（用于Fact-Retriever补充检索）"
---

# Perspective-Analyzer — 多维评价分析工具

## 职责

针对「你怎么看 / 意味着什么 / 评价」等评价类问题，
**将问题拆解为多个评价维度**，每个维度独立发起 RAG 检索（子Agent），
采用**流式管道模式**边召回边生成，避免上下文窗口溢出。

## 核心创新：解决「无限递归」问题

### 传统方案的致命缺陷

```
用户问: "你怎么看特朗普的关税政策?"
    ↓
主Agent拆维度: [经济影响, 政治后果, 国际关系] (3个)
    ↓
子Agent1召回 → 15篇文档
子Agent2召回 → 12篇文档
子Agent3召回 → 18篇文档
    ↓
全量返回给主Agent → 45篇文档 + 原始问题 + 维度定义
    ↓
💥 上下文溢出 或 主Agent「遗忘」原始维度
```

### 本方案的解决：流式管道模式

```
用户问: "你怎么看特朗普的关税政策?"
    ↓
主Agent拆维度: [经济影响, 政治后果, 国际关系]
    ↓
┌─────────────────────────────────────────────────┐
│  并行启动3个子Agent（每个有独立8s超时）            │
│                                                   │
│  子Agent1[经济影响] ──→ 召回Top3 ──→ 流式推送 ──┐│
│  子Agent2[政治后果] ──→ 召回Top3 ──→ 流式推送 ──┤│→ 主Agent边收边整合
│  子Agent3[国际关系] ──→ 召回Top3 ──→ 流式推送 ──┘│
│                                                   │
│  ⏱️ 任一子Agent超时 → 标记该维度「数据不足」       │
│  📊 每个子Agent最多返回 Top3（硬限制）              │
└─────────────────────────────────────────────────┘
    ↓
主Agent输出：结构化多维评价（带引用标记）
```

### 关键设计约束

| 约束 | 值 | 原因 |
|------|-----|------|
| 每维最大返回数 | 3 | 控制总量 ≤ 维度数 × 3 |
| 子Agent超时 | 8s | 防止某维度阻塞整体响应 |
| 主Agent等待模式 | 不等待全量 | 先到的先整合输出 |
| 总Token上限 | 动态计算 | 根据模型上下文窗口动态调整 |
| **单维Token预算** | **400 tokens** | **单维度返回内容超限时强制摘要浓缩** |

---

### ⚠️ 隐忧防护：维度拆解「不可控」导致 Token 爆炸

> **问题场景**：你让主 Agent 在路由阶段拆解维度，
> 但评价类问题的**主观性很强**（比如"怎么看俄乌冲突"）。
> 如果拆出 4 个维度，每个子Agent并行召回后即使每维只取 Top3，
> 返回的内容依然可能非常长（尤其是学术文档的原文摘录）。
>
> **后果**：主 Agent 在整合时，最终回答又长又散，
> 用户读不完，且 Token 消耗远超预期。

#### 解决方案：单维 Token 预算 + 摘要浓缩机制

**YAML 头新增字段**：

```yaml
dimension_config:
    min_dimensions: 2
    max_dimensions: 4                 # 最多拆 4 个维度
    parallel_execution: true          # 并行执行子Agent
    streaming_aggregation: true       # 流式聚合（防递归溢出）
    sub_agent_timeout_ms: 8000        # 单个子Agent超时
    token_budget_per_dimension: 400   # 🆕 单维度硬性 Token 上限
    summarization_action: "condense"  # 🆕 超限时执行动作：摘要浓缩
```

**Markdown 正文新增规则**：

```markdown
## 单维 Token 预算与摘要浓缩（硬性执行）

### 问题本质

主观性强的评价类问题（如"怎么看俄乌冲突"、"你怎么看深度学习的发展"）
天然倾向于拆出更多维度。但每个维度的 RAG 召回内容长度不可控：
- 有的维度可能只召回 150 tokens（精简的要点列表）
- 有的维度可能召回 800+ tokens（大段原文摘录 + 模型展开分析）

如果放任不管，4 个维度中只要有 2 个"话痨"，总 Token 就会爆炸。

### 浓缩流程

```
子Agent返回某维度结果
    ↓
计算该维度内容的 Token 数（粗估：字符数 / 3）
    ↓
┌─────────────────────────────────────┐
│ ≤ 400 tokens → 直接通过，进入整合     │
│ > 400 tokens → 触发 LLM 摘要浓缩     │
│                                     │
│ 浓缩 Prompt:                        │
│ "将以下内容浓缩为不超过 400 tokens    │
│  的要点，保留核心论点和数据，          │
│ 删除冗余表述和重复论证。"             │
└─────────────────────────────────────┘
    ↓
浓缩后内容进入主Agent整合
```

### 浓缩规则细节

1. **Token 计算方式**：服务端粗估 `Math.ceil(content.length / 3)`，无需精确 tokenizer
2. **浓缩用轻量模型**：调用快速模型（如 gpt-4o-mini 或同级别），不消耗主模型配额
3. **浓缩必须保留**：
   - ✅ 核心论点/结论
   - ✅ 关键数据/数字
   - ✅ 来源文档标题（用于引用标记）
   - ✅ 正反两方观点（如有冲突）
4. **浓缩可以丢弃**：
   - ❌ 冗余的过渡句
   - ❌ 重复论证（同一观点说了两遍）
   - ❌ 过长的原文逐字引用（改为概括性转述）
5. **浓缩后的标注**：若某维度经过了浓缩，在输出中隐式标注（不暴露给用户）：

```json
{
  "name": "国际关系维度",
  "status": "completed",
  "summarized": true,           // 🆕 标记该维度被浓缩过
  "original_token_estimate": 920,
  "condensed_token_estimate": 385,
  "key_points": [...],         // 浓缩后的要点
  "sources": [...]             // 来源保留不变
}
```

### 为什么不直接限制子Agent的返回长度？

| 方案 | 优点 | 缺点 |
|------|------|------|
| A: 子Agent端限制返回长度 | 从源头控制 | 可能截断关键信息，导致语义不完整 |
| B: 主Agent端浓缩（本方案） | 保证信息完整性，智能取舍 | 多一次LLM调用（但用轻量模型，<200ms） |

**选择方案 B 的理由**：子Agent检索时不知道哪些内容是关键的，
粗暴截断可能丢失核心论点。而在主Agent侧做浓缩，
可以利用全局上下文判断哪些信息值得保留、哪些可以舍弃。
```

#### 对整体 Token 预算的影响估算

| 场景 | 无浓缩 | 有浓缩 |
|------|--------|--------|
| 3个维度，每维平均 300 tokens | 900 | 900（未触发） |
| 4个维度，其中2个超长(700+tokens) | **2200+** | **≤1600**（超长的2个被压到400） |
| 4个维度全部超长 | **2800+** | **≤1600**（全部压到400） |
## 维度拆解规则

主Agent在路由阶段即完成维度拆解（这是轻量操作，不查库）：

### 自动拆解Prompt

```
用户问题: "{question}"

请将该评价类问题拆解为 2~4 个独立的评价维度。
每个维度应：
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
      "key_points": [
        "减轻大模型幻觉问题",
        "支持知识实时更新",
        "答案可溯源"
      ],
      "sources": [
        {"doc_title": "RAG综述.pdf", "excerpt": "..."}
      ],
      "confidence": 0.88
    },
    {
      "name": "现存挑战",
      "status": "completed",
      "key_points": ["检索质量依赖切分策略", "..."],
      "sources": [...],
      "confidence": 0.82
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

> **重要**：hybrid 不是用户可见的"第四态路由结果"，而是**服务端内部的组合优化策略**。
> 用户只看到三种分类：clarify / fact / perspective。hybrid 的存在对用户完全透明。

当一个问题时隐含事实需求 + 评价需求
（例如："你怎么看特朗普的关税政策？" —— 既是评价，又需要先知道政策内容是什么），
服务端内部自动启用 **hybrid 组合策略**：

### 🆕 核心改进：Fact 作为 Perspective 的前置上下文

**旧方案的问题**：
Fact 和 Perspective 并行执行，各自独立检索。
但 Perspective 的子Agent在检索"经济影响"维度时，可能又会去查"关税政策的具体内容"——
**这和 Fact-Retriever 的工作完全重复**，浪费 Token 和延迟。

**新方案：Fact 先行，结果注入 Perspective**

```
用户问: "你怎么看特朗普的关税政策?"
    ↓
┌─ 内部检测到: 同时命中 fact 触发词 + perspective 触发词 ─┐
│                                                            │
│  启用 hybrid 策略（用户不可见）                              │
│                                                            │
│  Step 1: Fact-Retriever 先行                                │
│    检索 → "特朗普关税政策: 对华加征25%, 对盟友..."           │
│    ↓                                                        │
│  Step 2: Fact 结果作为「事实基线」注入 Perspective          │
│                                                            │
│  主Agent拆维度: [经济影响, 政治后果, 国际关系]               │
│    ↓                                                        │
│  子Agent1[经济影响]                                         │
│    上下文 = 维度query + Fact基线(已知道政策内容)              │
│    → 只需检索"经济影响"相关文献，不再重复查政策本身            │
│    ↓                                                        │
│  子Agent2[政治后果]  ← 同理                                 │
│  子Agent3[国际关系] ← 同理                                  │
│    ↓                                                        │
│  整合输出                                                    │
└────────────────────────────────────────────────────────────┘
```

### 具体实现

**1. 检测逻辑（IntentRouter 内部）**

```typescript
// 用户看到的路由结果只有三种
export interface IntentRouteResult {
  intent: 'clarify' | 'fact' | 'perspective'  // 无 hybrid！
  confidence: number
  reasoning: string
}

// 服务端内部决定是否启用 hybrid 优化
export interface InternalExecutionPlan {
  userFacingIntent: 'fact' | 'perspective'     // 返回给用户的
  internalStrategy: 'single' | 'hybrid'         // 内部执行策略
  factResult?: FactResult                       // hybrid 时先行获取
}
```

**2. Fact 结果注入子Agent的方式**

```typescript
// perspective-analyzer 的子Agent调用
async function retrieveDimension(
  dimension: Dimension,
  factContext?: string   // 🆕 Fact 前置上下文
): Promise<DimensionResult> {
  
  const systemPrompt = factContext 
    ? `以下是与用户问题相关的已知事实（已由Fact-Retriever确认），请在此基础上补充该维度的评价材料：
${factContext}

请检索关于「${dimension.name}」的相关资料...`
    : `请检索关于「${dimension.name}」的相关资料...`
    
  // 子Agent带着Fact基线去检索，避免重复查已知事实
  return this.subAgent.searchWithContext(dimension.query, systemPrompt)
}
```

**3. 合并规则（更新）**

| 规则 | 说明 |
|------|------|
| 执行顺序 | **Fact 先行**（非并行），Perspective 依赖 Fact 结果 |
| 注入方式 | Fact 结果作为 system prompt 的一部分传入各子Agent |
| 避免重复 | 子Agent query 中排除 Fact 已覆盖的事实型问题 |
| 输出分区 | 最终回答分为「📌 事实确认」+「🔍 多维评价」两部分 |
| Token预算 | Fact 30% : Perspective 70%（Fact只是基线，不需要太多） |

**4. 何时启用 hybrid（自动判定）**

```typescript
function shouldEnableHybrid(
  factTriggersHit: boolean,
  perspectiveTriggersHit: boolean,
  userInput: string
): boolean {
  // 必须同时命中两者
  if (!factTriggersHit || !perspectiveTriggersHit) return false
  
  // 且问题中包含明确实体（说明有事实可查）
  const hasEntity = /[A-Za-z一-鿿]{2,}/.test(userInput)
  return hasEntity
}
```

### 对用户体验的影响

| 维度 | 旧方案（hybrid 作为第四态） | 新方案（hybrid 作为内部优化） |
|------|--------------------------|---------------------------|
| 用户感知到的分类 | 4 种（看到 hybrid 会困惑） | 3 种（清晰） |
| API 响应中的 intent 字段 | 可能返回 "hybrid" | 永远不会返回 "hybrid" |
| 前端适配 | 需要 hybrid 的特殊 UI | 不需要 |
| 日志/监控 | 可以看到 `internal_strategy: "hybrid"` | 同左（仅内部可见） |

---

### Tool 4: Confidence-Checker（置信度检验）

**文件**: `src/chat/tools/confidence-checker.skill.md`

```yaml
---
name: confidence_checker
version: "1.0.0"
category: post_process
description: "检验RAG返回结果是否有充分的事实依据支撑"
triggers:
  trigger_mode: "automatic"              # 自动触发，不由用户输入触发
  invoke_condition: "after_any_rag_call"  # 任何RAG调用完成后自动执行
  rag_binding: "none"                     # 后处理工具，自身不走RAG
  max_recursion_depth: 0
  token_budget: 300
parameters:
  - name: rag_results
    type: array[object]
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

在任何 RAG 调用（Fact 或 Perspective）完成后，**自动触发**，
检验返回结果是否有充分的事实依据支撑。这是一个**后处理工具**，
不由用户输入直接触发。

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
  // 🆕 可执行的行动建议（不只是打标签）
  "recommended_action": {
    "action": "annotate_with_uncertainty",
    "detail": "来源可靠性得分 0.65，低于 0.8 阈值。建议在相关论段前添加「该观点的文献支撑较弱」标注",
    "affected_dimensions": ["经济影响维度"],
    "auto_executable": true          // 主Agent可自动执行，无需人工介入
  }
}
```

### 判定标准与可执行动作

| 状态 | 条件 | recommended_action | 主Agent行为 |
|------|------|-------------------|------------|
| **pass** | confidence ≥ 0.8 | `{"action": "proceed"}` | 正常输出 |
| **warn** | 0.5 ≤ conf < 0.8 | `{"action": "annotate_with_uncertainty"}` 或 `{"action": "narrow_claim_scope"}` | **自动执行**对应动作 |
| **fail** | conf < 0.5 | `{"action": "reject_or_fallback"}` | 拒绝回答或触发降级 |

#### 🆕 warn 状态的可执行动作明细

**不是只打个标签告诉主Agent"有问题"，而是明确告诉它该怎么做：**

| action 类型 | 触发条件 | 具体指令 | 示例 |
|------------|---------|---------|------|
| `annotate_with_uncertainty` | 单维得分偏低(0.6~0.8) | 在受影响的论段加不确定性标注 | "据现有资料，X的影响约为Y%（注：该数据仅来自单一来源）" |
| `narrow_claim_scope` | 引用不完整 | 收窄断言范围，避免过度陈述 | 将"显著提升"改为"在某些场景下有提升" |
| `highlight_conflict` | 多源矛盾 | 标注矛盾点，呈现多方观点 | "A文献认为X，而B文献认为Y，两者存在分歧" |
| `suggest_more_sources` | 来源单一 | 建议用户补充更多文档 | "目前仅有1篇文献支撑该结论，建议上传更多资料以获得更全面的分析" |

#### 为什么推荐_action 比纯标签更好

| 对比项 | 旧方案（纯 warn 标签） | 新方案（recommended_action） |
|--------|---------------------|---------------------------|
| 主Agent知道怎么做吗？ | ❌ 只知道"有问题"，不知道怎么处理 | ✅ 明确知道该执行哪个动作 |
| 需要二次LLM判断吗？ | ✅ 需要（增加延迟和成本） | ❌ 不需要（直接执行） |
| 输出质量稳定性 | ⚠️ 取决于模型临时发挥 | ✅ 由规则保证一致性 |
| 可扩展性 | 差（新情况要改Prompt） | 好（新增action类型即可） |

#### fail 状态的处理

```json
{
  "check_result": "fail",
  "overall_confidence": 0.35,
  "recommended_action": {
    "action": "reject_or_fallback",
    "detail": "所有维度均低于阈值，且存在多源矛盾",
    "fallback_option": "general_knowledge_with_disclaimer",  // 或 "reject"
    "user_message": "现有资料不足以支撑对该问题的可靠分析。如果你有更多相关文档，可以上传后重新提问。"
  }
}
```

## 与主Agent的集成方式

Confidence-Checker 作为**中间件**嵌入调用链：

```
RAG工具返回结果
    ↓
Confidence-Checker.autoCheck(results)
    ↓
┌───────────────────────────────────┐
│ pass → 正常传递给主Agent生成回答    │
│ warn → 附加 warning 标签传递       │
│ fail → 触发降级/拒绝回答流程       │
└───────────────────────────────────┘
```

主Agent在收到 `warn` 结果时，必须在回答末尾追加：

> **依据强度提示**：本回答的部分论点缺乏直接的文献支撑，建议以原始文献为准。
```

---

## 三、五大痛点解决方案总结

### P1: 子Agent无限递归风险 ✅

| 方案 | 说明 |
|------|------|
| **流式管道** | 主Agent不等待全量完成，先到的先整合 |
| **硬性上限** | 每维度 Top3，总文档数 ≤ 维度数 × 3 |
| **超时熔断** | 每个子Agent 8s 超时，超时标记「数据不足」 |
| **深度限制** | `max_recursion_depth: 1`，子Agent不再拆子维度 |

### P2: 评价/事实二义性 ✅

| 方案 | 说明 |
|------|------|
| **混合路由（第四态）** | 同时满足两者时，并行触发 Fact + Perspective |
| **Fact先行注入** | Fact结果作为Perspective的事实基线 |
| **Token预算分配** | Fact 40% : Perspective 60% |
| **输出分区** | 最终回答分为「事实陈述区」+「多维评价区」 |

### P3: 工具定义格式 ✅

| 方案 | 说明 |
|------|------|
| **YAML头信息** | 元数据/触发条件/参数Schema，路由层只需读YAML |
| **Markdown正文** | Prompt指令/示例，仅在调用时加载 |
| **渐进式披露** | 首轮分类只消耗 ~200 tokens（YAML），调用时才加载完整Prompt |
| **统一目录** | 所有工具定义放在 `src/chat/tools/*.skill.md` |

### P4: Fact 连续 Fallback 污染上下文 ✅ （🆕）

> **问题**：用户连续问库内没有的事实问题 → 连续 fallback 通用知识 →
> 上下文被大量"负样本"占据 → 后续命中时模型反而犹豫不决

| 方案 | 说明 |
|------|------|
| **连续熔断机制** | 最多允许 2 次 fallback，第 3 次直接拒绝回答 |
| **引导行动** | 拒绝时提示用户上传相关文档，而非无意义地消耗 Token |
| **计数器作用域** | 按 `kbId + userId` 维度独立维护，互不干扰 |
| **自动重置** | 任何一次成功命中后归零，避免误伤 |

### P5: Perspective 维度拆解导致 Token 爆炸 ✅ （🆕）

> **问题**：主观性强的问题（如"怎么看俄乌冲突"）可能拆出 4 个维度，
> 子Agent召回内容长度不可控 → 最终回答又长又散

| 方案 | 说明 |
|------|------|
| **单维 Token 预算** | `token_budget_per_dimension: 400`，硬性上限 |
| **LLM 摘要浓缩** | 超限时用轻量模型做智能浓缩（保留核心论点，丢弃冗余） |
| **方案 B 优于 A** | 不在子Agent端粗暴截断（可能丢关键信息），而在主Agent侧智能取舍 |
| **效果估算** | 最坏情况下从 2800+ tokens 压缩到 ≤1600 |

---

### 🆕 审查改进项（Phase 1~2 直接采纳）

以下 5 条改进来自架构审查，全部标记为 **✅ 采纳/强烈建议采纳**：

#### R1: hybrid 从第四态降级为内部组合模式 ✅（强烈建议）

| 维度 | 旧方案 | 新方案 |
|------|--------|--------|
| 用户感知 | 看到 `intent: "hybrid"` | 永远只看到 clarify / fact / perspective |
| 路由类型 | `IntentType` 包含 hybrid | `IntentType` 只有3种；hybrid 归入 `InternalStrategy`（仅服务端） |
| 前端适配 | 需要 hybrid 特殊 UI | 不需要 |
| 本质 | hybrid 是路由结果 | **hybrid 是执行优化策略，不是分类结果** |

#### R2: Clarify 的 pendingConfirmation 防死循环 ✅（强烈建议）

> 这是本方案**最大的 UX 漏洞**。用户说"是"会再次命中 Clarify 触发条件 → 无限循环。

**解决方案**：会话状态机 + `pendingConfirmation` 标记
- Clarify 触发后进入 pending 状态（TTL: 3轮或60s）
- 后续输入走专门的「确认解析路径」而非重新触发 Clarify
- 支持4种 Case：具体问题 → 正常处理；"是/对" → 映射最高置信度候选项；"不是/不对" → 映射第二选项；其他模糊词 → 降级 normal
- **前端完全无感知**

#### R3: Confidence-Checker 增加 recommended_action ✅（采纳）

让 `warn` 状态从「纯标签」变为「可执行动作」：
- `annotate_with_uncertainty`：自动加不确定性标注
- `narrow_claim_scope`：自动收窄断言范围
- `highlight_conflict`：自动标注多源矛盾
- 主Agent **直接执行动作**，不需要二次 LLM 判断

#### R4: Fact 作为 Perspective 的前置上下文 ✅（采纳）

评价类问题必须有事实基础。改进后：
- Fact **先行**（非并行），结果作为 system prompt 注入各子Agent
- 子Agent带着「已知事实基线」去检索，**避免重复查 Fact 已覆盖的内容**
- Token 预算从 4:6 调整为 **30:70**（Fact 只是基线）

#### R5: skill-loader.ts 容错设计 ✅（采纳）

YAML 解析失败时整个路由层不可用 = **生产事故**。容错层级：
1. Schema 校验 + 降级警告
2. 单文件解析失败 → 从文件名反推基础配置（保底可用）
3. 再失败 → 使用内置硬编码 Prompt（最小可用版本）
4. 所有降级事件记录日志 + 健康检查 API 可查询
5. 热更新时先校验，不通过则回滚

---

## 四、目录结构规划

```
src/chat/
├── tools/                          # 工具定义目录（Anthropic Skill 模型）
│   ├── clarify.skill.md           # Tool 1: 模糊澄清
│   ├── fact-retriever.skill.md    # Tool 2: 事实溯源
│   ├── perspective-analyzer.skill.md # Tool 3: 多维评价
│   ├── confidence-checker.skill.md   # Tool 4: 置信度检验
│   └── skill-loader.ts            # Skill 文件加载器（YAML解析+渐进披露）
├── agents/
│   ├── main-agent.ts              # 主Agent（意图路由器）
│   ├── sub-agent.ts               # 子Agent（Perspective专用）
│   └── confidence-agent.ts        # 置信度检验Agent
├── routers/
│   └── intent-router.ts           # 意图路由器（四态分类）
├── roleDefinition.ts              # 保留但精简（仅核心身份）
├── tools.ts                       # 重构：从skill文件动态生成
├── chat.service.ts                # 重构：接入新工具链
└── ...
```

---

## 五、关键代码改动点

### 5.1 意图路由器（新增 `routers/intent-router.ts`）

核心逻辑：用户输入 → 四态分类 → 选择工具组合

```typescript
export type IntentType = 'clarify' | 'fact' | 'perspective'
// hybrid 是内部组合策略，不是路由结果类型
export type InternalStrategy = 'single' | 'hybrid'  // 仅服务端内部使用

export interface IntentRouteResult {
  intent: IntentType
  confidence: number
  triggeredTools: string[]
  reasoning: string
}

// 轻量分类：只读YAML头的 triggers，不加载Markdown正文
export async function classifyIntent(
  userInput: string,
  conversationContext?: string
): Promise<IntentRouteResult>
```

### 5.2 Skill 加载器（新增 `tools/skill-loader.ts`）

```typescript
// 渐进式披露：两层加载
interface SkillMeta {
  // 第一层：始终加载（YAML解析后的元数据）
  name: string
  triggers: TriggerConfig
  ragBinding: 'none' | 'strong' | 'loose'
  parameters: ParameterSchema[]
  // 第二层：按需加载（Markdown正文）
  promptInstructions?: string  // 懒加载
  
  // 🆕 容错字段
  loadStatus: 'ok' | 'degraded' | 'failed'
  parseWarnings: string[]       // 解析过程中的警告
  fallbackTriggers?: TriggerConfig  // YAML解析失败时的降级触发器
}

export class SkillLoader {
  private skills: Map<string, SkillMeta> = new Map()
  private fallbackRegistry: Map<string, TriggerConfig> = new Map()  // 🆕 硬编码降级注册表
  
  // 加载所有Skill的元数据（启动时，约50ms）
  async loadAllMetas(): Promise<Map<string, SkillMeta>> {
    const skillFiles = glob('src/chat/tools/*.skill.md')
    
    for (const file of skillFiles) {
      try {
        const meta = await this.parseSkillFile(file)
        this.skills.set(meta.name, meta)
      } catch (error) {
        // 🆕 单个文件解析失败不影响整体
        console.warn(`[SkillLoader] Failed to parse ${file}:`, error.message)
        this.registerFallback(file, error)
      }
    }
    
    return this.skills
  }
  
  // 🆕 核心容错：YAML 解析失败时的降级策略
  private registerFallback(filePath: string, error: Error): void {
    const skillName = path.basename(filePath).replace('.skill.md', '')
    
    // 从文件名推断最基础的触发规则（保底方案）
    const inferredTriggers = this.inferTriggersFromFileName(skillName)
    
    this.fallbackRegistry.set(skillName, {
      triggers: inferredTriggers,
      ragBinding: this.inferRagBinding(skillName),
      loadStatus: 'degraded',
      parseWarnings: [`YAML解析失败: ${error.message}, 使用从文件名推断的降级配置`]
    })
    
    // 同时记录到监控
    this.reportDegradedSkill(skillName, error)
  }
  
  // 🆕 从文件名反推基础触发规则（保底，不精确但可用）
  private inferTriggersFromFileName(fileName: string): TriggerConfig {
    const rules: Record<string, TriggerConfig> = {
      'clarify': {
        keywords: ['然后呢', '咋整', '所以呢', '接下来'],
        patterns: ['^.{0,5}$'],
        input_length_threshold: 5
      },
      'fact-retriever': {
        keywords: ['是什么', '谁是', '什么时候', '多少'],
        patterns: ['(是什么|谁是|何时)'],
        rag_binding: 'strong'
      },
      'perspective-analyzer': {
        keywords: ['怎么看', '你认为', '意味着', '评价'],
        patterns: ['(你怎么看|你认为|你觉得)'],
        rag_binding: 'loose'
      },
      'confidence-checker': {
        trigger_mode: 'automatic',
        invoke_condition: 'after_any_rag_call',
        rag_binding: 'none'
      }
    }
    
    return rules[fileName] || { keywords: [], patterns: [] }
  }
  
  // 🆕 Schema 校验（启动时 + 热更新时）
  private validateSchema(meta: SkillMeta): ValidationResult {
    const errors: string[] = []
    const warnings: string[] = []
    
    // 必填字段校验
    if (!meta.name) errors.push('name is required')
    if (!meta.triggers) errors.push('triggers is required')
    if (!meta.ragBinding) errors.push('ragBinding is required')
    
    // 值域校验
    const validBindings = ['none', 'strong', 'loose']
    if (!validBindings.includes(meta.ragBinding)) {
      errors.push(`ragBinding must be one of ${validBindings.join(', ')}, got: ${meta.ragBinding}`)
    }
    
    // 触发器合理性校验
    if (meta.triggers.keywords && meta.triggers.keywords.length === 0 
        && meta.triggers.patterns && meta.triggers.patterns.length === 0) {
      warnings.push('No triggers defined - this skill will never be invoked')
    }
    
    // Token 预算合理性
    if (meta.tokenBudget && meta.tokenBudget > 4000) {
      warnings.push(`tokenBudget ${meta.tokenBudget} exceeds recommended max of 4000`)
    }
    
    return { ok: errors.length === 0, errors, warnings }
  }
  
  // 按需加载单个Skill的完整Prompt
  async loadFullPrompt(skillName: string): Promise<string> {
    const meta = this.skills.get(skillName)
    if (!meta) throw new Error(`Skill not found: ${skillName}`)
    
    // 🆕 如果是 degraded 状态，返回内置的精简 Prompt
    if (meta.loadStatus === 'degraded') {
      return this.getBuiltinPrompt(skillName)
    }
    
    // 正常路径：读取 Markdown 正文
    // ...
  }
  
  // 🆕 内置降级 Prompt（每个 skill 都有一个最小可用版本）
  private getBuiltinPrompt(skillName: string): string {
    const builtinPrompts: Record<string, string> = {
      'clarify': `你是意图澄清助手。当用户输入模糊或过短时，基于上下文生成自然语言反问。必须从上下文已有实体中派生候选项，不得引入新实体。`,
      'fact-retriever': `你是事实检索助手。针对事实类问题执行高精度检索。只返回高置信度结果(Top3)，每条必须附原文出处。`,
      'perspective-analyzer': `你是多维评价分析助手。将评价类问题拆解为2~4个维度，每维度独立检索后整合输出。`,
      'confidence-checker': `你是置信度检验助手。检验RAG结果是否有事实依据支撑，返回可执行的行动建议。`
    }
    
    return builtinPrompts[skillName] || '请根据用户问题提供帮助。'
  }
  
  // 将Skill元数据转换为OpenAI Tool Schema
  toToolSchema(meta: SkillMeta): ChatCompletionTool {
    // 🆕 即使是 degraded 状态也能生成基本可用的 schema
    return {
      type: 'function',
      function: {
        name: meta.name,
        description: meta.description || `${meta.name} tool`,
        parameters: meta.parameters || { type: 'object', properties: {} }
      }
    }
  }
  
  // 🆕 健康检查接口（供运维/监控使用）
  getHealthReport(): SkillLoaderHealthReport {
    return {
      totalSkills: this.skills.size + this.fallbackRegistry.size,
      loadedOk: [...this.skills.values()].filter(s => s.loadStatus === 'ok').length,
      degraded: this.fallbackRegistry.size,
      failed: 0,  // failed 的也会被降级为 degraded，所以这里永远是 0
      details: [...this.skills.entries(), ...this.fallbackRegistry.entries()].map(([name, meta]) => ({
        name,
        status: meta.loadStatus || 'ok',
        warnings: meta.parseWarnings || []
      }))
    }
  }
}

// 🆕 健康报告类型
interface SkillLoaderHealthReport {
  totalSkills: number
  loadedOk: number
  degraded: number
  failed: number
  details: Array<{ name: string; status: string; warnings: string[] }>
}
```

### 容错设计原则

| 原则 | 说明 |
|------|------|
| **单点故障隔离** | 一个 skill 文件损坏不影响其他 skill |
| **永不崩溃** | YAML 解析失败 → 降级到硬编码配置 → 再失败 → 使用内置 Prompt |
| **启动时不阻塞** | 解析失败的 skill 异步重试，不阻塞服务启动 |
| **可观测性** | 所有降级事件记录到日志 + 健康检查 API 可查询 |
| **热更新安全** | 运行时更新 skill 文件时先校验 Schema，校验不通过则回滚 |

### 5.3 chat.service.ts 核心改动

```typescript
// 旧的线性流程：
// callingModel() → 检测tool_call → queryKb() → callingModel(withKbRules)

// 新的多分支流程：
async modelResult(...) {
  // 1. 意图路由（轻量，只读YAML）
  const route = await this.intentRouter.classifyIntent(userInput, context)
  
  // 🆕 内部策略判定：是否需要 hybrid 优化（对用户透明）
  const internalPlan = this.buildExecutionPlan(route, userInput)
  
  switch (internalPlan.internalStrategy) {
    case 'single':
      // 单工具执行
      switch (route.intent) {
        case 'clarify':
          return this.handleClarify(userInput, context, state)
        case 'fact':
          return this.handleFact(userInput)
        case 'perspective':
          return this.handlePerspective(userInput)
      }
      break
      
    case 'hybrid':
      // 🆕 内部组合：Fact 先行 + Perspective 基于Fact展开
      return this.executeWithHybridStrategy(userInput, route.intent)
  }
}
```

### 5.4 chat.service.ts 新增方法骨架

```typescript
// ========== Tool 1: Clarify（无RAG）==========
// 输出自然语言反问文本，像真人助手确认需求
private async handleClarify(
  userInput: string,
  context: string,
  entityPool: string[]  // 从上下文提取的实体池，用于硬性约束
): Promise<MessageType> {
  // 1. 调用LLM生成自然语言反问（不查库）
  //    Prompt中强制注入实体封闭性约束：只能从entityPool中派生候选项
  const clarification = await this.generateClarificationText(userInput, context, entityPool)
  
  // 2. 作为普通answer消息流式推送给前端（无需特殊事件类型）
  this.notifyStream(this.stream, {
    type: 'answer',
    content: clarification.display_text,   // 自然语言："你是在问A吗？还是想了解B？"
  })
  this.stream.end()
  
  // 3. 返回助手消息（持久化时正常落库，因为这就是一条正常的对话回复）
  return {
    role: 'assistant',
    content: clarification.display_text,
    meta: {
      intent_type: 'clarify',
      inferred_intents: clarification.inferred_intents,  // 内部元数据
      entity_pool: entityPool                            // 用于日志分析
    }
  }
}

// ========== Tool 2: Fact-Retriever（强绑定RAG）==========
private async handleFact(
  question: string
): Promise<MessageType> {
  // 1. 单路精搜 + Rerank + 高阈值过滤
  const searchResult = await this.fileanagementService.preciseSearch(question, {
    topK: 3,
    rerankThreshold: 0.75,
    requireSource: true
  })
  
  // 2. Confidence-Checker 校验
  const confidence = await this.confidenceAgent.check(searchResult)
  
  // 3. 组装上下文，调用模型生成回答（带引用标记）
  return this.generateFactAnswer(question, searchResult, confidence)
}

// ========== Tool 3: Perspective-Analyzer（松耦合RAG）==========
private async handlePerspective(
  question: string
): Promise<MessageType> {
  // 1. 主Agent拆解维度（轻量LLM调用，不查库）
  const dimensions = await this.splitDimensions(question)
  
  // 2. 并行启动子Agent（每维度独立RAG检索，流式返回）
  const dimensionResults = await Promise.allSettled(
    dimensions.map(d => 
      this.subAgent.retrieveDimension(d, { timeoutMs: 8000, maxResults: 3 })
    )
  )
  
  // 3. 边收边整合：先完成的维度先生成该部分回答
  return this.streamingAggregate(dimensionResults, dimensions)
}

// ========== 内部执行：hybrid 组合策略（用户不可见）==========
// 当 IntentRouter 检测到问题同时命中 fact + perspective 时自动启用
// 用户看到的 intent 永远是 'fact' 或 'perspective'，不会看到 'hybrid'
private async executeWithHybridStrategy(
  question: string,
  userFacingIntent: 'fact' | 'perspective'
): Promise<MessageType> {
  // 1. Fact 先行（作为 Perspective 的前置上下文）
  const factResult = await this.handleFact(question)
  
  // 2. 将 Fact 结果注入 Perspective 子Agent的上下文
  const factContext = this.extractFactBaseline(factResult)
  
  // 3. Perspective 在 Fact 基线上展开维度分析
  const perspectiveResult = await this.handlePerspective(question, { factContext })
  
  // 4. 合并输出：「📌 事实确认」+「🔍 多维评价」
  return this.mergeHybridOutput(factResult, perspectiveResult)
}
```

---

## 六、迁移路径建议

### Phase 1: 基础设施（1周）
1. 创建 `tools/` 目录和4个 `.skill.md` 文件
2. 实现 `skill-loader.ts`（YAML解析 + 渐进式披露）
3. 实现 `routers/intent-router.ts`（四态分类逻辑）

### Phase 2: 工具替换（1周）
1. 实现 `handleClarify()` 替代原有的续问识别
2. 实现 `handleFact()` 替代原有的 `queryKb()`
3. 保留旧代码作为fallback，通过feature flag切换

### Phase 3: 高级特性（2周）
1. 实现 `handlePerspective()` + 子Agent
2. 实现 `Confidence-Checker` 中间件
3. 实现混合路由模式
4. Clarify 输出为普通文本消息，前端无需特殊适配（自然渲染即可）

### Phase 4: 优化（持续）
1. Rerank 模型接入
2. Token预算动态调整
3. 各工具的超时/降级策略调优
4. 监控面板：各工具触发频率、延迟、置信度分布

