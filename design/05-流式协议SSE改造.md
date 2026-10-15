# 05 · 流式协议 SSE 改造

> 本文记录 `/chat/sendmessage` 的流式推送从私有分隔符协议（`###ABC###`）改造为标准 SSE 协议
> （`text/event-stream` + `data:` 帧）的选型过程与落地方案。
> 涉及范围仅限 `py-serve/app/chat` 与 `project-user/src/api/request.ts`，不触碰 RAG 检索链路。

---

## 一、背景：原协议的问题

改造前，`StreamWriter.notify` 把每条消息序列化为裸 JSON 后拼一个私有分隔符：

```
{"type":"answer","content":"你好"}###ABC###{"type":"answer","content":"世界"}###ABC###
```

响应 `Content-Type` 为 `text/plain`，前端用 `fetch` + `getReader()` 手工累积 buffer 并按 `###ABC###` 切分。

该方案存在三个问题：

| 问题 | 具体表现 |
|---|---|
| 不可互操作 | 私有协议无任何标准客户端可接；换前端栈、加 CLI、用调试工具都要先读代码猜格式 |
| 解析全靠手写 | 半包/粘包、缓冲区管理、最后一段冲刷，全部要自己维护，边界 case 易漏 |
| 生态为零 | 现成的 SSE 解析库、自动重连能力一概用不上，因为输入格式不是 SSE |

## 二、方案选型

| 方案 | 可行性 | 结论 |
|---|---|---|
| A. 改用浏览器原生 `EventSource` | **不可行** | 其请求被写死为「无自定义请求头、无请求体、仅 GET」，与本接口三项需求全部冲突（见下） |
| B. 前端手写 SSE 解析 | 可行 | 零依赖，但半包、多行 `data:`、注释行等边界仍需自行维护 |
| C. `@microsoft/fetch-event-source` | 可行 | **采用** |

**方案 A 为何不可行（三条硬伤）：**

1. 接口是 `POST` + JSON 请求体（`router.py:38`、`SendMessageDto`），`EventSource` 只能发 GET；
2. 认证依赖 `Authorization: Bearer <jwt>` 请求头（`deps.py:34`），`EventSource` 无法设置请求头；
3. 若强行改造：参数（含用户问题全文、文件列表、图片路径）只能塞 URL，受长度限制且会泄落到浏览器历史与服务端访问日志；token 放 URL 同样有泄露风险。

**方案 C 被采用的理由：**

- 它是微软官方用 **fetch 实现**的 SSE 客户端，完整保留「任意方法 + 任意请求头 + 任意请求体」，恰好补齐 `EventSource` 的三块短板；
- 内部基于 `eventsource-parser`，半包、多行 `data:`、注释行、字段解析等协议细节由库负责；
- 自带 TypeScript 类型，`vue-tsc -b` 无痛通过；
- 体积约 4KB、无传递依赖；
- 保留重连能力（本项目主动关闭，见第五节）。

代价：库自 2021 年（v2.0.1）后未再发版。但 SSE 协议本身早已定稿稳定，风险可接受，已在 `package.json` 锁定 `^2.0.1`。

## 三、改造后的协议

```
POST /chat/sendmessage            （请求不变：JSON body + Authorization 头）
HTTP/1.1 200 OK
Content-Type: text/event-stream    ← 由 text/plain 改为标准 SSE
Cache-Control: no-cache
Connection: keep-alive
X-Accel-Buffering: no

data: {"type":"sessionId","sessionId":"..."}

data: {"type":"readDocument","statusInfo":"inProgress","promptInfo":"正在阅读文档","fileList":[]}

data: {"type":"queryKB","statusInfo":"completed","promptInfo":"知识库检索完成","fileList":["BERT.pdf"]}

data: {"type":"answer","content":"增量文本"}

data: {"type":"error","content":"..."}

```

帧格式统一为 `data: <json>\n\n`。**无需自定义分隔符常量**，`json.dumps` 会把内容中的换行转义为字面 `\n`，因此单帧必然是单行，天然满足 SSE「一条 `data` 必须是单行」的约束，也不需要前端做多行 `data` 合并。

消息类型与改造前完全一致，前端分发逻辑（`handleChunk`）零改动：

