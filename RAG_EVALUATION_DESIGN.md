# RAG 评测体系设计方案（v2 落地修订版）

> 针对本项目的四工具 RAG 架构（IntentRouter → Clarify / Fact / Perspective + Confidence-Checker + Fallback 熔断），
> 补全**检索质量评测（精确率/召回率）、端到端生成质量评测、路由评测、线上监控**四层体系。
>
> **v2 修订要点（相对 v1 的落地逻辑调整）：**
> 1. **生成层评测改为"程序化校验优先 + LLM 仅抽样复核"**：v1 以 LLM-as-Judge（GPT-4o / qwen-max 打分）为主手段，
>    存在不可复现、评估偏差（位置/长度/自褒）、成本高等问题，不适合做 CI 门禁。引用正确率、拒答正确率均可程序化判定，
>    语义相关度打分降级为每周抽样人工复核，不再批量自动打分。
> 2. **置信度检验模块接入评测体系**：`ConfidenceAgent` 的 `check_result` + 四维度分数直接成为 trace 字段（零新增埋点成本），
>    同时置信度模块**自身也要被评测**——用评测集算它的 fail 召回率 / pass 误杀率，校准单源 0.6/多源 0.85、阈值 0.8/0.5、
>    stdDev 0.15 等魔法数字。
> 3. **评测栈改为 TS + Jest**：不引入 Python 双栈。复用现有 `@nestjs/testing` + `test-mocks/milvus-sdk.stub.ts`，
>    通过注入 Service 直接跑离线评测，不走 HTTP。
> 4. **按 L0~L3 分层建设，明确复用边界**：指标函数层与 RAG 实现完全解耦，新意图/新工具只新增评测集标注即可复用。
> 5. **rerank_threshold 与置信度边界联合扫参**：阈值不是单独选的——调低阈值会注入噪声、拉低 content_relevance、
>    推高 warn/fail 率，两者互为因果。
> 6. **置信度模块复用化改造**（见 2.4）：拆为 接口契约层 / 策略实现层 / 配置层 三层，魔法数字外置 + `configHash` 版本指纹，
>    使其同时服务 在线标注 / 离线评测扫参 / 线上监控 三个消费方；规则版保持无 LLM、确定性，作为评测与 CI 门禁的锚点。

---

## 〇、现状与缺口

| 现有能力 | 缺口 |
|---|---|
| `preciseSearch`（向量候选 → Rerank → 阈值过滤） | 没有评测集，top_k / rerank_threshold=0.75 等参数是拍脑袋定的 |
| `hybridSearch`（向量 + 关键词 + RRF） | 不知道 RRF 相比单路向量检索到底提升了多少 |
| IntentRouter（clarify/fact/perspective + hybrid 内部策略） | 路由准确率无度量，误路由（fact→perspective 等）不可见 |
| **Confidence-Checker（`ConfidenceAgent`）** | **已有 pass/warn/fail + 四维度分数，但只用于回答末尾标注，未进入评测链路；其内部阈值/权重未经数据校准** |
| Fallback 熔断 | 熔断触发率、误杀率无监控 |
| `logs/log.log` 文本日志 | 无结构化埋点，无法回溯单次请求的检索/生成质量 |

---

## 一、评测集建设（一切评测的前提）

### 1.1 检索评测集（retrieval golden set）

格式（JSONL，存 `nest-serve/eval/datasets/retrieval.jsonl`）：

```json
{"qid": "r001", "query": "注意力机制的定义是什么", "relevant_chunks": ["chunkId_a", "chunkId_b"], "intent": "fact"}
{"qid": "r002", "query": "RAG 有哪些优缺点", "relevant_chunks": ["chunkId_c"], "intent": "perspective"}
```

要点：

- **relevant_chunks 标注到 chunk 级**（Milvus 里的 docChunk id），这是算精确率/召回率的分母。
- 冷启动造法：从已入库文档随机抽 50~100 个 chunk，让 LLM 反向生成问题，再人工校对相关性 —— 比正向标注快 5 倍。
- 每个 intent 至少 30 条；另加 20 条**库外问题**（relevant_chunks 为空），专门评测"该拒答时是否拒答"（熔断路径 + ConfidenceAgent 的 fail 判定）。
- 版本化：数据集文件名带日期，评测结果绑定数据集版本，否则指标不可比。
- **额外标注字段（供置信度模块自评测用）**：`has_basis: true|false` —— 该问题在知识库中是否有可靠依据。库内问题为 true，库外问题为 false，人工确认。

### 1.2 生成评测集（answer golden set）

```json
{"qid": "a001", "query": "...", "reference_answer": "...", "must_cite": ["docTitle_x"], "forbidden_claims": ["..."]}
```

- `must_cite` 校验引用真实性（**程序化校验**，见 2.3）；
- `forbidden_claims` 校验幻觉（**程序化主张校验** + 抽样人工复核，见 2.3）；
- `reference_answer` 仅用于人工复核时的参考，不作为自动打分依据。

