<template>
  <!-- 消息界面 -->
  <div class="chat-window">
    <!-- 空会话欢迎语 -->
    <div class="chat-welcome" v-if="chat.messageList.length === 0">
      <img src="../assets/Interface.png" alt="" class="display-image">
      <span class="greeting-title">你好，我是AI科研助手，很高兴见到你</span>
      <span class="greeting-span">我可以解答科研问题、解读你上传的论文资料，也可以基于你的个人知识库检索回答</span>
    </div>
    <div class="chat-message" v-for="(item, index) in chat.messageList" :key="index">
      <!-- 用户消息 -->
      <template v-if="item.role == 'user'">
        <a
          class="image-view"
          v-if="item.uploadImageList"
          :href="item.uploadImageList.imageUrl"
          target="_blank"
          rel="noopener noreferrer"
          title="点击查看原图"
        >
          <img :src="item.uploadImageList.imageUrl" alt="用户上传的待识别图片">
        </a>
        <div class="file-view" v-if="item.uploadFileList && item.uploadFileList.length > 0">
          <div class="file-item" v-for="(itema, indexa) in item.uploadFileList" :key="indexa">
            <div class="file-icon"><img :src="itema.fileType == 'docx' ? docxIcon : pdfIcon" alt=""></div>
            <div class="file-name">
              <span class="hidden-text">{{ itema.fileName }}</span>
              <span>{{ formatSize(itema.fileSize) }}</span>
            </div>
          </div>
        </div>
        <div class="user-message">
          <p>{{ item.displayContent || item.content }}</p>
        </div>
      </template>
      <!-- 模型消息 -->
      <div class="ai-message" v-if="item.role == 'assistant'">
        <!-- 文档阅读 / 知识库检索状态 -->
        <el-collapse v-if="item.readFileData" class="read-file-collapse">
          <el-collapse-item>
            <template #title>
              <span class="read-file-title">{{ item.readFileData.promptInfo }}</span>
            </template>
            <div class="read-file-list" v-if="item.readFileData.fileList && item.readFileData.fileList.length > 0">
              <div v-for="(name, i) in item.readFileData.fileList" :key="i">· {{ name }}</div>
            </div>
            <div class="read-file-list" v-else>未命中相关文件</div>
          </el-collapse-item>
        </el-collapse>
        <!-- 加载中 -->
        <div class="loading-circle" v-if="item.loadingCircle && !item.content">
          <el-icon class="is-loading"><Loading /></el-icon>
          <span>正在思考中...</span>
        </div>
        <!-- 模型回复内容：Markdown 渲染，正文 [N] 可点击定位到下方出处 -->
        <div
          class="ai-content markdown-body"
          v-if="item.content"
          v-html="renderMarkdown(item.content, item.citations?.length || 0)"
          @click="handleCiteClick"
        ></div>
        <!-- 知识库回答的出处列表 -->
        <CitationList v-if="item.citations && item.citations.length > 0" :citations="item.citations" />
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
// 逻辑层
import { watch, nextTick } from 'vue';
import { Loading } from '@element-plus/icons-vue'
import MarkdownIt from 'markdown-it'
import katex from 'katex'
import 'katex/dist/katex.min.css'
import { useChatStore } from "@/store/index"
import docxIcon from "@/assets/docx.png"
import pdfIcon from "@/assets/pdf.png"
import CitationList from "@/components/CitationList.vue"

const chat = useChatStore()

// Markdown 渲染器：禁用原生 HTML（防注入）、自动识别链接、单换行也生效（聊天文本习惯）
const md = new MarkdownIt({
  html: false,
  linkify: true,
  breaks: true,
})

// 引用角标：把正文中的 [1] 渲染成可点击的上标（只在 html:false 下注入 html_inline，
// 不影响代码块/链接；编号超出本次 citations 范围时按普通文本保留）
md.inline.ruler.after('link', 'citation_ref', (state: any, silent: boolean) => {
  const pos = state.pos
  if (state.src.charCodeAt(pos) !== 0x5b /* [ */) return false
  const matched = /^\[(\d{1,2})\]/.exec(state.src.slice(pos, pos + 4))
  if (!matched) return false
  const index = Number(matched[1])
  const limit = Number(state.env?.citationCount || 0)
  if (index < 1 || index > limit) return false
  if (!silent) {
    const token = state.push('html_inline', '', 0)
    token.content = `<sup class="cite-ref" data-cite="${index}">[${index}]</sup>`
  }
  state.pos += matched[0].length
  return true
})

// LaTeX 公式提取：$$...$$（块级，可跨行）、\[...\]、\(...\)、$...$（行内，不跨行）
// 先抽成占位符再走 markdown，防止公式里的 * _ | 等字符被 markdown 误解析，
// 也避免流式输出时 $$ 块被 breaks 拆成多个文本节点导致 KaTeX 无法识别
const MATH_RE = /\$\$([\s\S]+?)\$\$|\\\[([\s\S]+?)\\\]|\\\(([\s\S]+?)\\\)|\$([^$\n]+?)\$/g
const PLACEHOLDER_RE = /@@KATEX(\d+)@@/g