| type | 含义 | 前端处理 |
|---|---|---|
| `sessionId` | 新会话分配的真实 id | 写入 store |
| `readDocument` | 文档阅读状态（inProgress/completed） | 更新 `readFileData` |
| `queryKB` | 知识库检索状态 + 命中文件名 | 更新 `readFileData` |
| `answer` | 模型增量文本 | 追加到 `content` |
| `error` | 服务端业务错误 | `ElMessage` 提示 |

## 四、改动点清单（按文件）

### 1. `py-serve/app/chat/service.py` — 帧格式

- 删除常量 `STREAM_SEPARATOR = "###ABC###"`（原 `:25`），全仓已无引用；
- `StreamWriter.notify`（`:50`）改为输出 SSE 帧：

```python
await self.queue.put(f"data: {json.dumps(stream_data, ensure_ascii=False)}\n\n")
```

队列、哨兵 `None`、`_closed` 去重等机制不变，仅改帧的包装格式。

### 2. `py-serve/app/chat/router.py` — 响应头

`StreamingResponse`（`:70`）改为：

```python
media_type="text/event-stream",
headers={
    "Cache-Control": "no-cache",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no",
},
```

`X-Accel-Buffering: no` 与 `Cache-Control: no-cache` 改造前已有，用于关闭 Nginx 等中间层缓冲；新增 `Connection: keep-alive`。

### 3. `project-user/src/api/request.ts` — 客户端

- 新增 `import { fetchEventSource } from '@microsoft/fetch-event-source'`；
- `SendMessageApi` 内删除手工解析段（`getReader()` 循环、`TextDecoder`、buffer 累积、`split('###ABC###')`、末尾冲刷）；
- 改调 `fetchEventSource`，请求参数（`method` / `headers` / `body`）与原 `fetch` 完全一致；
- `handleChunk` 分发逻辑保持不变，仅数据来源从「手工切分的 part」变为库回调的 `ev.data`；
- `loadingCircle` 的收尾统一到 `try/finally`，避免多条返回路径重复设置。

### 4. 其他

- `project-user/package.json`：新增依赖 `"@microsoft/fetch-event-source": "^2.0.1"`；
- `project-user/src/types/index.d.ts`：更新流式数据注释。

## 五、关键设计决策

### 1. 用 `fetch`，不用 `EventSource`

不是"哪种更好"，而是 `EventSource` 的能力边界（GET-only、无自定义头、无请求体）与本接口的三项硬性需求完全不相交。改造的只是**响应格式**，不是请求方式。

### 2. 主动禁用自动重连（最重要的一处）

`fetchEventSource` 的 `onerror` 若**既不抛出也不返回数字，库会默认立即重连**。本接口必须禁用：

```ts
onerror(err) {
  throw err   // 抛出即终止 promise，不触发重连
}
```

原因：本接口是「一次性问答」而非「持续订阅」。重连等于**重新 POST 一遍完整问题**，会导致：

- LLM 被重复调用，**重复计费**；
- 后端重复走一遍「意图识别 → 混合检索 → 生成」链路，**重复产出答案**；
- 新会话被重复创建。

若未来确需重连，必须改为幂等设计（如带 `requestId` 去重、或断点续传），不能直接打开这个开关。

### 3. `openWhenHidden: true`

库默认在页面隐藏时会主动断开连接。科研问答的回答可能持续数十秒，用户切走标签页是常见行为，因此显式保持连接。

### 4. 错误响应在 `onopen` 拦截

非 2xx 时后端返回的是普通 JSON 错误体（`HTTPException`），不是 SSE 流，`onmessage` 永远不会触发，用户会看到无限 loading。因此必须在 `onopen` 中检查 `response.ok` 并抛出，保留原有的错误提示与 `loadingCircle` 收尾：

```ts
async onopen(response) {
  if (!response.ok) {
    const errorText = await response.text()
    ElMessage('发送失败,你可以尝试重试')
    throw new Error('发送失败' + errorText)
  }
}
```

## 六、兼容性与风险