---

## 二、离线评测指标

### 2.1 检索层指标（对 `preciseSearch` / `hybridSearch` 跑批）

| 指标 | 定义 | 用途 |
|---|---|---|
| **Recall@k** (k=3,5,20) | 前 k 条命中相关 chunk 数 / 该问题相关 chunk 总数 | 衡量召回是否漏。Recall@20 看向量粗排上限，Recall@3 看 Rerank 后精排 |
| **Precision@k** | 前 k 条中相关 chunk 数 / k | 衡量噪声。Fact 路径 top_k=3 时 Precision@3 直接决定注入上下文的干净程度 |
| **MRR** | 第一个相关结果的倒数排名均值 | 单答案事实问题的核心指标 |
| **nDCG@k** | 带位置折损的分级相关性 | 对 Perspective 多路召回更重要 |
| **Hit Rate** | 前 k 条是否至少命中 1 条相关 | 与 `has_factual_basis` 直接对应 |

**两个专项实验（全部程序化，零 LLM）：**

1. **A/B：hybridSearch vs 单向量检索** —— 用 Recall@5 / MRR 证明 RRF 融合的价值（或发现它没价值就下线）。
2. **Rerank 阈值联合扫参**：扫 rerank_threshold ∈ {0.5, 0.6, 0.7, 0.75, 0.8, 0.85}，画 Precision-Recall 曲线；
   **同时记录每个阈值下 ConfidenceAgent 的 warn/fail 占比**——阈值调低 → 注入噪声 → content_relevance 下降 →
   warn/fail 率上升。用"端到端 Precision@3 与置信度通过率"双目标选阈值，替换现在写死的 0.75。
3. **Rerank 降级影响评估**：同一评测集分别跑"qwen3-rerank 真实打分"与"RRF 近似分"两条路径，
   对比 nDCG@3 差距，量化当前降级兜底的损失（这决定是否值得优先修 Rerank 链路）。

### 2.2 路由层指标

对 IntentRouter 单独评测（评测集里已标 intent）：

- **三分类准确率 + 混淆矩阵**：重点看 fact↔perspective 互误、短输入误入 clarify。
- **hybrid 触发正确率**：人工标注 30 条"既是事实又是评价"的问题，看 `shouldEnableHybrid` 的命中情况。
- **Clarify 死循环率**：模拟"是/对/嗯"确认流，验证 pendingConfirmation 状态机的退出率 = 100%（可用现有 `intent-router.spec.ts` 扩展）。

### 2.3 生成层指标（程序化校验优先，LLM 仅抽样复核）

> **设计原则（v2 修订核心）**：能用代码判定的绝不用模型。LLM-as-Judge 存在不可复现（prompt/temperature/模型版本漂移导致分数抖动）、
> 评估偏差（位置偏差、长度偏差、自褒偏差）、成本高三大硬伤，**不适合作为批量自动打分和 CI 门禁依据**。

| 维度 | 校验方式 | LLM 依赖 |
|---|---|---|
| **引用正确率** | **程序化**：解析回答中的 docTitle 标注，逐个断言与对应 chunk 的 docText 做包含/近邻匹配 | ❌ |
| **拒答正确率** | **程序化**：库外问题（relevant_chunks 为空）是否触发了 fallback 前缀 / ⚠️ 标注 / reject_or_fallback 文案 | ❌ |
| **忠实度（幻觉检测）** | **程序化代理**：把回答拆成原子主张 → 与注入的检索上下文用现有 `text-embedding-v3` 算相似度，低于阈值标记为疑似幻觉；**只把疑似项送去人工复核** | ⚠️ 仅 embedding，非 LLM 打分 |
| **语义相关度** | **LLM-as-Judge 抽样复核**：每周抽 10~20 条（优先从坏例池抽），固定 prompt 版本 + temperature=0 + 固定模型版本，结果人工确认后写回 trace，不自动进入任何门禁 | ✅ 仅抽样 |

**程序化校验实现要点（P1 范围）：**

- 引用校验：回答格式约定的引用标记（如 `[来源：docTitle]`）→ 截取对应断言文本 → 与 `docText` 做归一化子串匹配；
  匹配率 < 阈值视为疑似虚假引用，标记待人工复核。
- 拒答判定：检查输出是否带 fallback 标记（`has_factual_basis=false` 分支的提示语/⚠️ 前缀），与 golden 的
  `relevant_chunks=[]` 对齐，计算"该拒答时拒答了"的比例。

### 2.4 置信度模块的接入与自评测（v2 新增，重点）

`ConfidenceAgent` 目前是**被闲置的评测信号源**：它已输出 `check_result` + `source_reliability / content_relevance /
citation_completeness / cross_source_consistency` + `warnings` + `recommended_action`，但只被 chat.service 当作回答末尾的一句话标注。

**接入路径分三步：**

