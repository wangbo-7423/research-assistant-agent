# project-user — AI 科研助手前端

> Research-Assistant-Agent 项目的前端应用：基于 **Vue 3.5 + Vite 8** 的科研知识库问答 SPA。
> 配套后端为 [`nest-serve/`](../nest-serve)（NestJS 11）。

---

## 技术栈

| 层级 | 技术 | 说明 |
|------|------|------|
| 框架 | Vue 3.5 | Composition API + `<script setup>` |
| 构建工具 | Vite 8 | `unplugin-auto-import` + `unplugin-vue-components` 自动导入 |
| 路由 | Vue Router 5 | Hash 模式（`createWebHashHistory`），单路由结构 |
| 状态管理 | Pinia 4 | 全局唯一 Store，localStorage 持久化 |
| UI 组件库 | Element Plus | 弹窗 / 抽屉 / 表单 / 消息等，按需自动导入 |
| Markdown | markdown-it | `html: false`（防 XSS），自动链接、换行断行 |
| 数学公式 | KaTeX | 行内 `$...$`、块级 `$$...$$`、`\[...\]` |
| HTTP | Axios + fetch | Axios 普通请求；fetch 流式解析（SSE） |

## 环境变量

在项目根目录创建 `.env`（参考 `.env.example`）：

| 变量 | 必填 | 说明 |
|------|------|------|
| `VITE_API_BASE_URL` | ✅ | 后端地址，默认 `http://127.0.0.1:3000`（部署 / 后端换端口时修改） |

## 快速开始

```bash
# 1. 安装依赖
npm install

# 2. 启动开发服务器（默认 http://localhost:5173）
npm run dev

# 3. 生产构建（vue-tsc 类型检查 + vite build）
npm run build

# 4. 预览构建产物
npm run preview
```

> 后端需先启动：进入 `../nest-serve` 执行 `npm run start:dev`，否则登录 / 对话接口会失败。

---

## 目录结构

```
project-user/
├── vite.config.ts              # Vite 配置：Element Plus 自动导入、@ → src 别名
├── .env / .env.example         # VITE_API_BASE_URL 后端地址
├── index.html                  # HTML 入口
└── src/
    ├── main.ts                 # 应用入口：挂载 Pinia / Router
    ├── App.vue                 # 根组件：全局样式 + <router-view/>
    ├── router/
    │   └── index.ts            # 单路由 / → AppShell.vue（Hash 模式）
    ├── store/
    │   └── index.ts            # Pinia projectStore：userInfo / sessionId / messageList / 弹窗状态
    ├── api/
    │   ├── request.ts          # Axios 实例（JWT 注入、401 处理）+ fetchEventSource 流式（SSE）
    │   └── getItemChat.ts      # 组合式函数 userFileUploader（上传/校验/删除）
    ├── types/
    │   └── index.d.ts          # 全局类型定义（API 响应 / 消息 / 会话等）
    ├── utils/
    │   ├── validators.ts       # 前端校验工具
    │   └── image.ts            # 粘贴图片读取 / canvas 压缩 / base64 转换
    ├── components/
    │   ├── AppShell.vue        # 布局骨架（左栏 + 中央 + 底部）
    │   ├── ChatHistory.vue     # 左侧会话列表（切换 / 删除 / 新建 / 登录 / 知识库入口）
    │   ├── ChatWindow.vue      # 中央消息区（气泡 / Markdown+KaTeX / 文档引用折叠 / 引用角标 / 自动滚底）
    │   ├── CitationList.vue    # 知识库回答出处列表（章节 / 页码 / 段序 / 片段摘录）
    │   ├── ChatWelcome.vue     # 欢迎页（无消息时展示）
    │   ├── ChatInput.vue       # 底部输入区（文本 / 粘贴或选择图片 / DOCX / PDF 上传、知识库模式切换）
    │   ├── Knowledge.vue       # 知识库管理抽屉（文件网格 / 上传 / 删除）
    │   └── UserLogin.vue       # 登录 / 注册弹窗（手机号 + 密码）
    └── assets/                 # 静态资源
```

## 组件体系

```
App.vue
└── AppShell.vue（flex 布局：左 230px 侧栏 + 中央自适应 + 底部输入）
    ├── ChatHistory.vue   —— 会话管理
    ├── ChatWindow.vue    —— 消息渲染（含 ChatWelcome 欢迎态）
    │   └── CitationList.vue —— 知识库出处卡片
    ├── ChatInput.vue     —— 消息发送 / 粘贴图片（Ctrl+V）/ 选择图片或文档
    ├── Knowledge.vue     —— ElDrawer 知识库抽屉
    └── UserLogin.vue     —— ElDialog 登录注册弹窗
```

