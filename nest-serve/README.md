# nest-serve — AI 科研助手后端服务

> AI_Coder 项目的后端服务：一个基于 **NestJS 11** 的科研知识库问答（RAG）平台。
> 支持文档 / 图片多模态输入、Milvus 向量检索 + BM25 混合检索（RRF 融合）、
> 四工具意图路由 RAG 架构，以及 `###ABC###` 分隔的流式响应。

前端仓库：[`project-user/`](../project-user)（Vue 3.5 + Vite + Element Plus）

---

## 目录

- [项目简介](#项目简介)
- [技术栈](#技术栈)
- [核心特性](#核心特性)
- [系统架构](#系统架构)
- [四工具 RAG 架构](#四工具-rag-架构)
- [目录结构](#目录结构)
- [API 接口](#api-接口)
- [流式协议](#流式协议)
- [数据存储](#数据存储)
- [环境变量](#环境变量)
- [快速开始](#快速开始)
- [测试](#测试)
- [安全设计](#安全设计)
- [相关文档](#相关文档)

---

## 项目简介

本项目是前后端分离的 **AI 对话式科研辅助平台** 的后端部分，围绕论文、报告等科研文档构建个人知识库，提供：

- 知识库检索问答（向量语义检索 + 关键词检索 + RRF 融合排序）
- 文档解读（PDF / DOCX 上传后自动解析、切片、向量化）
- 图片理解（PNG / JPEG / WebP 多模态问答）
- 多轮科研对话（会话管理、上下文缓存、流式输出）

后端采用 NestJS 分层模块化架构（`Module → Controller → Service → Schema`），
集成 MongoDB、Redis、Milvus 三大存储，并通过 JWT 认证、全局管道 / 过滤器 / 拦截器构建纵深防御体系。

---

## 技术栈

| 层级 | 技术 | 说明 |
|------|------|------|
| 框架 | NestJS 11 | TypeScript 5.7，模块化分层架构 |
| 数据库 | MongoDB | Mongoose 9 ODM，持久化用户 / 会话 / 文件元数据 |
| 缓存 | Redis | ioredis，会话上下文缓存（最近 3 轮）与 RAG 状态存储 |
| 向量库 | Milvus | `@zilliz/milvus2-sdk-node`，按用户维度建集合，向量检索 |
| 文档解析 | LangChain | `PDFLoader` / `DocxLoader` + `RecursiveCharacterTextSplitter` |
| 大模型 | 通义千问（DashScope） | OpenAI 兼容接口，文本 / 视觉双模型（模型名可配置） |
| Embedding | `text-embedding-v3` | 1024 维向量化 |
| Rerank | `qwen3-rerank` | `/reranks` 兼容端点精排，失败自动降级 RRF |
| 认证 | JWT | `@nestjs/jwt` + Passport 策略 + 全局 AuthGuard |
| 校验 | class-validator | 全局 ValidationPipe（whitelist 模式） |
| 日志 | 自定义 Logger | 文件输出，无时间戳前缀 |

---

## 核心特性

1. **三级混合检索（RRF）**：向量语义检索 + BM25 关键词检索 + RRF 融合排序，兼顾语义理解与精确匹配。
2. **四工具 RAG 意图路由**：`clarify / fact / perspective` 三态分类 + 服务端内部 `hybrid` 组合策略（见下文专章）。
3. **SSE 流式响应**：`###ABC###` 自定义分隔符逐块推送，前端实时渲染打字机效果。
4. **多模态自动路由**：纯文本 → 文本模型；含图片 → 视觉模型，无需前端指定。
5. **三层上下文管理**：Redis 近 3 轮缓存 + 知识库召回片段 + 上传文档全文，在 system prompt 层融合。
6. **Skill 渐进式披露**：工具以 `YAML 头 + Markdown 正文` 组织，首轮路由只读 YAML（约 200 tokens），调用时才加载完整 Prompt。
7. **纵深安全防护**：JWT + HMAC 密码 + 文件魔数校验 + 路径遍历防护 + 全局异常过滤。
8. **RAG 重构可灰度**：`RAG_REFACTOR_ENABLED` feature flag 切换新旧链路，旧代码保留兜底。

---

## 系统架构

```
用户请求
   │  HTTP / 流式 POST
   ▼
┌──────────────────────────────────────────────────┐
│              AppModule（根模块）                   │
│  ConfigModule · MongooseModule · RedisModule      │
│  JwtModule（全局）                                 │
├──────────────┬──────────────────┬────────────────┤
│ UserinfoModule│ FileanagementModule│  ChatModule  │
│ 注册 / 登录   │ 上传·解析·向量化·检索│  对话核心     │
│ （独立）      │ （导出 Service）   │（依赖 File）   │
└──────────────┴──────────────────┴────────────────┘
                             │
                             ▼
                 ┌─────────────────────────┐
                 │  ChatService            │
                 │  RAG_REFACTOR_ENABLED ? │
                 │   ┌─ 是：四工具路由      │
                 │   └─ 否：旧线性流程      │
                 └─────────────────────────┘
```

模块间为**单向无环依赖**：`ChatModule → FileanagementModule`，`UserinfoModule` 独立。

### 全局基础设施（main.ts 注册）

| 设施 | 实现 | 作用 |
|------|------|------|
| 校验管道 | `ValidationPipe`（whitelist + forbidNonWhitelisted） | 自动校验 DTO |
| 异常过滤器 | `utils/all-exception.filter.ts` | 统一返回 `{statusCode, message, timestamp, path}` |
| 响应拦截器 | `utils/transform.interceptor.ts` | 成功响应包装为 `{statusCode:200, message:'请求成功', data, ...}` |
| 静态资源 | `/open-image` → `uploads-image/` | 图片存储对外暴露 |
| 端口 | `PORT` 环境变量（默认 3000） | 应用监听端口 |

---

## 四工具 RAG 架构

> 完整设计文档见 [`src/chat/RAG_REFACTOR_DESIGN.md`](src/chat/RAG_REFACTOR_DESIGN.md)（含设计动机、隐忧防护、代码骨架）。
> 本节描述当前代码已落地的实现。

### 意图路由（三态 + 内部 hybrid）

用户可见的路由结果**只有三种**：`clarify / fact / perspective`；
`hybrid` 是服务端内部的组合优化策略，对用户完全透明（审查项 R1）。

```
用户输入
   │
   ▼
IntentRouter.classifyIntent()  ── 只读 skill 的 YAML 头 triggers
   │
   ├─ 模糊 / 过短 / 续问（≤5字、然后呢、咋整…） ──→ clarify（不走 RAG）
   │
   ├─ 事实类（是什么 / 谁 / 何时 / 多少…）      ──→ fact（强绑定 RAG）
   │
   ├─ 评价类（怎么看 / 意味着 / 优缺点…）      ──→ perspective（松耦合 RAG）
   │
   └─ 同时命中 fact + perspective 且有实体     ──→ hybrid（内部策略）
         └─ Fact 先行 → 结果注入 Perspective 各子 Agent，避免重复检索（R4）
```

关键实现（`routers/intent-router.ts`）：

```typescript
export type IntentType = 'clarify' | 'fact' | 'perspective';
export type InternalStrategy = 'single' | 'hybrid';  // 仅服务端内部使用
```

### 工具定义：Anthropic Skill 模型

每个工具为一个 `.skill.md` 文件，采用**渐进式披露**结构：

```markdown
---
name: 工具名
version: "1.0"
category: intent_router | rag_strong | rag_loose | post_process
triggers:
  keywords: [...]
  patterns: [...]
rag_binding: "none" | "strong" | "loose"
token_budget: number
---
# Markdown 正文：Prompt 指令 + 示例（调用时才加载）
```

| 工具 | 文件 | 类别 | 职责 |
|------|------|------|------|
| Clarify | `tools/clarify.skill.md` | 意图路由 | 上下文派生候选实体，自然语言反问；实体封闭性硬约束 |
| Fact-Retriever | `tools/fact-retriever.skill.md` | 强绑定 RAG | 单路精搜 Top3 + 阈值 0.75 + 必附出处，无命中降级通用知识 |
| Perspective-Analyzer | `tools/perspective-analyzer.skill.md` | 松耦合 RAG | 拆 2~4 维度并行子 Agent 检索，流式聚合，单维 400 token 浓缩 |
| Confidence-Checker | `tools/confidence-checker.skill.md` | 后处理 | 自动触发校验依据，输出可执行动作（pass / warn / fail） |

### Skill 加载器（`tools/skill-loader.ts`）

- **启动加载元数据**（约 50ms），调用时懒加载完整 Prompt；
- **Schema 校验**：必填字段、值域、token 预算合理性检查；
- **容错降级**：单文件 YAML 解析失败 → 从文件名反推基础配置（degraded）→ 再失败用内置精简 Prompt，**永不崩溃、不阻塞启动**；
- **健康检查**：`GET /chat/skills/health` 返回总数 / 正常 / 降级明细（供运维监控）。

### 检索链路（Fact 路径）

```
Query → 实体提取 → Embedding → Milvus 向量搜索（候选 20）
                                   ↓
                        Rerank 精排（qwen3-rerank）
                                   ↓
                    阈值过滤（≥ 0.75）→ Top 3 + 原文出处
                                   ↓
                  Confidence-Checker 校验 → 结构化事实结果
```

> Rerank 调用失败 / 未配置时自动降级为 RRF 融合分近似，检索链路不中断。
> Rerank 模型与端点可用 `DASHSCOPE_RERANK_MODEL` / `DASHSCOPE_RERANK_ENDPOINT` 覆盖。

### 隐忧防护机制（已落地）

| 机制 | 说明 |
|------|------|
| Clarify 防死循环（R2） | 会话状态机 `pendingConfirmation`（TTL 3 轮 / 60s），"是/对"映射最高置信度候选项，前端无感知 |
| Fact 连续 Fallback 熔断（P4） | 连续 2 次 fallback 后第 3 次拒绝并引导上传文档（按 userId 计数，命中即重置） |
| Perspective Token 预算（P5） | 单维 400 token 硬上限，超限用轻量模型摘要浓缩 |
| 子 Agent 超时熔断（P1） | 每维 8s 超时、每维 Top3 硬限制、`max_recursion_depth: 1` |
| hybrid 内部化（R1/R4） | 用户永远只看到三态；Fact 结果作为 system prompt 注入子 Agent |

---

## 目录结构

```
nest-serve/
├── src/
│   ├── main.ts                    # 入口：管道/过滤器/拦截器/静态资源注册
│   ├── app.module.ts              # 根模块（Config/Mongoose/Redis/Jwt + 业务模块）
│   ├── auth/
│   │   └── auth.guard.ts          # JWT Bearer 认证守卫
│   ├── chat/                      # 对话核心模块
│   │   ├── chat.controller.ts     # sendmessage(sse) | sessionlist | history | deletesession | skills/health
│   │   ├── chat.service.ts        # 四工具路由 + 流式响应 + 上下文管理（约 1100 行）
│   │   ├── chat.schema.ts         # MongoDB ChatData Schema
│   │   ├── chat.dto.ts            # 请求校验 DTO
│   │   ├── chat.d.ts              # 类型定义
│   │   ├── roleDefinition.ts      # 渐进式提示词体系（核心层→规则层→工具层）
│   │   ├── tools.ts               # Function Tool 定义
│   │   ├── RAG_REFACTOR_DESIGN.md # RAG 重构设计文档
│   │   ├── routers/
│   │   │   └── intent-router.ts   # 意图路由器（三态 + hybrid 判定 + pending 状态机）
│   │   ├── agents/
│   │   │   ├── sub-agent.ts       # 子 Agent（Perspective 维度检索）
│   │   │   └── confidence-agent.ts# 置信度检验 Agent
│   │   └── tools/
│   │       ├── clarify.skill.md   # Tool 1
│   │       ├── fact-retriever.skill.md
│   │       ├── perspective-analyzer.skill.md
│   │       ├── confidence-checker.skill.md
│   │       └── skill-loader.ts    # Skill 加载器（YAML 解析 + 渐进披露 + 容错）
│   ├── fileanagement/             # 文件管理模块
│   │   ├── fileanagement.controller.ts  # 上传/搜索/删除/列表接口
│   │   ├── fileanagement.service.ts     # 解析/切片/向量化/Milvus/混合检索（约 900 行）
│   │   ├── fileanagement.schema.ts
│   │   ├── fileanagement.dto.ts
│   │   └── image-storage.ts       # 图片存储：UTF-8 修复、魔数校验、路径防护
│   ├── userinfo/                  # 用户模块（HMAC 密码 + JWT 签发）
│   └── utils/
│       ├── all-exception.filter.ts
│       ├── transform.interceptor.ts
│       └── no-timestamp-logger.ts
├── uploads/                       # 文档上传目录
├── uploads-image/                 # 图片存储目录（/open-image 静态暴露）
├── logs/                          # 文件日志目录
├── .env                           # 环境变量（不入库）
└── package.json
```

---

## API 接口

### 用户模块（`/userinfo`）

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/userinfo/registeruser` | 注册（手机号 + 密码，HMAC 加密） |
| POST | `/userinfo/loginuser` | 登录，签发 JWT |

### 文件模块（`/fileanagement`）

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/fileanagement/knowledge` | 上传文件至知识库（解析 → 切片 → 向量化） |
| POST | `/fileanagement/dialog` | 上传文件至当前会话 |
| POST | `/fileanagement/uploadimage` | 上传图片 |
| GET  | `/fileanagement/kbfilelist` | 获取知识库文件列表 |
| DELETE | `/fileanagement/knowledge/:id` | 删除知识库文件 |
| POST | `/fileanagement/search` | 向量检索接口 |

### 对话模块（`/chat`，全部 AuthGuard 保护）

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/chat/sendmessage` | 发送消息（流式，`###ABC###` 分隔） |
| GET  | `/chat/sessionlist` | 会话列表 |
| GET  | `/chat/history?sessionId=...` | 会话历史 |
| DELETE | `/chat/deletesession?sessionId=...` | 删除会话（清理 MongoDB + Redis） |
| GET  | `/chat/skills/health` | Skill 加载健康检查（运维用） |

---

## 流式协议

`POST /chat/sendmessage` 返回 `text/event-stream` 风格的流，数据块以 **`###ABC###`** 为 JSON 分隔符：

```
data: {"type":"sessionId","sessionId":"..."}###ABC###
data: {"type":"readDocument","content":"正在解析文档..."}###ABC###
data: {"type":"queryKB","content":"正在检索知识库..."}###ABC###
data: {"type":"answer","content":"..."}###ABC###
data: {"type":"error","content":"..."}###ABC###
```

| 事件类型 | 说明 |
|---------|------|
| `sessionId` | 新会话 ID（首帧） |
| `readDocument` | 文档阅读进度提示 |
| `queryKB` | 知识库检索进度提示 |
| `answer` | 助手回复内容（可多帧，前端拼接） |
| `error` | 错误信息 |

> ⚠️ 注意：`readDocument` / `queryKB` 为**单槽位覆盖式**事件——文件列表只能作为最后一帧发送一次，不能交错推送。

---

## 数据存储

| 存储 | 用途 | 关键结构 |
|------|------|---------|
| MongoDB | 持久化 | `Userinfo`（用户）、`ChatData`（会话/消息）、`Fileanagement`（文件元数据） |
| Redis | 会话缓存 / RAG 状态 | Hash 存近 3 轮对话；clarify pending 状态、fallback 计数器 |
| Milvus | 向量检索 | 按 `_userId` 建 Collection，存储文本片段向量 |
| 本地文件系统 | 图片存储 | `uploads-image/`，经 `/open-image` 静态服务暴露 |

---

## 环境变量

在项目根目录创建 `.env`（参考下方清单）：

| 变量 | 必填 | 说明 |
|------|------|------|
| `MONGODB_URI` | ✅ | MongoDB 连接串 |
| `PASSWORD_KEY` | ✅ | 密码加密密钥（HMAC-SHA256） |
| `JWT_SECRET` | ✅ | JWT 签名密钥 |
| `MILVUS_ADDRESS` | ✅ | Milvus 地址，如 `127.0.0.1:19530` |
| `QWEN_API_KEY` | ✅ | DashScope API Key |
| `QWEN_EMBEDDING_MODEL` | ✅ | Embedding 模型，默认 `text-embedding-v3` |
| `REDIS_HOST` / `REDIS_PORT` | ✅ | Redis 地址 |
| `DEEPSEEK_API_KEY` | 关键词降级时 | DeepSeek 关键词提取（失败自动回退自然语言解析） |
| `DEEPSEEK_BASE_URL` / `DEEPSEEK_MODEL` | 可选 | 默认 `https://api.deepseek.com` |
| `PORT` | 可选 | 监听端口，默认 3000 |
| `QWEN_TEXT_MODEL` | 可选 | 文本模型名（默认 `qwen3.7-plus`） |
| `QWEN_VL_MODEL` | 可选 | 视觉模型名（默认 `qwen-vl-plus`） |
| `RAG_REFACTOR_ENABLED` | 可选 | `true` 启用四工具 RAG 架构，否则走旧线性流程 |
| `DASHSCOPE_RERANK_MODEL` | 可选 | Rerank 模型，默认 `qwen3-rerank` |
| `DASHSCOPE_RERANK_ENDPOINT` | 可选 | Rerank 端点，默认 DashScope OpenAI 兼容 `/reranks` |
| `IMAGE_BASE_URL_local` | 可选 | 图片访问域名前缀 |

---

## 快速开始

环境要求：Node.js 18+、MongoDB、Redis、Milvus、DashScope（通义千问）API Key。

```bash
# 1. 安装依赖
npm install

# 2. 配置环境变量
cp .env.example .env   # 或手动创建 .env（见上表），填入必填项

# 3. 启动开发模式（watch）
npm run start:dev

# 4. 生产构建 & 启动
npm run build
npm run start:prod     # node dist/src/main
```

其他脚本：`npm run lint`（ESLint + Prettier 修复）、`npm run format`、`npm test`。

> 前端配套：进入 `../project-user` 执行 `npm install && npm run dev`，即可在浏览器中使用完整功能。

---

## 测试

```bash
npm test          # 单元测试（Jest）
npm run test:cov  # 覆盖率
npm run test:e2e  # 端到端测试
```

已覆盖的关键测试：意图路由（`intent-router.spec.ts`）、Skill 加载器（`skill-loader.spec.ts`）、
置信度 Agent（`confidence-agent.spec.ts`）、对话服务（`chat.service.spec.ts`）、
文件管理（`fileanagement.service.spec.ts`）、图片存储（`image-storage.spec.ts`）。
Milvus SDK 通过 `src/test-mocks/milvus-sdk.stub.ts` 打桩，测试无需真实向量库。

---

## 安全设计

| 层面 | 机制 |
|------|------|
| 认证 | JWT Bearer Token，AuthGuard 统一拦截所有业务接口 |
| 密码 | HMAC-SHA256 不可逆加密存储 |
| 输入校验 | class-validator DTO + 全局 ValidationPipe（whitelist + forbidNonWhitelisted） |
| 图片安全 | 文件魔数校验（JPEG/PNG/WebP 字节级验证，防 Content-Type 伪造） |
| 路径防护 | 禁止 `../` 遍历，文件限定在 `uploads-image/` 内 |
| 错误处理 | 全局异常过滤器统一包装，不暴露内部错误详情 |
| 前端 XSS | Markdown 渲染禁用原生 HTML（`html: false`） |

---

## 相关文档

- [`src/chat/RAG_REFACTOR_DESIGN.md`](src/chat/RAG_REFACTOR_DESIGN.md) — 四工具 RAG 架构完整设计（含五大痛点解决方案、审查改进项 R1~R5、迁移路径）
- [`docs`](docs) — 项目分析报告等归档资料（如存在）

---

## License

UNLICENSED（私有项目）。