1. **信号复用（P0）**：把 `ConfidenceAgent.check()` 的完整输出直接写入结构化 trace（见 3.1），
   `has_factual_basis=false` 占比、fail/warn 占比、rerank top1 分布等线上指标全部从这出，零新增埋点成本。
2. **模块自评测（P1）**：在检索评测集上对每条 query 跑 `preciseSearch` → `ConfidenceAgent.check()`，
   与 golden 的 `has_basis` 标注对比，得到两个核心指标：
   - **fail 召回率** = P(check=fail | has_basis=false) —— 该拒答的有没有拒答；
   - **pass 误杀率** = P(check=pass | has_basis=true) 的补数 —— 不该拦的有没有拦。
   目标：fail 召回率 ≥ 90% 且 pass 误杀率 ≤ 10%，不达标则调阈值。
3. **魔法数字校准（P1）**：用评测结果校准 `confidence-agent.ts` 里的拍脑袋常数：
   `source_reliability`（单源 0.6 / 多源 0.85）、四维权重（0.25/0.3/0.2/0.25）、pass 阈值 0.8、warn 阈值 0.5、
   `hasDivergence` 的 stdDev 0.15。校准前后各留一份指标快照，证明校准带来的改善。

**复用化改造（把置信度模块变成评测体系的可复用资产）：**

现状：`ConfidenceAgent` 是本项目最接近可复用模块的代码 —— **零依赖注入**（无 Redis/MongoDB/OpenAI 依赖，
`new ConfidenceAgent()` 即可用）、**纯规则确定性**（同步计算、无 LLM、无随机性，同一输入恒有同一输出，可复现、可作 CI 门禁依据）。
但有两个"不够格"的地方，即全部改造点：

1. **魔法数字外置（核心）**：阈值 / 权重 / 单源多源系数当前硬编码在 `check()` 内部，无法扫参对比。
   改为构造函数接受可选 `ConfidenceConfig`（缺省用现有默认值，**对外行为完全不变**），并计算 `configHash` 版本指纹，
   trace 与评测结果都记录该 hash，保证"结果可回溯到参数"。
2. **输入契约收紧**：`RagResultItem` 字段全部 optional（`docId?` `score?`），离线评测难对齐。
   收敛到一个 `normalizeResults()` 入口做校验 + 缺省填充，在线链路与评测 runner 共用。

改造后的三层结构（各层独立演进）：

| 层 | 职责 | 关键约束 |
|---|---|---|
| **接口契约层** `ConfidenceChecker` | 统一 `check(results, question, mode, config?)` 签名 | 严格输入契约（docText/score 必填校验） |
| **策略实现层** | `RuleScorer`（现有规则逻辑抽离，默认启用）；未来 `LLMScorer`（语义一致性）可插拔 | **规则版必须保持无 LLM、确定性** —— 它是离线评测/CI 门禁的锚点；LLM 增强只作线下实验 |
| **配置层** `ConfidenceConfig` | 阈值/权重/系数注入 + `configHash` | 缺省 = 现有默认值，向后兼容 |

改造后三个消费方复用同一模块：在线 chat.service（末尾标注 + trace）、离线评测 runner（扫参校准 + fail 召回率）、
线上监控（rag_traces 信号源）。新意图 / 新检索路径接入只需产出 `RagResultItem[]` 即可复用评分，无需改置信度模块。

### 2.5 回归门禁（CI）

`npm run eval:ci`：跑 30 条核心冒烟集。**门禁只看确定性指标**（Recall@k / MRR / 路由准确率 / 引用正确率 / 拒答正确率 /
置信度 fail 召回率），不用 LLM-as-Judge。低于基线（如 Recall@5 降 >3%）则 CI 失败，防止改 prompt / 换模型 / 调参数时悄悄劣化。

---

## 二·五、实测结果与发现（2026-08-11 · 首轮评测）

> 在真实环境（Docker 启动 MongoDB/Milvus/Redis + 用户 `6a62f8b81fee7cc0d9799323` 的知识库，
> 2 篇论文 159 chunk）上跑通 P0 闭环，26 条评测集（21 库内 + 5 库外），产出三份报告见 `eval/reports/`。

### 发现 1（已修复）：Rerank 静默降级 —— qwen3-rerank 响应解析缺分支

- 实测 DashScope 端点返回 `{"object":"list","results":[{index, relevance_score}]}`，
  但 `fileanagement.service.ts` 的 `rerank()` 只兼容 `json.data` 与 `json.output.results`，
  **漏了 `json.results`** → 永远返回 null → preciseSearch 全程走 RRF 近似分降级。
- 表现：hybridSearch 与 preciseSearch 指标**完全相同**（Recall@3=0.731 全一致），rerank 形同虚设。
- 修复：补 `json.results` 分支（已上线 + 4 个单测锁定，见 `fileanagement.service.spec.ts`）。
- **教训：降级兜底代码会掩盖故障 —— rerank 失败只 warn 不 fail，若无评测对比，降级可长期无感。**
  评测 runner 新增 `rerank_probe` 连通性探测，报告显式标记 rerank 是否真实生效。

