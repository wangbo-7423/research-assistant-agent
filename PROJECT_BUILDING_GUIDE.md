# Vibe Coding 实录：AI 科研助手（Research-Assistant-Agent）搭建全过程

> 本文不是从零开始的产品说明书，而是**复盘这个项目是怎么一步一步被"聊"出来的**——
> 前端组件先做哪个、后做哪个，提示词怎么下；后端为什么先做全局异常、再做 JWT、
> 再文件、再聊天；前端做到什么程度才轮到后端；最后多模态怎么接进去。
>
> 核心观点先放在这里：**AI 写代码的节奏和人写代码的节奏是完全一样的**——先搭骨架、
> 再填肉、再做地基、再盖楼、最后联调测试。所谓 vibe coding，只是把人的开发顺序翻译成提示词顺序而已。

---

## 目录

- [1. 项目是什么](#1-项目是什么)
- [2. 整体开发节奏：一张图看懂](#2-整体开发节奏一张图看懂)
- [3. 第一阶段：前端界面（Vue 3 + TS）](#3-第一阶段前端界面vue-3--ts)
- [4. 第二阶段：后端地基——全局异常 + 统一响应](#4-第二阶段后端地基全局异常--统一响应)
- [5. 第三阶段：用户体系——JWT 认证](#5-第三阶段用户体系jwt-认证)
- [6. 第四阶段：文件模块——知识库的地基](#6-第四阶段文件模块知识库的地基)
- [7. 第五阶段：聊天模块——模型回复怎么存、怎么流](#7-第五阶段聊天模块模型回复怎么存怎么流)
- [8. 第六阶段：前后端联调](#8-第六阶段前后端联调)
- [9. 第七阶段：多模态——图片理解](#9-第七阶段多模态图片理解)
- [10. 复盘：vibe coding 的提示词方法论](#10-复盘vibe-coding-的提示词方法论)

---

## 1. 项目是什么

一个**前后端分离的 AI 对话式科研辅助平台**，围绕论文、报告等文档构建个人知识库：

| 子项目 | 技术栈 | 职责 |
|--------|--------|------|
| `project-user/` | Vue 3.5 + Vite 8 + TypeScript + Element Plus + Pinia + Vue Router | 前端 SPA：会话列表、消息流、知识库、登录 |
| `nest-serve/` | NestJS 11 + MongoDB + Redis + Milvus + 通义千问 | 后端：认证、文件解析/向量化、RAG 检索问答、流式输出 |

最终形态：上传 PDF/DOCX → 自动解析切片向量化 → 在知识库上做检索问答 → 支持图片理解（多模态）、流式打字机输出、出处引用。

---

## 2. 整体开发节奏：一张图看懂

```
时间轴 →
────────────────────────────────────────────────────────────────────────
【前端先行】                 【后端追赶】                    【合龙】
 工程骨架                   全局异常 + 统一响应              前后端联调
   ↓                          ↓                            ↓
 组件界面（先聊天后周边）      用户 JWT 认证                  流式对通、401 处理
   ↓                          ↓                            ↓
 布局 AppShell              文件模块（解析/向量化）          端到端测试
   ↓                          ↓                            ↓
 核心 ChatWindow/Input      聊天模块（会话/流式/持久化）     多模态图片理解
   ↓                          ↓
 周边 ChatHistory/           RAG 检索增强（后期）
 Knowledge/Login
────────────────────────────────────────────────────────────────────────
```

关键认知（也是这次开发的真实节奏）：

> **不是前后端都做完再整体连接。** 前端把各个界面的组件做出来后，后端先把
> **用户（JWT + 信息存储）** 和 **文件** 这两块地基打好，之后才有资格做
> **聊天（模型回复怎么生成、怎么存储）**——因为聊天依赖文件检索，而所有接口都依赖用户身份。

这就是"模块依赖决定开发顺序"：**无依赖的先做，被依赖的先做**。

---

## 3. 第一阶段：前端界面（Vue 3 + TS）

### 3.1 工程初始化提示词

项目采用 **Vue 3 + TypeScript + Vite**，界面组件库用 Element Plus，状态用 Pinia，路由用 Vue Router（Hash 模式，单页无多路由跳转）。

```text
用 Vite 创建一个 Vue 3 + TypeScript 的前端项目，目录名 project-user。
集成：
- Element Plus（按需自动导入：unplugin-auto-import + unplugin-vue-components）
- Pinia（状态管理）
- Vue Router（Hash 模式）
- 路径别名 @ → src
- axios + fetch
```

这一阶段提示词的要点：**一次只要求搭好工程底座**，不要夹带业务。

### 3.2 组件开发顺序（先核心后周边）

真实的组件体系（`project-user/src/components/`）：

```
App.vue（根组件 + 全局样式）
└── AppShell.vue（布局骨架：左 230px 会话栏 + 中央消息区 + 底部输入区）
    ├── ChatWindow.vue   —— 中央消息区（气泡 / Markdown + KaTeX / 引用折叠 / 自动滚底）
    ├── ChatInput.vue    —— 底部输入区（文本 / 图片 / DOCX / PDF 上传、知识库模式开关）
    ├── ChatHistory.vue  —— 左侧会话列表（切换 / 删除 / 新建 / 登录 / 知识库入口）
    ├── Knowledge.vue    —— 知识库管理抽屉（文件网格 / 上传 / 删除）
    ├── UserLogin.vue    —— 登录 / 注册弹窗（手机号 + 密码）
    └── ChatWelcome.vue  —— 空态欢迎页（无消息时展示）
```

**推荐顺序与理由**（按"无依赖先做、先核心后周边"排）：

| 顺序 | 组件 | 提示词要点 | 为什么这时候做 |
|------|------|-----------|---------------|
| 1 | `App.vue` / `main.ts` / `router` / `store` | 只要骨架 + 全局样式 + Pinia 空 store | 一切的容器，先立起来 |
| 2 | `AppShell.vue` | 左栏 + 中央 + 底部的 flex 布局，先占位 | 布局定了，后面组件往里填 |
| 3 | `ChatWindow.vue` | 用户/助手气泡、Markdown 渲染、自动滚底 | **核心功能**：让人先看到对话效果 |
| 4 | `ChatInput.vue` | 输入框 + 发送按钮 + 文件上传入口（先不做逻辑） | 与聊天窗配套，形成最小可用对话 UI |
| 5 | `ChatHistory.vue` | 会话列表展示（先用假数据） | 周边功能，核心跑通后再做 |
| 6 | `Knowledge.vue` | 知识库抽屉布局 + 文件列表（先用假数据） | 同上 |
| 7 | `UserLogin.vue` | 登录注册弹窗 + 表单校验（接口后接） | 界面先行，接口等后端 |
| 8 | `ChatWelcome.vue` | 空态引导页 | 锦上添花，最后做 |

> 这个顺序的本质是：**先把"对话"这个最小闭环的 UI 做出来，会话管理、知识库、登录都是围绕它的周边**。
> 界面阶段一律用假数据/占位，不碰真实接口——这正是"前端先行"的含义。

### 3.3 界面阶段的代表提示词

```text
在 AppShell.vue 里搭建布局：左侧 230px 会话栏、中央自适应消息区、底部输入区。
中央消息区做成 ChatWindow.vue：消息分为用户（右侧、紫色）和助手（左侧、白底）两种气泡，
内容支持 Markdown 渲染，消息列表变化时自动滚动到底部。
先不接接口，用一个本地假消息数组测试效果。
```

```text
写 ChatInput.vue：底部输入框 + 发送按钮，支持 Enter 发送、Shift+Enter 换行。
预留一个文件上传按钮（图标 + 隐藏 input[type=file]），现在只做 UI 不做上传逻辑。
发送后把用户消息 push 进 Pinia 的 messageList。
```

---

## 4. 第二阶段：后端地基——全局异常 + 统一响应

后端开始之前，先明确三件事：**框架、存储、认证方案**。一次提示词到位：

```text
用 NestJS 11 + TypeScript 创建后端项目 nest-serve。
集成：
- MongoDB（Mongoose）用于持久化
- Redis（ioredis）用于会话缓存
- @nestjs/jwt 用于认证
- @nestjs/config 管理环境变量
```

然后**第一件事不是写业务，而是铺全局基础设施**（`nest-serve/src/main.ts`）：

| 设施 | 实现文件 | 作用 |
|------|---------|------|
| 全局校验管道 | `ValidationPipe`（whitelist + forbidNonWhitelisted） | 所有 DTO 自动校验，多余字段直接报错 |
| 全局异常过滤器 | `nest-serve/utils/all-exception.filter.ts` | 捕获一切异常，统一返回 `{statusCode, message, data, timestamp, path}` |
| 全局响应拦截器 | `nest-serve/utils/transform.interceptor.ts` | 成功响应统一包装成同样格式 |
| 静态资源 | `/open-image` → `uploads-image/` | 图片对外可访问（为多模态埋的伏笔） |
| CORS | `cors: true` | 前端跨域访问 |

提示词长这样：

```text
后端先做全局基础设施，再写业务：
1. 全局异常过滤器：捕获所有异常（HttpException / Error / 未知类型），
   统一返回 { statusCode, message, data: null, timestamp, path }，并记录日志。
2. 全局响应拦截器：把成功返回包装成同样的结构（statusCode: 200, message, data, timestamp, path）。
3. 全局 ValidationPipe：whitelist + forbidNonWhitelisted。
4. 在 main.ts 里注册这三个全局设施。
```

**为什么先做这个？** 因为后面所有模块（用户、文件、聊天）都要吐统一格式的响应。
地基不铺平，业务写多少返工多少。这和人写代码先配统一 error handler 是一个道理。

---

## 5. 第三阶段：用户体系——JWT 认证

全局设施就绪后，第一个业务模块是**用户**。为什么先做它？
因为文件、聊天接口都要"知道是谁在用"，认证是所有业务接口的前置依赖。

`nest-serve/src/userinfo/` 做什么：

1. **注册** `POST /userinfo/registeruser`：手机号 + 密码 → HMAC-SHA256 加密存储 → 签发 JWT
2. **登录** `POST /userinfo/loginuser`：校验密码 → 签发 JWT
3. **AuthGuard**（`nest-serve/src/auth/auth.guard.ts`）：从 `Authorization: Bearer <token>` 解析校验，挂到 `req.user`
4. **JwtModule 全局注册**（`app.module.ts`）：全局可用、10 天过期

提示词要点：

```text
用户模块 userinfo：
1. Schema：phonenumber（唯一）、password。密码用 HMAC-SHA256（密钥取环境变量 PASSWORD_KEY）加密存储，不能存明文。
2. 注册接口：手机号已存在返回 422（message: 该账号已存在）；成功签发 JWT（payload 里放 _id）。
3. 登录接口：账号或密码错误返回 422；成功签发 JWT。
4. 写一个 AuthGuard：从请求头解析 Bearer token，验证失败抛 401，
   成功把 payload 挂到 req.user。JwtModule 用 JWT_SECRET 环境变量，全局注册。
```

前端此时要做一件事（联调铺垫）：**在 axios 拦截器里注入 token，401 时弹登录框**——

```text
axios 实例加请求拦截器：从 Pinia store 拿 userInfo.token，
自动带上 Authorization: Bearer <token>。
响应拦截器：401 时把 showLoginPopup 置为 true（弹出登录框），422/400 用 ElMessage 提示具体错误。
注意：FormData 上传时删掉默认 Content-Type，让浏览器自动带 multipart boundary。
```

---

## 6. 第四阶段：文件模块——知识库的地基

认证搞定后，接着做**文件**。为什么文件在聊天之前？**聊天要引用文件，检索依赖文件的向量索引**。

`nest-serve/src/fileanagement/` 承担两条线：

**线 A：知识库文件（UD）** —— 解析 → 切片 → 向量化 → 入 Milvus
```
POST /fileanagement/knowledge
文件 → LangChain PDFLoader/DocxLoader 解析文本 → RecursiveCharacterTextSplitter 切片
     → text-embedding-v3 向量化 → 按 userId 建 Milvus 集合存储
```

**线 B：对话文件（UB）** —— 只解析 + 存 MongoDB，不向量化
```
POST /fileanagement/dialog  → 会话里引用的文档，给大模型读全文用
```

**线 C：图片存储**（为多模态提前铺路）
```
POST /fileanagement/uploadimage → 落盘 uploads-image/，魔数校验 + UTF-8 文件名修复 + 路径防护
GET  /open-image/<file>        → 静态访问
```

辅助接口：`kbfilelist`（列表）、`knowledge/:id` 与 `dialog/:id`（删除，会连带清 Milvus 向量）。

提示词要点：

```text
文件模块 fileanagement：
1. 上传接口分两种：knowledge（知识库）和 dialog（对话），都限 PDF/DOCX、5MB。
2. knowledge 走完整链路：LangChain 解析文本 → 切片 → text-embedding-v3 向量化 → 存入 Milvus（按用户建集合）。
3. dialog 只解析存 MongoDB，返回 docId 给前端，聊天时按 id 查全文。
4. 上传拦截器处理中文文件名乱码（multer 按 latin1 解码，需要还原字节按 UTF-8 重新解码）。
5. 图片上传：仅 JPEG/PNG/WebP、10MB，落盘前做文件魔数校验（防 Content-Type 伪造），
   文件名随机生成，禁止路径遍历（../）。
```

> 这一阶段的"坑"都是真实踩过的：中文文件名乱码、Content-Type 伪造、Milvus 集合按用户隔离。
> 这些细节 AI 大概率第一次写不对，需要人指出后补丁修复——这就是 vibe coding 里人的价值。

---

## 7. 第五阶段：聊天模块——模型回复怎么存、怎么流

文件地基打好，才轮到**对话**。这也是用户最关心的部分：
**"关于模型的回复和信息这些东西怎么存储"**——这是整个后端的核心。

`nest-serve/src/chat/` 四件事：

### 7.1 会话与消息存储（MongoDB）

```ts
// chat.schema.ts —— ChatData 集合
{
  userId,          // 归属用户（JWT payload 里的 _id）
  chatList: [      // 消息数组，按序追加
    { role: 'user' | 'assistant', content: '...' }
  ]
}
```

持久化逻辑（`chat.service.ts` 的 `combineConvo`）：
- 新会话：先建会话文档，`$push` 用户消息
- 老会话：追加用户消息 + 助手回复
- **每次对话结束刷新 Redis 缓存**（`chat_history:{userId}:{sessionId}`，3 小时过期，存最近 3 轮上下文）
- 持久化失败**不影响**本次响应（catch 后继续，只记日志）

提示词：

```text
聊天模块 chat：
1. ChatData schema：userId + chatList 消息数组。
2. sendmessage 流程：
   - sessionId 为 'null' 时先创建新会话文档；
   - 组合消息上下文：Redis 缓存近 3 轮 + 用户消息；
   - 调通义千问（OpenAI 兼容端点），stream: true 流式返回；
   - 流式过程中把收到的增量块实时写入 HTTP 响应；
   - 结束后把用户消息和助手完整回复 $push 进 chatList，并刷新 Redis 缓存。
3. 另外提供 sessionlist（会话列表）、history（会话历史）、deletesession（删会话+清缓存）。
```

### 7.2 流式协议（SSE）

前端要"打字机"效果，后端就需要流式。当前采用**标准 SSE**
（早期版本用过私有分隔符 `###ABC###`，已废弃，改造说明见
[design/05](design/05-流式协议SSE改造.md)）：

响应头 `Content-Type: text/event-stream`，帧格式为 `data: <json>`，以空行 `\n\n` 分隔：

```
data: {"type":"sessionId","sessionId":"..."}

data: {"type":"readDocument","statusInfo":"inProgress","promptInfo":"正在阅读文档","fileList":[]}

data: {"type":"queryKB","statusInfo":"inProgress","promptInfo":"正在检索知识库","fileList":[]}

data: {"type":"answer","content":"增量文本"}

data: {"type":"error","content":"..."}

```

事件类型：`sessionId`（新会话首帧）、`readDocument`/`queryKB`（进度通知）、`answer`（增量回复）、`error`。
约束（踩坑总结）：`readDocument`/`queryKB` 是**单槽位覆盖式**——文件列表只能最后发一次，不能交错。

> 历史协议（已废弃）：早期用 `###ABC###` 作为 JSON 块分隔符，前端需手工累积 buffer 切分，
> 且无任何标准客户端可复用。现已改为标准 SSE。

### 7.3 上下文组装（roleDefinition.ts）

system prompt 分三层：**核心层（角色设定）→ 规则层（回答规范）→ 工具层（函数定义）**。
知识库问答时把召回片段 + 上传文档全文注入 system prompt，实现"基于资料回答"。

### 7.4 前端流式消费（fetchEventSource）

```text
SendMessageApi 用 @microsoft/fetch-event-source POST 到 /chat/sendmessage：
1. 该库基于 fetch 实现，因此仍支持 POST + Authorization 请求头 + JSON 请求体
   （浏览器原生 EventSource 这三样都不支持，这是没直接用它的原因）；
2. onmessage 收到的 ev.data 已由库按 SSE 规范切好，直接 JSON.parse 分发：
   sessionId 存 store、readDocument/queryKB 更新引用卡片、
   answer 追加到响应式消息对象（必须在 messageList 里 push 过的对象上改，才能触发视图更新）；
3. onopen 检查 response.ok：非 2xx 时后端返回的是普通 JSON 错误体而非 SSE 流；
4. onerror 主动抛出以禁用库的默认自动重连——重连会重新 POST 完整问题，
   导致 LLM 重复计费与重复回答；
5. openWhenHidden: true，避免页面切到后台时连接被库主动断开。
```

---

## 8. 第六阶段：前后端联调

到这一步，前后端都有了，开始"合龙"。联调不是一次性大爆炸，而是**按模块逐个打通**：

```
第一步：注册/登录 ✅
  前端 UserLogin.vue → POST /userinfo/registeruser → 拿到 token → store.userLogin()
  ↓
第二步：知识库上传 ✅
  Knowledge.vue → POST /fileanagement/knowledge → 列表刷新
  （此时能看到文件卡片，验证解析/向量化链路）
  ↓
第三步：对话 ✅
  ChatInput.vue → POST /chat/sendmessage（fetch 流式）→ 打字机输出
  （此时验证 SSE 协议、Redis 上下文、持久化）
  ↓
第四步：会话管理 ✅
  ChatHistory.vue → sessionlist / history / deletesession
  ↓
第五步：边界情况
  401 处理（token 过期弹登录）、文件删除同步清向量、网络异常提示
```

联调阶段最常踩的坑（都在代码里留下了注释）：

| 坑 | 解决 |
|----|------|
| 跨域 | 后端 `cors: true` |
| 后端地址写死 | `VITE_API_BASE_URL` 环境变量 |
| FormData 上传报错 | 删掉 axios 默认 `Content-Type`，让浏览器自动带 boundary |
| 流式 JSON 被切碎 | buffer 累积 + 分隔符切分 + 尾部留待下次 |
| 401 后页面无反应 | 响应拦截器统一弹登录框 |
| 响应对象改不动 | 流式增量必须改 messageList 里的响应式对象 |

---

## 9. 第七阶段：多模态——图片理解

基础 RAG 跑通后，最后一环是**图片理解（多模态）**。链路贯穿前后端：

```
前端 ChatInput.vue
  选择图片（PNG/JPEG/WebP，≤10MB）→ POST /fileanagement/uploadimage
  → 拿到 imagePath + imageUrl → 缩略图预览
        ↓
后端 fileanagement/uploadimage
  落盘 uploads-image/ + 魔数校验 + 路径防护 → 返回安全相对路径
        ↓
用户发送带图片的消息 → POST /chat/sendmessage（带上 uploadImageList）
        ↓
后端 chat.service.ts
  encodeImage()：按路径读文件 → base64（再次魔数校验）→ 拼成 OpenAI 多模态格式
  modelVLRes()：检测到图片 → 走视觉模型（qwen-vl-plus）
                纯文本 → 走文本模型（qwen3.7-plus）   ← 自动路由，前端无需感知
```

关键实现片段：

```ts
// 图片转 base64 并组装多模态消息（chat.service.ts）
return {
  type: 'image_url',
  image_url: { url: `data:${mimetype};base64,${base64Image}` },
}

// 视觉模型 system prompt 追加图片理解要求：
// "先客观描述图片中的关键信息，再结合用户问题进行分析；
//  涉及图表时提取趋势、对比、异常点和可读出的数据；无法确认的内容要明确说明，不要臆造。"
```

提示词：

```text
多模态支持：
1. 前端 ChatInput 加图片上传：限制 PNG/JPEG/WebP、10MB，上传后缩略图预览、可删除。
2. 后端 uploadimage 接口：文件落盘 uploads-image/，做魔数校验（读文件头字节验证真实类型），
   文件名随机生成，返回 imagePath（安全相对路径）和 imageUrl（静态访问地址）。
3. 聊天接口支持 uploadImageList：检测到图片时，把图片 base64 作为 image_url 消息
   发给视觉模型 qwen-vl-plus；纯文本走文本模型。图片理解要求写进 system prompt。
```

---

## 10. 复盘：vibe coding 的提示词方法论

### 10.1 开发节奏对照表（AI vs 人，完全同构）

| 人的做法 | AI 的提示词做法 | 本项目对应 |
|---------|----------------|-----------|
| 先搭工程骨架 | 一次提示词只要脚手架，不要业务 | Vite 工程、NestJS 脚手架 |
| 先做界面原型 | "先不接接口，用假数据" | 前端假消息数组、假文件列表 |
| 先铺全局错误处理 | "先写全局异常过滤器/响应拦截器，再写业务" | `main.ts` 三件套 |
| 按依赖顺序做模块 | 明确"先用户、再文件、再聊天" | `Userinfo → Fileanagement → Chat` |
| 模块做完就联调 | 逐个接口打通，不做完再连 | 登录 → 上传 → 对话 → 会话管理 |
| 核心功能后做增强 | 基础 RAG 跑通后再加多模态 | 图片理解放最后 |

### 10.2 几条实战经验

1. **小步迭代**：一次只让 AI 做一个模块（一个控制器 + 一个 service），做完验收再下一个。
   一次塞太多需求，AI 容易顾此失彼。

2. **明确"先做什么后做什么"**：开发顺序不要靠 AI 猜，直接在提示词里指定——
   "先做全局异常，再做用户模块，用户模块做完再写 AuthGuard"。

3. **接口先行、假数据占位**：前端阶段全部用假数据；后端阶段用 curl/Postman 验证；
   最后才真联调。这样问题边界清晰——是前端 bug 还是后端 bug，一目了然。

4. **存储设计要提前想**："模型回复怎么存"这种问题要在写聊天模块之前想清楚：
   MongoDB 存全量（持久化）、Redis 存近 3 轮（上下文）、流式协议确定事件类型。
   这是后端最核心的决策，比调模型重要。

5. **AI 会踩坑，人要验收**：中文文件名乱码、TCP 分片切碎 JSON、FormData 的
   Content-Type、单槽位覆盖式事件……这些坑 AI 第一次大概率写不对。
   vibe coding 不是"全自动"，而是"人指挥 + 人验收 + 人修边角"。

6. **留 feature flag**：重大架构改动（如四工具 RAG 重构）用 `RAG_REFACTOR_ENABLED`
   feature flag 灰度，旧链路保留兜底，随时可回退。

### 10.3 关键文件索引

| 关注点 | 文件 |
|--------|------|
| 前端组件体系 / 状态 / 流式协议 | `project-user/README.md` |
| 后端 API / 存储 / 安全设计 | `nest-serve/README.md` |
| 四工具 RAG 架构设计 | `nest-serve/src/chat/RAG_REFACTOR_DESIGN.md` |
| 全局异常 + 统一响应 | `nest-serve/utils/all-exception.filter.ts`、`transform.interceptor.ts` |
| 认证 | `nest-serve/src/auth/auth.guard.ts`、`src/userinfo/userinfo.service.ts` |
| 文件解析/向量化 | `nest-serve/src/fileanagement/fileanagement.service.ts` |
| 图片存储安全 | `nest-serve/src/fileanagement/image-storage.ts` |
| 聊天流式 + 持久化 + 多模态 | `nest-serve/src/chat/chat.service.ts` |
| 意图路由 / Skill 加载 | `nest-serve/src/chat/routers/intent-router.ts`、`tools/skill-loader.ts` |

---

**一句话总结**：这个项目的搭建顺序 = 前端界面（先核心组件后周边）→ 后端地基（全局异常 + 统一响应）
→ 用户 JWT → 文件 → 聊天（重点想清楚回复存储与流式协议）→ 逐模块联调 → 多模态增强。
每一步都遵循"**无依赖的先做、被依赖的先做、核心先做、增强最后**"的原则——
这和人类写代码的顺序没有任何区别，AI 只是把同样的过程执行得更快。
