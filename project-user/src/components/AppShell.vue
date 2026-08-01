<template>
  <!-- 视图层 -->>
     <!-- 父组件 -->>
  <div class="chat-layout">
    <ChatHistory></ChatHistory>
    <ChatWindow></ChatWindow>
    <!--<ChatWelcome></ChatWelcome>-->
  </div>
  <ChatInput></ChatInput>
  <Knowledge></Knowledge>
  <UserLogin></UserLogin>
</template>

<script setup lang='ts'>
// 逻辑层
import ChatHistory from "./ChatHistory.vue";
import ChatWindow from "./ChatWindow.vue";
// import ChatWelcome from "./ChatWelcome.vue";
import ChatInput from "./ChatInput.vue";
import Knowledge from "./Knowledge.vue";
import UserLogin from "./UserLogin.vue";
</script>

<style>
/* 样式层 */
.chat-layout {
  display: flex;
  min-height: 100vh; /* 不能用固定 100vh，否则页面高度被锁死、长对话无法向下滚动 */
}
</style>