| 组件 | 职责 | 关键特性 |
|------|------|---------|
| AppShell | 布局骨架，组装子组件 | flex 三区布局 |
| ChatHistory | 会话管理 | 列表拉取 / 切换 / 删除 / 新建；登录与知识库入口 |
| ChatWindow | 消息渲染 | 用户 / 助手气泡、Markdown + KaTeX、引用折叠、`[N]` 角标、自动滚底 |
| CitationList | 知识库出处 | 文档 / 章节 / 页码 / 段序 / 片段摘录，支持展开完整片段，点击角标定位高亮 |
| ChatWelcome | 空态欢迎 | 无消息时的引导页 |
| ChatInput | 消息发送 | 文本 / 图片 / DOCX / PDF 上传、知识库模式开关、快捷键 |
| Knowledge | 知识库管理 | ElDrawer 抽屉、文件网格、上传 / 删除 |
| UserLogin | 认证 | ElDialog 弹窗、手机号 + 密码、注册含确认密码 |

## 状态管理（Pinia）

全局唯一 Store `projectStore`，核心状态：

| 字段 | 类型 | 说明 |
|------|------|------|
| `userInfo` | `UserInfoResType \| null` | 登录信息（JWT token / 手机号），持久化到 localStorage |
| `sessionId` | `string` | 当前会话 ID，持久化 |
| `messageList` | `MessageListType[]` | 当前会话消息列表，响应式驱动渲染 |
| `showLoginPopup` / `knowledgePopup` | `boolean` | 弹窗 / 抽屉显隐 |

关键 Action：`userLogin`（存 Token）、`userLogout`（清空状态与 localStorage）、
`loadSession`（切换历史会话）、`resetSession`（生成新 sessionId）。

## 通信机制

### 普通请求（Axios）

`api/request.ts` 统一封装：

- `baseURL` 取自 `VITE_API_BASE_URL`（默认 `http://127.0.0.1:3000`）
- 请求拦截器自动注入 `Authorization: Bearer <token>`
- 响应拦截器处理 401（清除登录态）与网络错误
- 封装了登录注册、会话管理、文件上传删除、知识库等全部后端接口

### 流式对话（fetchEventSource + SSE）

`SendMessageApi` 使用 `@microsoft/fetch-event-source` POST 到 `/chat/sendmessage`。
响应为标准 SSE（`Content-Type: text/event-stream`），帧格式 `data: <json>`、空行分隔，
由库负责切分，`onmessage` 直接拿到 `ev.data` 并写入 Pinia 响应式对象实时渲染：

```ts
onmessage(ev) {
  handleChunk(JSON.parse(ev.data) as AiMessageType)
}
```

之所以用该库而非浏览器原生 `EventSource`：本接口需要 `POST` + `Authorization` 请求头 +
JSON 请求体，而 `EventSource` 只能发无自定义头、无 body 的 `GET`。

> 该库的 `onerror` 必须主动抛出以禁用默认自动重连——重连会重新 POST 一遍完整问题，
> 导致 LLM 重复计费与重复回答。
> 协议选型详见 [design/05](../design/05-流式协议SSE改造.md)。

支持的事件类型：

| 类型 | 说明 |
|------|------|
| `sessionId` | 新会话 ID（首帧，写入 store） |
| `readDocument` / `queryKB` | 文档阅读 / 知识库检索进度提示 |
| `answer` | 助手回复内容（可多帧，前端拼接） |
| `error` | 错误信息 |

> ⚠️ `readDocument` / `queryKB` 为单槽位覆盖式事件，文件列表只能最后发一次。

## 核心设计

1. **单页单路由 SPA**：无多页面跳转，所有交互（会话切换、知识库、登录）由状态驱动 + 弹窗 / 抽屉完成。
2. **Markdown 安全渲染**：markdown-it `html: false` 禁用原生 HTML（防 XSS）；KaTeX 先占位提取再替换，防公式被误解析。
3. **上传逻辑复用**：`userFileUploader` 组合式函数在对话框（ChatInput）与知识库（Knowledge）两场景共享，仅通过参数区分接口。
4. **响应式滚动与加载态**：watch `messageList` 自动滚底；发送中按钮禁用 + loading 动画。

## 相关文档

- 后端 API 与流式协议：[`../nest-serve/README.md`](../nest-serve/README.md)
- 四工具 RAG 架构设计：[`../nest-serve/src/chat/RAG_REFACTOR_DESIGN.md`](../nest-serve/src/chat/RAG_REFACTOR_DESIGN.md)

## License

私有项目（UNLICENSED）。
