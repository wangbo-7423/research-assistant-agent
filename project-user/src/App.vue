<script setup lang="ts">

</script>

<template>
  <router-view />
</template>

<style>
  body {
    margin: 0;
    padding: 0;
    background-color: #f6f7fb;
  }
  p,
  div,
  span {
    font-size: 16px;
    padding: 0;
    margin: 0;
    display: block;
  }
  /* KaTeX 公式由大量嵌套 span 定位组成，上面的全局 span 重置会破坏公式排版；
     用 span + :where()（与 span 重置同优先级、靠源码顺序取胜）还原为行内默认值，
     KaTeX 自身的类样式（优先级更高）不受影响 */
  span:where(.katex, .katex-display),
  :where(.katex, .katex-display) span {
    display: inline;
  }
  .el-popper.is-customized {
  padding: 6px 12px;
  background: #876aff;
  color: #ffffff;
}

.el-popper.is-customized .el-popper__arrow::before {
  background: #876aff;
  right: 0;
}
.hidden-text{
  overflow: hidden;
  text-overflow: ellipsis;
  display: -webkit-box !important;
  -webkit-line-clamp: 1;
  line-clamp: 1;
  -webkit-box-orient: vertical;
  box-sizing: border-box;
}
@media (max-width: 1460px) {
  .chat-message{
    max-width: 900px !important;
  }
  .chat-input-flex{
    max-width: calc(900px - 32px) !important;
  }
}
@media (max-width: 1330px) {
  .chat-message{
    max-width: 800px !important;
  }
  .chat-input-flex{
    max-width: calc(800px - 32px) !important;
  }
}
@media (max-width: 1160px) {
  .chat-message{
    max-width: 700px !important;
  }
  .chat-input-flex{
    max-width: calc(700px - 32px) !important;
  }
}
@media (max-width: 1060px) {
  .chat-message{
    width: 700px !important;
  }
  .chat-input-flex{
    width: calc(700px - 32px) !important;
  }
}
</style>