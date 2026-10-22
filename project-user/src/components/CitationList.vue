<template>
  <!-- 知识库回答的出处列表：正文 [N] 与这里的卡片一一对应 -->
  <div class="citation-block" v-if="citations.length > 0">
    <div class="citation-title">参考来源（{{ citations.length }}）</div>
    <div class="citation-list">
      <div
        v-for="cite in citations"
        :key="cite.index"
        class="citation-item"
        :data-cite-card="cite.index"
      >
        <div class="citation-head">
          <span class="citation-index">[{{ cite.index }}]</span>
          <span class="citation-doc" :title="cite.docTitle">{{ cite.docTitle }}</span>
          <span class="citation-loc" v-if="locationText(cite)">{{ locationText(cite) }}</span>
        </div>
        <div class="citation-snippet">{{ cite.snippet }}</div>
        <!-- snippet 只是预览，展开后是模型实际看到的完整片段，便于逐字核对 -->
        <details class="citation-detail" v-if="cite.text && cite.text !== cite.snippet">
          <summary>展开完整片段</summary>
          <div class="citation-full">{{ cite.text }}</div>
        </details>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import type { CitationType } from '@/types/index'

defineProps<{
  citations: CitationType[]
}>()

// 章节 → 页码 → 段序，按可用的信息逐级展示（DOCX 无页码、部分 PDF 无段序）
const locationText = (cite: CitationType): string => {
  const parts: string[] = []
  if (cite.section) parts.push(cite.section)
  if (cite.page > 0) parts.push(`第 ${cite.page} 页`)
  if (cite.para > 0) parts.push(`第 ${cite.para} 段`)
  return parts.join(' · ')
}
</script>

<style scoped>
.citation-block {
  margin-top: 14px;
  padding-top: 10px;
  border-top: 1px dashed #e3e5ee;
}

.citation-title {
  font-size: 13px;
  color: #8d8d8d;
  margin-bottom: 6px;
}

.citation-item {
  padding: 8px 10px;
  border-radius: 8px;
  background-color: #f8fafc;
  margin-bottom: 6px;
  scroll-margin-top: 80px;
  transition: background-color 0.3s ease;
}

.citation-item.is-flash {
  background-color: #fff6da;
}

.citation-head {
  display: flex;
  align-items: baseline;
  flex-wrap: wrap;
  gap: 6px;
  line-height: 1.5;
}

.citation-index {
  color: #0866a0;
  font-weight: 600;
  font-size: 13px;
}

.citation-doc {
  font-size: 13px;
  color: #333333;
  max-width: 60%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.citation-loc {
  font-size: 12px;
  color: #8d8d8d;
}

.citation-snippet {
  margin-top: 4px;
  font-size: 13px;
  line-height: 1.6;
  color: #575867;
  word-break: break-word;
}

.citation-detail {
  margin-top: 4px;
}

.citation-detail summary {
  cursor: pointer;
  font-size: 12px;
  color: #2b82b8;
  user-select: none;
}

.citation-full {
  margin-top: 6px;
  padding: 8px;
  max-height: 320px;
  overflow-y: auto;
  border-radius: 6px;
  background-color: #ffffff;
  border: 1px solid #e9edf5;
  font-size: 13px;
  line-height: 1.7;
  color: #444444;
  white-space: pre-wrap;
  word-break: break-word;
}
</style>