### 发现 2（待校准）：ConfidenceAgent 在真实数据上 pass 误杀率 100%

- 默认配置（pass 0.8 / warn 0.5）下：21 条库内问题**全部判 warn**（overall 均值 0.756），pass 误杀率 = 100%。
  根因：qwen3-rerank 真实分数普遍 0.3~0.6（远低于 RRF 归一化近似分），单源问题多（2 篇论文），
  content_relevance 权重 0.3 被拉低。
- 阈值扫描结论（`eval/runners/calibrate-confidence.ts`）：
  - `passThreshold: 0.65` → 库内 pass 误杀率降为 0%（21/21 pass）；
  - 单源可靠性 0.6→0.75/0.8 也能部分改善，但不如直接降 pass 阈值有效；
  - **推荐组合：pass 0.65 + 单源系数 0.75**（configHash `98e6d9558768`），供 chat.module 注入校准。

### 发现 3（待修复）：ConfidenceAgent 的 fail 判定在真实链路上几乎不可能触发

- `preciseSearch` 有 lowConfidence 兜底（不足 1 条时取 Top1），`retrieveFact` 里
  `hasFactualBasis = hits.length > 0 && !lowConfidence` 已识别该信号，但传给
  `confidenceAgent.check(hits)` 的仍是兜底后的结果（≥1 条）→ fail 分支（`results.length===0`）永不触发。
- 实测：5 条库外问题全部判 warn 而非 fail，fail 召回率 = 0%。
- **修复方向**：`retrieveFact` 在 `lowConfidence=true` 时向 check() 传空数组（或新增显式 fail 信号），
  使库外问题正确落到 fail/reject 路径；该改动涉及生产行为，需评审后实施。

### 检索指标基线（修复 rerank 后）

| 指标 | hybridSearch | preciseSearch |
|---|---|---|
| Recall@3 / @5 / @20 | 0.731 | 0.731 |
| Precision@3 | 0.243 | 0.243 |
| MRR | 0.731 | 0.731 |
| nDCG@5 | 0.731 | 0.731 |

> 说明：评测集 26 条规模小且文件级标注（docId），Recall 与 MRR 同值属正常；
> **Precision@3=0.243 提示注入噪声大**（top_k=3 时仅约 0.7 条相关），是 fact 路径最值得优化的点
> （调低 rerank_threshold 会进一步推高噪声，需按 2.1 联合扫参验证）。

### 二·五追加：第二批计划落地（2026-08-11 下午）

| 计划项 | 状态 | 产出 |
|---|---|---|
| 生成层程序化校验 runner | ✅ | `eval/runners/run-generation-eval.ts`：引用正确率 / 拒答正确率 / 忠实度 embedding 代理（冒烟：引用 1.0、0 疑似幻觉） |
| rerank 阈值联合扫参 | ✅ | `eval/runners/scan-rerank-threshold.ts`：扫 0.5~0.85，同时记录无命中率 / lowConfidence 兜底率 / 置信度 warn/fail 占比 |
| 路由评测（intent 混淆矩阵） | ✅ | `eval/runners/run-intent-eval.ts`：三分类准确率 0.692 + clarify 冒烟 4/5 |
| trace 结构化埋点 | ✅ | `src/chat/rag-tracer.ts`：JSONL 落盘 `logs/rag_traces-YYYYMMDD.jsonl`，零阻塞、env 可关；chat.service 已在 routeAndRespond→dispatch→各 handler 埋点（retrieval / confidence_check / fallback / dimensions / breaker） |
| 置信度校准配置启用 | ✅ | `chat.module.ts` 注入 `pass 0.65 + 单源 0.75`（configHash `98e6d9558768`）；`RAG_CONFIDENCE_CALIBRATED=false` 可回退旧默认 |
| fail 判定链路修复 | ✅ | `handleFact`：`hasFactualBasis=false` 时向 check() 传空数组，库外问题正确落 fail/reject；含回归单测 |

**第二批实测发现（100 条评测集校对后修正）：**

1. **路由评测结论反转**：26 条时误判为"评测集标注问题"（0.692），扩到 100 条 + 排除库外硬编码样本后
   准确率 0.812。**17 条冲突逐条人工复核：评测集标注基本正确**，冲突分两类：
   - 15 条是**路由器触发词表缺词**（challenges/advantages/benefits/downsides/differences/为什么/局限性/相比
     等评价类词不在 perspective 触发词表，LLM 标 perspective 是对的）→ 修复方向：`perspective-analyzer.skill.md`
     补词（涉及生产行为，待评审后实施）；
   - 2 条是造集脚本硬编码问题（库外样本 intent 硬编码 fact）→ `run-intent-eval.ts` 已排除 `has_basis=false` 样本。