const renderMarkdown = (text: string, citationCount = 0): string => {
  // 1. 抽取数学公式，替换为占位符
  const mathSegments: { display: boolean; tex: string }[] = []
  const preprocessed = text.replace(MATH_RE, (_m, blockDollar, blockBracket, inlineParen, inlineDollar) => {
    const display = blockDollar !== undefined || blockBracket !== undefined
    const tex = (blockDollar ?? blockBracket ?? inlineParen ?? inlineDollar ?? '').trim()
    // 纯数字+空格的内容（如价格 $5 和 $10）不当公式处理，原样保留
    if (tex === '' || (/^[\d\s.,]+$/.test(tex) && !display)) return _m
    mathSegments.push({ display, tex })
    const token = `@@KATEX${mathSegments.length - 1}@@`
    // 块级公式前后补空行，让 markdown 把它当成独立段落
    return display ? `\n\n${token}\n\n` : token
  })
  // 2. markdown 渲染（citationCount 控制哪些 [N] 可以渲染成角标）
  let html = md.render(preprocessed, { citationCount })
  // 3. 占位符替换为 KaTeX 渲染结果（渲染失败时回退为原文，不阻断回复展示）
  html = html.replace(PLACEHOLDER_RE, (_m, i) => {
    const seg = mathSegments[Number(i)]
    if (!seg) return _m
    try {
      return katex.renderToString(seg.tex, {
        displayMode: seg.display,
        throwOnError: false,
        strict: false,
      })
    } catch {
      return seg.tex
    }
  })
  return html
}

// 点击正文里的 [N]：滚动到同一条消息下的出处卡片并高亮
const handleCiteClick = (event: MouseEvent): void => {
  const target = event.target as HTMLElement | null
  const cite = target?.closest('.cite-ref') as HTMLElement | null
  if (!cite) return
  const messageEl = cite.closest('.ai-message')
  const card = messageEl?.querySelector<HTMLElement>(
    `.citation-item[data-cite-card="${cite.dataset.cite}"]`
  )
  if (!card) return
  card.scrollIntoView({ behavior: 'smooth', block: 'center' })
  card.classList.add('is-flash')
  window.setTimeout(() => card.classList.remove('is-flash'), 1200)
}

// 文件大小展示：兼容字节数与 "12KB" 这类已格式化的字符串
const formatSize = (size: string | number): string => {
  const n = Number(size)
  if (Number.isNaN(n)) return String(size)
  if (n < 1024) return n + 'B'
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + 'KB'
  return (n / (1024 * 1024)).toFixed(1) + 'MB'
}

// 新消息或流式内容更新时滚动到底部
watch(
  () => [chat.messageList.length, chat.messageList[chat.messageList.length - 1]?.content],
  async () => {
    await nextTick()
    window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' })
  }
)
</script>