| 项 | 说明 |
|---|---|
| 协议向前不兼容 | 前后端必须**同批发布**。旧前端遇到 `text/event-stream` 仍按 `###ABC###` 切分会解析失败；新前端遇到旧后端同样拿不到帧 |
| 反向代理 | 需确保中间层不缓冲（`X-Accel-Buffering: no` 已设，Nginx 还需 `proxy_buffering off`），并确认 `proxy_read_timeout` 足够长 |
| 流空闲期 | 意图识别 + 检索阶段可能有数秒无任何帧输出。目前无心跳，若部署环境超时较短需补心跳（见下） |
| 运行环境 | 实测该库 v2.0.1 内部引用 `window`/`document`，**Node/SSR 环境直接抛 `window is not defined`**。本项目为纯浏览器前端，无影响；但若未来要在 Node 脚本或 SSR 中复用该客户端，需自行注入 DOM 存根或换用其他实现 |
| 依赖维护 | `@microsoft/fetch-event-source` 停留在 v2.0.1，升级前需回归流式链路 |

## 七、验证结果（已实测通过）

启动 `python run.py`（端口 3000，依赖 Redis / Mongo / Milvus），分三层验证：

### 1. 协议层（Python 直接读原始字节流）

| 用例 | 结果 |
|---|---|
| A. 无 token | `401` + `application/json`，**不是** SSE 流 → 前端 `onopen` 拦截路径成立 |
| B. `isKnowledgeBased=false` | `200` + `text/event-stream`；118 帧，类型 `sessionId`/`answer`；全部帧 JSON 可解析；无 `###ABC###` 残留；流结束无未成帧残留 |
| C. `isKnowledgeBased=true` | `200` + `text/event-stream`；775 帧，类型 `sessionId`/`queryKB`/`answer`；`queryKB` 的 `inProgress`→`completed` 状态帧齐全 |

原始帧示例：

```
data: {"type": "sessionId", "sessionId": "6ad0b871866f6917bcf9e7c6"}

data: {"type": "queryKB", "statusInfo": "inProgress", "promptInfo": "正在检索知识库", "fileList": []}

data: {"type": "queryKB", "statusInfo": "completed", "promptInfo": "知识库未检索到相关内容", "fileList": []}

data: {"type": "answer", "content": "混合检索（Hybrid Retrieval）通常指..."}
```

C 用例使用全新 userId（无 Milvus 集合），检索按 `fileanagement/service.py:281` 安全返回空，未触发 embedding 调用，同时验证了知识库规则第 1 条的兜底话术（"我没有在你的知识库中检索到相关资料，但我可以告诉你："）正常生效。

### 2. 客户端层（用前端真实库请求）

用 `@microsoft/fetch-event-source` 以与 `request.ts` 完全相同的参数（`method`/`headers`/`body`/`openWhenHidden`/`onerror`）直连后端：**10/10 项通过**，`onopen` 收到 200 与 `text/event-stream`，B 收到 58 帧、C 收到 832 帧，全部帧 `JSON.parse` 成功，三类消息类型齐全。

> 该层需在 Node 下注入 `window`/`document` 存根才能运行（见第六节「运行环境」），浏览器环境无此问题。

### 3. 静态检查

- `npx vue-tsc -b`：exit 0
- `python -m py_compile app/chat/service.py app/chat/router.py`：exit 0
- `read_lints`（`request.ts` / `service.py` / `router.py`）：0 diagnostics
- 服务日志 5 次请求全部 `200 OK`，无 `Traceback`/`Exception`

### 4. 环境修复记录（与本次改造无关）

验证过程中发现本地 Python 环境存在损坏安装：`pymongo`、`pymilvus` 未安装，且 `cachetools` 仅有 `dist-info` 元数据、**包目录缺失**（导致 pip 误判已安装而跳过）。已通过 `pip install` 及 `--target` 补装修复。若换机器部署，建议以干净环境执行 `pip install -r requirements.txt`。

## 八、后续可选增强（本次未做）

| 增强 | 说明 |
|---|---|
| 心跳帧 | 后端定时发送 SSE 注释行 `: keep-alive\n\n`，防止空闲期被中间层切断 |
| 停止生成 | 引入 `AbortController` + `signal`，支持用户中断回答（后端需监听 `request.is_disconnected`） |
| 幂等重连 | 若要做断线续传，先加 `requestId` 与消息序号，再按序号续传，而非整体重连 |
| 文档同步 | 已同步更新：根 `README.md`、`py-serve/README.md`、`PROJECT_BUILDING_GUIDE.md`（7.2/7.4 节）、`project-user/README.md` |