2. **阈值扫参的"无命中率"恒为 0**：因为 `preciseSearch` 的 lowConfidence 兜底保证结果永远 ≥1 条，
   **线上"无命中"观察指标应改用 lowConfidence 兜底率**（随阈值升高 0.19→0.39，是真实的权衡信号）。
3. **fail 修复验证（100 条）**：fail 召回率 **1.000（15/15 库外全 fail）**，远超 ≥90% 目标；
   pass 误杀率 0.106（76/85 pass）—— 9 条库内 lowConfidence 兜底被误杀，是 fail 修复引入的权衡
   （可接受：与其放过库外问题，不如对低置信库内问题更保守）。

**100 条评测集最终基线（retrieval-2026-08-11-large.jsonl）：**

| 指标 | hybridSearch | preciseSearch |
|---|---|---|
| Recall@3 | 0.81 | 0.81 |
| MRR@3 | 0.78 | **0.81** |
| nDCG@5 | 0.79 | **0.81** |

> **rerank 真实生效后，preciseSearch 的 MRR/nDCG 开始优于 hybridSearch**（26 条时两者相同是因为
> rerank 静默降级）。Precision@3 约 0.24~0.28 仍是噪声优化的主要方向。
> 路由准确率 0.812（库内），clarify 冒烟 4/5。
> 评测集相关说明与使用方法见 `eval/datasets/README-2026-08-11-large.md`。

### 二·五续：检索参数联合扫参结论（2026-08-11 晚 · 100 条集）

`eval/runners/scan-retrieval-params.ts` 扫 vectorWeight {0.5~0.9} × rerankThreshold {0.5~0.8} × topK {2,3,5}：

| 参数维度 | 影响 | 结论 |
|---|---|---|
| **topK** | **决定性**：topK=2 时 Precision@k **0.31 → 0.47（+52%）**，Recall@k 0.94 不掉 | **生产 top_k: 3 → 2 是最大优化杠杆** |
| **RRF 权重** | 几乎无影响：vw 0.5~0.9 结果基本一致 | 当前 2 篇论文库中向量/关键词高度重合，权重无区分度；扩库后可重扫 |
| **rerank 阈值** | 影响有限：thr 0.5~0.8 仅 Precision 0.31→0.29 | 当前 rerank 分数区分度不足，维持 0.75 可接受 |

> **推荐生产配置变更（需评审）**：`fact-retriever.skill.md` 的 `retrieval_config.top_k: 3 → 2`，
> 预计 Precision 提升约 50% 且 Recall 不掉。注意结论受限于"2 篇论文文件级标注"的数据集，
> 扩库后需重扫验证。

### 基建提速（2026-08-11 晚）
- **embedQuery 内存缓存**：相同 query 复用向量，评测/扫参提速明显（`RAG_EMBED_CACHE_SIZE` 默认 500）。
- **造集脚本 LLM 重试**：单批失败重试 2 次 + 退避（原 95 目标只成 53，丢批严重）。

### 二·六、Perspective 维度拆分召回的消融实验（2026-09-07 · 6 篇文档 865 chunk 库）

> 问题：评价类问题「拆成多个方面分别召回」（Perspective-Analyzer 核心设计）是否必要？
> 实验库：`docs/` 6 篇 PDF（Attention / Illustrated Transformer / RAG / MoE 综述 / LoRA-MoE / 面试题合集），
> 生产同款链路入库为集合 `_evalpersp0907`；评测集 `eval/datasets/perspective-2026-09-07.jsonl`
> （8 题 × 33 方面 × 38 个 chunk 级 gold 标记，标记经脚本校验真实存在）。
> Runner：`eval/runners/run-perspective-ablation.ts`、`eval/scripts/run-perspective-bplus.ts`、
> `eval/scripts/run-perspective-bpp.ts`；报告在 `eval/reports/perspective-ablation-*` / `perspective-bpp-*`。

**六路对比（方面覆盖率 = 34 个 gold 方面被命中的比例，8 题平均）：**

| 路径 | 说明 | 方面覆盖 | 标记召回 |
|---|---|---|---|
| A3 | 单路 top3（现 perspective 每维预算） | 0.125 | 0.113 |
| A12 | 单路 top12（等总预算 4 维 × 3） | 0.269 | 0.231 |
| **B** | **生产实现：LLM 拆维度 → 每维 top3** | **0.156** | 0.138 |
| B+ | 修复拆解稳定性 + 检索导向 prompt | 0.181 | 0.158 |
| B++ | 两阶段 corpus-aware（粗召回锚定 → 落地拆解 → 维内深挖） | 0.263 | — |
| D | 查询扩展后单路 top12（廉价替代） | 0.269 | 0.242 |
| C | oracle 维度（人工最优拆解，上限参考） | **0.725** | 0.692 |

**核心结论：**

