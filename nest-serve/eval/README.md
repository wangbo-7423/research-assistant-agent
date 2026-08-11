# eval/ —— 离线评测体系（P0 最小闭环）

RAG 评测体系的落地代码，按 L0~L3 分层（详见仓库根目录 RAG_EVALUATION_DESIGN.md）。

## 目录结构

```
eval/
├── jest.config.js            # eval 独立 jest 配置（主配置 rootDir=src 扫不到这里）
├── datasets/                 # L1 评测集（JSONL，文件名带版本日期）
│   └── retrieval.example.jsonl
├── metrics/                  # L2 指标函数层（纯函数，与 RAG 实现解耦）
│   ├── retrieval-metrics.ts
│   └── retrieval-metrics.spec.ts
├── runners/                  # L0 业务绑定层（注入本项目 Service 跑批）
│   └── run-retrieval-eval.ts # 检索对比实验：preciseSearch vs hybridSearch
└── scripts/
    └── build-retrieval-set.ts # 造集：抽 chunk → LLM 反向生成问题 → JSONL
```

## 运行

```bash
# 指标函数单测
npm run eval:test

# 检索对比评测（需真实环境：Milvus + QWEN_API_KEY + 数据集）
npm run eval:retrieval -- --dataset eval/datasets/retrieval-2026-08-11.jsonl
```

## 评测集格式（JSONL）

```json
{"qid": "r001", "query": "注意力机制的定义是什么", "relevant_chunks": ["chunkId_a", "chunkId_b"], "intent": "fact", "has_basis": true}
{"qid": "r002", "query": "本库没有的主题 xxx", "relevant_chunks": [], "intent": "fact", "has_basis": false}
```

- `relevant_chunks`：Milvus 里该问题相关 chunk 的 docId（或 docId::docText 前缀键），空数组 = 库外问题。
- `has_basis`：该问题在知识库中是否有可靠依据（供 ConfidenceAgent 自评测用）。