<style scoped>
/* 样式层 */
.chat-window {
  flex: 1;
  min-width: 0;
  margin-left: 230px;
  padding-bottom: 180px; /* 给底部固定输入框留出空间 */
}
.chat-welcome {
  display: flex;
  flex-direction: column;
  justify-content: center;
  align-items: center;
  height: 70vh;
}
.display-image {
  width: 280px;
  margin-bottom: 24px;
}
.greeting-title {
  font-size: 20px;
  font-weight: 600;
  margin-bottom: 10px;
}
.greeting-span {
  color: #8d8d8d;
}
.chat-message {
  display: flex;
  flex-direction: column;
  max-width: 1000px;
  margin: 0 auto;
  overflow: hidden;
}
.user-message {
  margin-top: 15px;
  max-width: 70%;
  align-self: flex-end;
}
.user-message p{
  line-height: 1.5;
  background-color: #2b82b8;
  border-radius: 10px;
  padding: 10px;
  color: #ffffff;
  white-space: pre-wrap;
  word-break: break-word;
}
.image-view {
  display: block;
  align-self: flex-end;
  max-width: min(420px, 72%);
  margin-top: 15px;
  border-radius: 12px;
  overflow: hidden;
  border: 1px solid #e4e7ed;
  background-color: #ffffff;
  box-shadow: 0 2px 10px rgba(0, 0, 0, 0.08);
}
.image-view img {
  display: block;
  width: 100%;
  max-height: 320px;
  object-fit: contain;
  background-color: #f6f7fb;
}
.file-view {
  display: flex;
  align-items: center;
  align-self: flex-end;
  flex-flow: wrap;
  margin-top: 15px;
}
.file-item {
  display: inline-flex;
  border: 1px solid #f3f3f3;
  border-radius: 10px;
  padding: 5px;
  align-self: flex-end;
  background-color: #ffffff;
  max-width: 270px;
  margin-left: 5px;
}
.file-item img {
  width: 30px;
  height: 30px;
}
.file-icon {
  display: flex;
  align-items: center;
}
.file-name {
  display: flex;
  flex-direction: column;
  padding-left: 10px;
  min-width: 0;
}
.file-name span:nth-child(1) {
  font-size: 14px;
}
.file-name span:nth-child(2) {
  font-size: 10px;
  color: #8d8d8d;
}
.ai-message {
  margin-top: 15px;
  width: 100%; /* 气泡与对话栏同宽，回复文本宽度始终和对话栏对齐 */
  max-width: 100%;
  align-self: stretch;
  background-color: #ffffff;
  padding: 14px 20px;
  border-radius: 10px;
  box-sizing: border-box;
  overflow: hidden; /* 内容一律收进气泡内，不允许溢出到气泡背景之外 */
}
.ai-content {
  width: 100%;
  box-sizing: border-box;
  word-break: break-word;
  overflow-wrap: anywhere; /* 超长无空格内容（URL、代码）也能在气泡内折行 */
  line-height: 1.7;
}
/* Markdown 排版（v-html 内容需用 :deep 命中） */
.ai-content :deep(p) {
  margin: 8px 0;
  display: block;
}
.ai-content :deep(p:first-child) { margin-top: 0; }
.ai-content :deep(p:last-child) { margin-bottom: 0; }
.ai-content :deep(h1),
.ai-content :deep(h2),
.ai-content :deep(h3),
.ai-content :deep(h4) {
  margin: 14px 0 8px;
  font-weight: 600;
  line-height: 1.4;
}
.ai-content :deep(h1) { font-size: 20px; }
.ai-content :deep(h2) { font-size: 18px; }
.ai-content :deep(h3) { font-size: 17px; }
.ai-content :deep(h4) { font-size: 16px; }
.ai-content :deep(ul),
.ai-content :deep(ol) {
  padding-left: 22px;
  margin: 8px 0;
}
.ai-content :deep(li) { margin: 4px 0; }
.ai-content :deep(code) {
  font-family: Consolas, Monaco, monospace;
  font-size: 14px;
  background-color: #f0f2f5;
  padding: 2px 6px;
  border-radius: 4px;
}
.ai-content :deep(pre) {
  background-color: #f6f8fa;
  border: 1px solid #eceef3;
  border-radius: 8px;
  padding: 12px;
  margin: 10px 0;
  overflow-x: auto; /* 长代码行内部滚动，不撑破气泡 */
}
.ai-content :deep(pre code) {
  background: transparent;
  padding: 0;
}
.ai-content :deep(blockquote) {
  border-left: 3px solid #d3d6e0;
  padding-left: 12px;
  margin: 8px 0;
  color: #666;
}
.ai-content :deep(a) { color: #2b82b8; }
/* 正文引用角标 [N] */
.ai-content :deep(.cite-ref) {
  color: #0866a0;
  cursor: pointer;
  font-size: 0.72em;
  vertical-align: super;
  line-height: 0;
  padding: 0 1px;
}
.ai-content :deep(.cite-ref:hover) {
  text-decoration: underline;
}
.ai-content :deep(table) {
  border-collapse: collapse;
  margin: 10px 0;
  display: block;
  overflow-x: auto;
}
.ai-content :deep(th),
.ai-content :deep(td) {
  border: 1px solid #e3e5ee;
  padding: 6px 10px;
}
.ai-content :deep(hr) {
  border: none;
  border-top: 1px solid #e3e5ee;
  margin: 12px 0;
}
.ai-content :deep(img) { max-width: 100%; }
/* KaTeX 数学公式 */
.ai-content :deep(.katex-display) {
  margin: 12px 0;
  overflow-x: auto; /* 超长公式内部滚动，不撑破气泡 */
  overflow-y: hidden;
  padding: 4px 0;
}
.ai-content :deep(.katex) { font-size: 1.05em; }
.loading-circle {
  display: flex;
  align-items: center;
  color: #8d8d8d;
}
.loading-circle .el-icon {
  margin-right: 6px;
}
.read-file-collapse {
  margin-bottom: 8px;
  border: none;
}
.read-file-title {
  color: #0866a0;
  font-size: 15px;
}
.read-file-list {
  color: #575867;
  font-size: 13px;
  line-height: 1.8;
}
.ai-message :deep(.el-collapse-item__header){
  color: #0866a0;
  font-size: 15px;
  border: none;
  height: 32px;
}
.ai-message :deep(.el-collapse-item__wrap) {
  border: none;
}
.ai-message :deep(.el-collapse-item__content) {
  background-color: #ffffff;
  padding-bottom: 0 !important;
  padding-left: 5px
}
</style>