1. **设计方向成立（C）：** 等预算等延迟下，理想的分维召回覆盖是单路的 2.7 倍；单路检索对评价类问题有
   结构性缺陷（embedding 平均化多方面查询，top-k 被单一话题簇占满，A3 平均只覆盖 1.25 篇文档）。
   **廉价替代不成立（D）：** 查询扩展 + 单路 top12 = 0.269，与 A12 持平——收益必须来自分路检索本身。
2. **当前生产实现（B）是负优化：** 0.156，低于直接把 topK 调到 12（0.269），还多花 1 次 LLM 拆解 + 多路延迟。
   病灶一：`splitDimensions` 高比例静默兜底（实测 7/8 落入"核心要点/局限与争议"通用模板，只 warn 不 fail，
   线上无感——与 rerank 静默降级同类问题）；病灶二：LLM 在不了解语料库时拆出的抽象疑问句够不到
   具体内容术语（load balancing / FLARE / DMEP 等）。
3. **两阶段 corpus-aware（B++）只能部分修复：** 粗召回 top20 → 材料片段喂给 LLM 落地拆解（query 必须
   引用材料原文术语）→ 维内深挖 top6，覆盖升至 0.263 ≈ 单路 top12，但仍远低于 oracle。
   残余差距主因是**拆解覆盖缺口**：gold 方面里包含"无法从问题推断其在库中存在"的内容
   （如 LoRA-MoE 剪枝论文、RAG 论文的 provenance 讨论），任何查询侧扩展都无法预知。
4. **选择阶段的两个实测陷阱（均有逐题证据）：**
   - **全局 rerank 对原问题精排会重新同质化**：p03 并集已覆盖 LoRA-MoE 方面（0.25），
     对原问题全局 rerank 取 top12 后被截丢（0.00）——把分维的多样性收益又丢掉了。Perspective 路径
     **不应做全局 rerank**，只能用维内配额。
   - **维内 rerank 同样有害**（p03/p04/p05 各丢 1 方面），gold chunk 常落在维内 RRF 第 4~6 位；
     RRF 顺序 + 维内配额 4 优于任何 rerank 方案。
5. **方差警告：** LLM 拆解 + DeepSeek 关键词抽取（默认温度）均有随机性，同题不同 run 覆盖在
   0.00~0.60 间波动（p02 三次得 0.20/0.40/0.60）。**8 题评测集太小，此类实验需同配置多次取平均。**

**给生产的建议（按性价比排序）：**

1. perspective 路径现状下直接用**单路 top12**，停用维度拆分（免费拿到 0.269 vs 0.156）。
2. 若保留分维设计（答案按维度组织的结构价值 + C 证明的上限），最低可用形态：
   粗召回锚定拆解（材料喂入 prompt）+ 维内深挖 top6 + RRF 顺序配额 4 + **禁止全局 rerank**；
   并先修 `splitDimensions` 的解析容错（response_format json_object 下模型偶尔返回非预期结构，
   当前静默兜底掩盖了它）。
3. 评测基建：perspective 类评测必须记录"粗召/并集/最终"漏斗断面，否则截断损失不可见。

### 二·七、三种召回范式的对比实验（2026-09-07 下午 · 同库同集）

> 问题：维度拆分召回 vs 经典多路召回 vs Karpathy Wiki（编译期综合），收益如何、怎么选？
> 同一份评测集（`perspective-2026-09-07.jsonl`，8 题 × 33 方面），同一个 865-chunk 实验库。
> Wiki 路径：`eval/scripts/compile-wiki.ts`（map-reduce，deepseek-v4-flash 编译，
> 6 文档 → 6 篇 4~10KB 文章 → 集合 `_evalwiki0907`），评测 `eval/scripts/run-wiki-eval.ts`。
> **口径差异（重要）**：wiki 是改写产物，无法匹配逐字 marker，改用「源文档归因 + 概念术语双语别名」
> （`perspective-wiki-terms.json`，38 项与 gold 一一对齐），比 raw 路径的逐字匹配略宽松。

| 路径 | 机制层面 | 方面覆盖 |
|---|---|---|
| A3 单路 top3 | 单查询单通道 | 0.125 |
| A12v 单向量 top12 | 单查询单通道 | 0.269 |
| A12 向量+关键词 RRF | **经典多路（通道侧）** | 0.269（**通道融合零增量**） |
| D 查询扩展后单路 | 查询侧改写 | 0.269 |
| B 生产维度拆分 | 查询侧多路（坏实现） | 0.156 |
| B++ 两阶段落地拆解 | 查询侧多路（好实现） | 0.263 |
| **W3 wiki 单路 top3** | **编译期综合** | **0.244** |
| **W12 wiki 单路 top12** | **编译期综合** | **0.400** |
| C oracle | 上限参考 | 0.725 |

**结论：**

