# py-serve — Python 后端（FastAPI · DeepSeek · 朴素 RAG）

本仓库唯一后端（原 NestJS 版 `nest-serve/` 已移除，py-serve 为其 Python 重写版，
接口路径、流式协议、数据结构完全对齐，前端 `project-user/` 无需任何改动）。

## 技术栈

- FastAPI + uvicorn（端口 3000，前端无需改配置）
- MongoDB（pymongo async）+ Redis（redis-py async）+ Milvus（pymilvus）
- **DeepSeek `deepseek-flash`**：对话生成、图片理解（自带多模态）、检索关键词提取
  - 注意：thinking 模式不支持强制 `tool_choice`，意图识别强制调用工具时已显式关闭
  - 注意：DeepSeek 工具函数名只允许 ASCII（`^[a-zA-Z0-9_-]+$`），意图识别工具名为 `clarify_intent`
- 通义千问 `text-embedding-v3`（向量化，1024 维；DeepSeek 不提供 embedding API，此项保留通义）

## 目录

```
py-serve/
├── docker-compose.yml      # 基础设施：mongo / redis / milvus(etcd+minio)
├── requirements.txt
├── .env                    # DeepSeek key + Qwen key + 基础设施地址
├── run.py                  # 启动入口
├── uploads-image/          # 对话图片上传目录（/open-image 静态服务）
├── eval/                   # 召回评测体系（详见 eval/README.md）
└── app/
    ├── main.py             # FastAPI 入口（CORS、静态目录、异常处理）
    ├── config.py           # 环境配置
    ├── deps.py             # JWT 认证 + Mongo/Redis 连接
    ├── response.py         # 统一响应包装
    ├── userinfo/           # 注册 / 登录（HMAC-SHA256 密码 + JWT）
    ├── fileanagement/      # 文件上传解析、切片向量化、混合检索、图片
    │   ├── splitter.py     #   递归字符切片（800/100，对齐 LangChain）
    │   ├── parsers.py      #   PDF / DOCX 文本抽取
    │   ├── embeddings.py   #   通义 embedding（批量 10 条 + 查询缓存）
    │   ├── milvus_store.py #   Milvus 集合操作（每用户一个集合）
    │   ├── keywords.py     #   关键词提取（DeepSeek → 规则降级）
    │   └── service.py      #   上传/删除/列表/向量/关键词/混合检索（RRF）
    └── chat/               # 对话（流式 ###ABC### 协议）
        ├── prompts.py      #   系统提示词 + 意图识别工具（clarify_intent）
        └── service.py      #   朴素 RAG：意图改写 → 混合检索 → 知识库规则回答
```

## RAG 主链路

1. `POST /chat/sendmessage`（`isKnowledgeBased=true`）：
   第一轮调用 DeepSeek，强制触发「意图识别」工具（`clarify_intent`）→ 续问改写为完整检索问题；
2. 混合检索：问题向量化 → Milvus 向量检索（COSINE）+ 关键词 LIKE 检索 → RRF 融合（0.7/0.3，k=60），Top5；
3. 第二轮调用：注入「知识库问答规则」层，基于【片段N·文件名】格式的检索结果流式回答；
4. 无命中时发送占位符 `&没有检索到相关文档&`，由提示词规则控制兜底话术。

流式协议：JSON 块以 `###ABC###` 分隔，类型有
`sessionId` / `readDocument` / `queryKB` / `answer` / `error`。

## 启动

```bash
# 1. 基础设施（首次会拉起 mongo/redis/milvus 容器）
docker compose up -d

# 2. 安装依赖（建议 venv）
python -m venv .venv && .venv/Scripts/activate
pip install -r requirements.txt

# 3. 启动后端（端口 3000）
python run.py

# 4. 前端（项目根 project-user/）
npm run dev
```

## 评测

`eval/` 下是一套自包含的召回评测体系，当前核心实验：
**chunk 向量直接检索 vs QA 问题检索（每个 chunk 用模型预生成多个问题，检索时问题对问题匹配，
命中问题即召回其源 chunk）vs 两者融合**，指标 Recall@k / MRR@5，结论见 `eval/README.md`。

```bash
python eval/scripts/dump_chunks.py        # 1. 从 Milvus 拉取真实 chunk 作语料
python eval/scripts/gen_qa_index.py       # 2. 每个 chunk 生成索引问题并向量化
python eval/scripts/gen_eval_queries.py   # 3. 用另一个模型生成用户风格测试问题（金标=源 chunk）
python eval/scripts/run_recall_eval.py    # 4. 跑五个检索臂对比，输出指标
```
