# Research-Assistant-Agent — AI 科研助手平台

> 一个前后端分离的 **AI 对话式科研辅助平台**：围绕论文、报告等科研文档构建个人知识库，
> 支持多模态输入（文本 / PDF / DOCX / 图片）、向量检索 + RRF 混合检索、流式对话输出。

---

## 快速导航

| 子项目 | 说明 | 详细文档 |
|--------|------|---------|
| `nest-serve/` | 后端服务（NestJS 11） | [nest-serve/README.md](nest-serve/README.md) |
| `project-user/` | 前端应用（Vue 3.5） | [project-user/README.md](project-user/README.md) |

---

## 项目概览

Research-Assistant-Agent 是一个**科研知识库问答（RAG）平台**，核心能力：

- 📚 **知识库检索问答**：上传 PDF / DOCX 文档，自动解析、切片、向量化，支持语义 + 关键词混合检索问答
- 🧠 **多轮科研对话**：上下文缓存（Redis 近 3 轮）、会话管理、流式输出
- 🖼️ **多模态理解**：图片（PNG/JPEG/WebP）自动路由至视觉模型
- 🔍 **高精度溯源**：四工具 RAG 意图路由（clarify / fact / perspective），Rerank 精排 + 置信度校验 + 出处引用

## 技术栈总览

```
后端（nest-serve）                    前端（project-user）
├─ NestJS 11 + TypeScript            ├─ Vue 3.5 + <script setup>
├─ MongoDB（持久化）                  ├─ Vite 8 + TypeScript
├─ Redis（会话缓存 / RAG 状态）        ├─ Pinia 4（状态管理，localStorage 持久化）
├─ Milvus（向量检索）                 ├─ Vue Router 5（Hash 模式）
├─ 通义千问（文本 / 视觉 / Embedding）  ├─ Element Plus（UI 组件库）
├─ qwen3-rerank（检索精排）           ├─ markdown-it + KaTeX（Markdown / 公式）
└─ LangChain（文档解析）              └─ Axios + fetch 流式（###ABC### 协议）
```

## 系统架构

```
┌─────────────────────────────────────────────┐
│                project-user（前端）           │
│    Vue3 SPA · 会话列表 / 消息流 / 知识库 / 登录 │
└──────────────────┬──────────────────────────┘
                   │  HTTP REST + 流式（###ABC### 分隔）
                   ▼
┌─────────────────────────────────────────────┐
│                nest-serve（后端）             │
│  Userinfo 认证 → Fileanagement 文件/检索      │
│  → Chat 对话（四工具 RAG 意图路由 + 流式输出）  │
│  ├─ MongoDB   用户 / 会话 / 文件元数据         │
│  ├─ Redis     近 3 轮对话缓存 / RAG 状态       │
│  └─ Milvus    文本向量索引（按用户建集合）       │
└─────────────────────────────────────────────┘
```

模块间单向无环依赖：`Chat → Fileanagement`，`Userinfo` 独立。

## 快速启动

前置依赖：Node.js 18+、MongoDB、Redis、Milvus、DashScope（通义千问）API Key。

```bash
# 1. 启动后端（详见 nest-serve/README.md）
cd nest-serve
npm install
cp .env.example .env      # 填入数据库 / Redis / Milvus / API Key 等
npm run start:dev         # 默认监听 :3000

# 2. 启动前端（详见 project-user/README.md）
cd ../project-user
npm install
npm run dev               # 默认 http://localhost:5173
```

浏览器访问 `http://localhost:5173`，注册账号后即可使用。

## 关键文档

- [后端：四工具 RAG 架构设计](nest-serve/src/chat/RAG_REFACTOR_DESIGN.md) — clarify/fact/perspective 三态路由 + hybrid 内部组合、隐忧防护（防死循环 / 熔断 / Token 预算）
- [后端：API 与流式协议](nest-serve/README.md#api-接口)
- [前端：组件体系与状态管理](project-user/README.md)

## License

私有项目（UNLICENSED）。