1. **三种思路解决的是三种不同问题，正交可叠加：**
   - 经典多路召回（通道侧，同查询多通道）：治「单一通道表征偏差」。本库实测**零增量**
     （向量/关键词高度重合，与 08-11 扫参结论一致）——但它便宜，作为默认无妨，别指望它补覆盖。
   - 维度拆分（查询侧，同通道多查询）：治「单一查询语义覆盖不足」。上限真实（C=0.725）
     但实现极难兑现（B=0.156，B++=0.263）。
   - Wiki（时间侧，编译期综合）：治「原始语料碎片化」。把方面综合从查询时挪到入库时，
     **单路 top12 即 0.400（全场非 oracle 最佳），top3 就追平 raw top12（0.244 vs 0.269，省 3/4 token）**。
2. **Wiki 的代价与风险（实测）**：编译损耗——d03（316 页异质面经）压成 5800 字后
   FLARE/RoPE/MQA/RAG V.S. SFT 等具体小节全部丢失，p04 在 wiki 上 0 覆盖；
   时效性——知识停留在上次编译；逐字引用/溯源能力丧失（改写产物）。
   编译模型用更强的（本次为 flash）可部分缓解保真问题。
3. **选型建议（分层架构）：**
   - **Fact 路径**：必须留 raw chunk 精搜（逐字引用与溯源 wiki 替代不了）；
   - **Perspective 路径**：优先走 wiki 层单路检索（收益最高、最省 token、答案天然有结构）；
     wiki 未覆盖的新文档/长尾内容落回 raw 单路 top12；
   - **维度拆分**：降级为「答案结构化」的可选增值层，不做召回主力；若启用，必须用
     B++ v3 形态（落地拆解 + 维内深挖 + 维内配额 + 禁全局 rerank）；
   - **经典多路**：保持默认开启（成本可忽略），但不作为覆盖问题的解法。
4. **Wiki 在本项目的落地形态**：上传/编译异步化（入库后后台编译 wiki 文章入独立集合），
   查询期按意图路由——fact → raw 集合，perspective → wiki 集合（miss 时降级 raw）。
   Karpathy skill 的 lint/grounding-invariant 机制可直接复用为 wiki 层的质量门禁。

---

## 三、在线监控（生产侧）

### 3.1 结构化埋点

在 `chat.service.ts` 关键节点写**结构化 JSON 日志**（替换/补充现在的 `console.log`），每轮对话一条 trace：

```json
{
  "trace_id": "uuid", "user_id": "...", "session_id": "...", "ts": 1723113600,
  "intent": "fact", "route_confidence": 0.86,
  "internal_strategy": "hybrid",
  "retrieval": {"candidates": 20, "after_rerank": 8, "above_threshold": 3,
                 "top_scores": [0.89, 0.81, 0.76], "latency_ms": 320,
                 "rerank_used": true},
  "confidence_check": {
    "check_result": "pass|warn|fail", "overall_confidence": 0.87,
    "dimension_scores": {"source_reliability": 0.85, "content_relevance": 0.9,
                          "citation_completeness": 1.0, "cross_source_consistency": 0.8},
    "warnings": [], "action": "proceed"
  },
  "fallback_count": 0, "breaker_action": "none|reject",
  "dimensions": [{"name": "...", "status": "completed|timeout|error", "tokens": 380}],
  "llm": {"model": "qwen3.7-plus", "prompt_tokens": 2100, "completion_tokens": 450,
           "latency_ms": 4300, "ttft_ms": 900},
  "feedback": null
}
```

> `confidence_check` 字段直接来自 `ConfidenceAgent.check()` 的返回值，**不需要额外计算**。
>
> **落库现状（2026-08-11 已实现双通道）**：
> - JSONL（默认）：`logs/rag_traces-YYYYMMDD.jsonl`，线上已有真实数据（77+ 条，字段完整）；
> - MongoDB：`rag_traces` 集合（`src/chat/rag-trace.schema.ts`，strict:false 宽松结构 + trace_id/ts/user_id/session_id/intent 索引），
>   由 `RagTraceSink` 在 ChatModule 启动时注册为 sink，`flush()` 异步 fire-and-forget 写入，失败仅 warn 不阻塞；
>   环境变量 `RAG_TRACE_MONGO=false` 可关 Mongo 通道（JSONL 始终保留为降级）。端到端落库已验证。

### 3.2 线上监控指标盘

**质量类（无需人工标注，从 trace 直接算）：**

| 指标 | 告警参考线 |
|---|---|
| `has_factual_basis=false` 占比（无命中率） | > 30% 说明知识库覆盖不足或检索劣化 |
| Fallback 熔断 reject 触发率 | > 5% 需排查 |
| Rerank top1 score 分布（P50/P90） | P50 持续下降 → embedding/文档漂移 |
| Confidence fail 占比 / warn 占比 | fail > 5% 或 warn > 15% 需排查（基线由 2.4 校准后确定） |
| 维度 timeout/error 率（Perspective） | > 10% 检查子 Agent 8s 超时是否过紧 |
| Clarify 触发率 + pending 确认转化率 | 转化率 < 40% 说明反问质量差 |

