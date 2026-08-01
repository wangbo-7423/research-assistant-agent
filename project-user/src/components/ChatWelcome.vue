<template>
  <!-- 欢迎界面 -->
  <div class="chat-window">
    <div class="chat-message">
      <img src="../assets/Interface.png" alt="" class="display-image">
      <span class="greeting-title">你好，我是AI科研助手，很高兴见到你</span>
      <span class="greeting-span">我可以协助你检索科研资料、分析相关论文，编写代码进行验证</span>
    </div>
  </div>
</template>

<script>
// 逻辑层

</script>

<style scoped>
/* 样式层 */
.chat-window {
  display: flex;
  margin-left: 230px;
  width: 100%;
  height: 100vh; /* 占满视口高度 */
}

.chat-message {
  display: flex;
  flex-direction: column;
  justify-content: center;
  align-items: center;
  width: 100%;
  max-width: 1000px;
  margin: 0 auto;
  padding: 20px;
}

.display-image {
  width: 280px;
  margin-bottom: 24px; /* 图片和文字之间的间距 */
}

.greeting-title {
  font-size: 25px;
  font-weight: 500;
  color: #333;
  margin-bottom: 12px; /* 标题和副标题之间的间距 */
  text-align: center;
}

.greeting-span {
  font-size: 16px;
  color: #666;
  text-align: center;
}
</style>