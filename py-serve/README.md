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
├── scripts/                # 运维脚本（reindex_kb.py 重建索引）
├── uploads-image/          # 对话图片上传目录（/open-image 静态服务）
├── eval/                   # 召回评测体系（详见 eval/README.md）
└── app/                    # 按业务垂直切分，包内再分 router / schemas / service
    ├── main.py             # FastAPI 入口（CORS、静态目录、异常处理）
    ├── core/               # 公共基础设施（跨业务复用）
    │   ├── config.py       #   环境配置
    │   ├── deps.py         #   JWT 认证 + Mongo/Redis 连接
    │   └── response.py     #   统一响应包装
    ├── userinfo/           # 注册 / 登录（HMAC-SHA256 密码 + JWT）
    │   ├── router.py
    │   ├── schemas.py      #   请求体校验（手机号 / 密码规则）
    │   └── service.py      #   用户表读写 + 密码校验 + 签发 JWT
    ├── file_management/    # 文件上传解析、切片向量化、混合检索、图片
    │   ├── router.py       #   接口层
    │   ├── schemas.py      #   请求体定义
    │   ├── service.py      #   上传/删除/列表/向量/关键词/混合检索（RRF）
    │   ├── splitter.py     #   递归字符切片（800/100，对齐 LangChain）
    │   ├── structure.py    #   论文结构识别 + 父子切分（章节 / 页码 / 段序 / 字符区间）
    │   ├── sections.py     #   父文档（章节）落库与按 parentId 批量回表
    │   ├── parsers.py      #   PDF / DOCX 文本抽取（PDF 同时返回每页起始偏移）
    │   ├── embeddings.py   #   通义 embedding（批量 10 条 + 查询缓存）
    │   ├── milvus_store.py #   Milvus 集合操作（每用户一个集合）
    │   ├── keywords.py     #   关键词提取（DeepSeek → 规则降级）
    │   └── image_storage.py#   图片落盘 / 魔数校验 / 路径防护
    └── chat/               # 对话（流式 SSE 协议）
        ├── router.py       #   接口层：流式问答 + 会话管理
        ├── schemas.py      #   请求体定义
        ├── service.py      #   编排：组合消息 → 意图改写 → 检索回答 → 落库
        ├── llm.py          #   模型调用（文本对话 / 多模态图片理解）
        ├── retrieval.py    #   知识库检索问答（queryKb）
        ├── session.py      #   会话创建 / 历史缓存 / 落库
        ├── stream.py       #   SSE 流式写端
        └── prompts.py      #   系统提示词 + 意图识别工具（clarify_intent）
```

## RAG 主链路

1. `POST /chat/sendmessage`（`isKnowledgeBased=true`）：
   第一轮调用 DeepSeek，强制触发「意图识别」工具（`clarify_intent`）→ 续问改写为完整检索问题；
2. 混合检索：问题向量化 → Milvus 向量检索（COSINE）+ 关键词 LIKE 检索 → RRF 融合（0.7/0.3，k=60），Top5；
   Top5 子块按 `parentId` 聚合去重，回表 MongoDB `file_sections` 取父章节，
   以「子块 ± 600 字、单片段上限 2400 字」的有界窗口注入（子块负责召回，父章节负责上下文完整）；
3. 第二轮调用：注入「知识库问答规则」层，基于【片段N·文件名·章节·第X页】格式的检索结果流式回答，
   规则要求模型在依赖片段的结论后标注 `[N]`；
4. 溯源：检索结果同时生成 `citations`（文档、章节、页码、段序、片段摘录），随 `queryKB` 事件下发并写入消息；
   前端把正文里的 `[N]` 渲染成可点击角标，点击定位到「参考来源」卡片；
5. 无命中时发送占位符 `&没有检索到相关文档&`，由提示词规则控制兜底话术。

切片侧（`file_management/structure.py`）按论文一级章节断开，并记录每个 chunk 的
章节路径、起始页、章节内段序和全文字符区间；章节本身作为父文档存入 `file_sections`，
子块通过 `parentId` 关联，因此回答里的 `[N]` 既能回指原文位置，也能在生成时补全上下文。

流式协议：标准 SSE（`Content-Type: text/event-stream`，帧格式 `data: <json>`、空行分隔），
消息类型有 `sessionId` / `readDocument` / `queryKB` / `answer` / `error`。
协议选型与改造说明见 [design/05](../design/05-流式协议SSE改造.md)。

## 索引版本升级

Milvus 不支持给已有集合加列，v3（新增 parentId）上线时集合名改为 `_<userId>_v3`（旧集合保留不删）。
升级后存量知识库需要重建一次索引（会同时重建父章节 `file_sections`）：

```bash
python scripts/reindex_kb.py                 # 全部用户
python scripts/reindex_kb.py --user-id xxx   # 单个用户
python scripts/reindex_kb.py --prune-legacy  # 重建成功后删除该用户的旧版本集合
```

脚本从 MongoDB 的 `fileText` / `pageStarts` 重建，与新上传文件使用同一套切片逻辑；
`--prune-legacy` 只删除 `_<userId>` / `_<userId>_v1...` 这类旧集合，评测集合 `_evalcorpus` 不受影响。

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