**性能/成本类：**

- 端到端延迟 P50/P95/P99、TTFT（首 token）、检索延迟、LLM 延迟分层。
- 每轮 token 消耗（分 intent：perspective 预算 2000，实际是否超）。
- 每会话成本估算 = tokens × 单价。

**看板落地**：轻量做法 —— Grafana + 定时聚合脚本读 `rag_traces`；或先做一个内部 `/admin/metrics` 接口 + 简单前端页。

### 3.3 用户反馈闭环（补标注数据）

- 前端回答末尾加 👍/👎，写回 trace 的 `feedback` 字段。**注：前端反馈目前尚未实现（已确认代码中无该交互），属 P2 范围。**
- 👎 样本自动进入"待标注池"，每周人工看 10 条，归因到：检索漏 / 路由错 / 生成幻觉 / 知识库缺内容 —— 这是线上坏例驱动评测集扩增的飞轮。
- **飞轮先行项（无需等前端）**：无命中率、Confidence fail 率、熔断触发率等**无需人工标注的指标**，
  在 trace 落库后即可驱动坏例筛选池转起来（见 2.4 步骤 2 的输入来源）。

### 3.4 漂移与回归监控

- 每周定时任务：用检索评测集对线上服务跑一遍 Recall@5，指标突降 → 报警（可能原因：embedding 模型变更、Milvus 集合异常、文档切片逻辑改动）。
- 监控知识库增长与问题主题的匹配度（query 聚类 vs 文档聚类）。

---

## 四、评测体系分层与复用（v2 新增）

评测体系**不是一个单体模块，而是四层可独立复用的资产**。新增业务模块（如新意图/新工具/新检索路径）时，
只改 L0 和 L1，L2/L3 直接复用：

| 层 | 内容 | 复用性 | 说明 |
|---|---|---|---|
| **L0 业务绑定层** | 评测 runner：`@nestjs/testing` 注入 `FileanagementService` + `ConfidenceAgent`，直接调 Service 跑批，不走 HTTP | 不可复用 | 依赖本项目 Milvus 集合 / MongoDB / Nest 模块注入；复用 `test-mocks/milvus-sdk.stub.ts` 可离线 mock 跑 |
| **L1 评测集层** | JSONL 数据集 + 版本管理 + 造集工具（LLM 反向生成 + 人工校对） | 半复用 | relevant_chunks 标注的是 Milvus chunkId，换库需重标；schema/流程可迁移 |
| **L2 指标函数层** | 纯函数：Recall@k / Precision@k / MRR / nDCG / HitRate / 引用校验 / 拒答判定 | **高复用** | 输入 `(rankedIds, relevantIds)` 输出分数，与 RAG 实现完全解耦；新检索路径直接调用 |
| **L3 运行时信号层** | `ConfidenceAgent` 分数 + `preciseSearch` 统计 | **已是资产** | 线上与离线评测共用同一套信号，不重复建设 |

**技术选型（v2 修订）**：全部 TS + Jest。项目已有 `*.spec.ts` 测试基建与 Milvus SDK stub，无需引入 Python/RAGAS 双栈；
`npm run eval` 与 `npm run eval:ci` 作为新 scripts 加入 package.json。

---

## 五、实施路线（v2 重排：最小闭环先行）

| 阶段 | 内容 | 工作量估计 |
|---|---|---|
| **P0 最小闭环** | ① 建 `nest-serve/eval/` 骨架（datasets/ + metrics/ + runners/）② L2 指标纯函数库 + Jest 单测 ③ 造 50~100 条检索评测集（含 20 条库外，带 has_basis 标注）④ 跑 preciseSearch vs hybridSearch 对比 + rerank 阈值扫参 | 2~3 天 |
| **P0 并行** | 结构化 trace 埋点（含 `confidence_check` 字段）落 `rag_traces`，改动集中在 chat.service.ts | 1 天 |
| **P1** | 置信度模块自评测（fail 召回率 / pass 误杀率）+ 魔法数字校准；rerank 阈值 × 置信度边界联合扫参；生成层程序化校验（引用/拒答/忠实度代理） | 3~4 天 |
| **P2** | 👍/👎 反馈闭环（含前端）+ 无命中率/熔断率/fail 率日报；LLM-as-Judge 抽样复核；CI 回归门禁 + 每周定时回归 + Grafana 看板 | 2~3 天 |

**核心原则**：

1. **先有埋点和评测集（P0），否则后面所有指标都无从谈起**；
2. **能用代码判定的指标绝不用模型** —— LLM 只做抽样复核，不进 CI 门禁；
3. **所有"魔法数字"（rerank_threshold、top_k、置信度阈值/权重/单源多源系数）都必须经评测集验证后才允许改**；
4. **置信度模块既是信号源，也要被评测** —— 它的 fail/pass 判定质量本身就是一条关键指标。
