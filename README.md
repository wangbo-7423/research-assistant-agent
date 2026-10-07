# Research-Assistant-Agent — AI 科研助手平台

> 一个前后端分离的 **AI 对话式科研辅助平台**：围绕论文、报告等科研文档构建个人知识库，
> 支持多模态输入（文本 / PDF / DOCX / 图片）、向量检索 + RRF 混合检索、流式对话输出。

---

## 快速导航

| 子项目 | 说明 | 详细文档 |
|--------|------|---------|
| `py-serve/` | 后端服务（FastAPI + DeepSeek） | [py-serve/README.md](py-serve/README.md) |
| `project-user/` | 前端应用（Vue 3.5） | [project-user/README.md](project-user/README.md) |

> 原 NestJS 后端 `nest-serve/` 已移除，py-serve 是其 Python 重写版，接口路径、
> 流式协议、数据结构完全对齐，前端无需改动。

## 项目概览

Research-Assistant-Agent 是一个**科研知识库问答（RAG）平台**，核心能力：

- 📚 **知识库检索问答**：上传 PDF / DOCX 文档，自动解析、切片、向量化，支持语义 + 关键词混合检索问答
- 🧠 **多轮科研对话**：上下文缓存（Redis 近 3 轮）、会话管理、流式输出
- 🖼️ **多模态理解**：图片（PNG/JPEG/WebP）自动路由至视觉模型
- 🔍 **检索增强问答**：意图识别强制工具调用（续问改写）+ 混合检索 + 知识库规则回答 + 出处引用

## 技术栈总览

```
后端（py-serve）                       前端（project-user）
├─ FastAPI + uvicorn                  ├─ Vue 3.5 + <script setup>
├─ MongoDB（持久化）                   ├─ Vite 8 + TypeScript
├─ Redis（会话缓存）                   ├─ Pinia 4（状态管理，localStorage 持久化）
├─ Milvus（向量检索）                  ├─ Vue Router 5（Hash 模式）
├─ DeepSeek deepseek-flash（对话/视觉/关键词）├─ Element Plus（UI 组件库）
├─ 通义 text-embedding-v3（向量化）     ├─ markdown-it + KaTeX（Markdown / 公式）
└─ OpenAI SDK 兼容调用                 └─ Axios + fetch 流式（###ABC### 协议）
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
│                py-serve（后端）               │
│  Userinfo 认证 → Fileanagement 文件/检索      │
│  → Chat 对话（意图改写 + 混合检索 + 流式输出）   │
│  ├─ MongoDB   用户 / 会话 / 文件元数据         │
│  ├─ Redis     近 3 轮对话缓存                 │
│  └─ Milvus    文本向量索引（按用户建集合）       │
└─────────────────────────────────────────────┘
```

## 快速启动

前置依赖：Python 3.12+、Docker、DeepSeek API Key、通义（DashScope）API Key。

```bash
# 1. 启动后端（详见 py-serve/README.md）
cd py-serve
docker compose up -d      # mongo / redis / milvus
python -m venv .venv && .venv/Scripts/activate
pip install -r requirements.txt
python run.py             # 默认监听 :3000

# 2. 启动前端（详见 project-user/README.md）
cd ../project-user
npm install
npm run dev               # 默认 http://localhost:5173
```

浏览器访问 `http://localhost:5173`，注册账号后即可使用。

## 关键文档

- [后端：接口与 RAG 主链路](py-serve/README.md)
- [召回评测：chunk 向量 vs QA 问题检索 vs 融合](py-serve/eval/README.md) — 408 条查询五臂对比与结论
- [前端：组件体系与状态管理](project-user/README.md)

## License

私有项目（UNLICENSED）。
