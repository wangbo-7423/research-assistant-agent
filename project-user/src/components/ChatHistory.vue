<template>
  <!-- 左侧边栏：消息列表 -->
  <div class="chat-history-view">
    <div class="new-dialog">
      <el-button type="success" @click="newSession">新建会话</el-button>
    </div>
    <div style="height: 80px"></div>
    <div
      class="dialog-list"
      v-for="item in sessionList"
      :key="item.sessionId"
      :class="{ 'is-active': item.sessionId === chat.sessionId }"
      @click="openSession(item.sessionId)"
    >
      <div class="dialog-list-row">
        <div class="dialog-list-item hidden-text">{{ item.title }}</div>
        <el-dropdown trigger="click" @command="(command: string) => handleSessionCommand(command, item)">
          <span class="dialog-more" @click.stop title="更多操作">
            <el-icon><MoreFilled /></el-icon>
          </span>
          <template #dropdown>
            <el-dropdown-menu>
              <el-dropdown-item command="delete">
                <el-icon color="#f56c6c"><Delete /></el-icon>
                <span style="color: #f56c6c">删除对话</span>
              </el-dropdown-item>
            </el-dropdown-menu>
          </template>
        </el-dropdown>
      </div>
      <div class="dialog-list-date">{{ item.createDate }}</div>
    </div>
    <div class="user-info">
      <div class="avatar-name" v-if="user.userInfo">
        <img src="../assets/logo.jpg" alt="用户头像" class="user-avatar" />
        <span>{{ user.userInfo.phonenumber }}</span>
      </div>
      <el-button type="primary" v-else size="default" @click="ui.openLoginPopup()">登录</el-button>
      <div class="user-actions" v-if="user.userInfo">
        <el-button type="primary" size="default" @click="ui.openKnowledgePopup()">知识库管理</el-button>
        <el-button size="default" @click="logout">退出登录</el-button>
      </div>
    </div>
  </div>
</template>

<script setup lang='ts'>
// 逻辑层
import { ref, watch, onMounted } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { MoreFilled, Delete } from '@element-plus/icons-vue'
import { useUserStore, useChatStore, useUiStore } from "@/store/index"
import { GetSessionListApi, GetHistoryApi, DeleteSessionApi } from "@/api/request"
import type { SessionListItemType } from "@/types/index"

const user = useUserStore()
const chat = useChatStore()
const ui = useUiStore()
const sessionList = ref<SessionListItemType[]>([])

// 拉取会话列表
const loadSessionList = async () => {
  if (!user.isLogin) {
    sessionList.value = []
    return
  }
  try {
    const res = await GetSessionListApi()
    sessionList.value = res.data || []
  } catch {
    // 错误提示已在拦截器中处理
  }
}

// 新建会话
const newSession = () => {
  chat.resetSession()
}

// 打开历史会话
const openSession = async (sessionId: string) => {
  if (sessionId === chat.sessionId) return
  try {
    const res = await GetHistoryApi(sessionId)
    chat.loadSession(sessionId, res.data?.chatList || [])
  } catch {
    // 错误提示已在拦截器中处理
  }
}

// 会话项更多操作
const handleSessionCommand = (command: string, item: SessionListItemType) => {
  if (command === 'delete') deleteSession(item)
}

// 删除会话：二次确认后调用接口，并同步本地状态
const deleteSession = async (item: SessionListItemType) => {
  try {
    await ElMessageBox.confirm(`确定删除对话「${item.title}」吗？删除后不可恢复`, '删除对话', {
      confirmButtonText: '删除',
      cancelButtonText: '取消',
      type: 'warning',
    })
  } catch {
    return // 用户取消
  }
  try {
    await DeleteSessionApi({ sessionId: item.sessionId })
    sessionList.value = sessionList.value.filter(s => s.sessionId !== item.sessionId)
    // 删除的是当前正在查看的会话时，重置为空白新会话
    if (item.sessionId === chat.sessionId) chat.resetSession()
    ElMessage.success('对话已删除')
  } catch {
    // 错误提示已在拦截器中处理
  }
}

// 退出登录
const logout = () => {
  user.userLogout()
}

// 登录状态变化时刷新会话列表；当前会话产生新消息（标题/条数变化）后也刷新
watch(() => user.userInfo, loadSessionList)
watch(() => chat.messageList.length, () => {
  if (user.isLogin) loadSessionList()
})
onMounted(loadSessionList)
</script>

<style scoped>
/* 样式层 */
.chat-history-view {
  width: 230px;
  position: fixed;
  background-color: #ffffff;
  top: 0;
  bottom: 0;
  left: 0;
  overflow-y: auto;
}
.new-dialog {
  position: fixed;
  top: 0;
  left: 0;
  width: 230px;
  height: 80px;
  display: flex;
  align-items: center;
  justify-content: center;
  background-color: #ffffff;
  z-index: 1;
}
.dialog-list {
  margin: 10px;
  padding: 8px;
  border-radius: 8px;
  cursor: pointer;
}
.dialog-list:hover {
  background-color: #f3f2ff;
}
.dialog-list:hover .dialog-list-item {
  color: #615ced
}
.dialog-list.is-active {
  background-color: #f3f2ff;
}
.dialog-list.is-active .dialog-list-item {
  color: #615ced
}
.dialog-list-date {
  font-size: 12px;
  color: #b0b0b0;
  margin-top: 4px;
}
.dialog-list-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.dialog-list-row .dialog-list-item {
  flex: 1;
  min-width: 0;
}
.dialog-more {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  border-radius: 4px;
  color: #909399;
  opacity: 0;
  flex-shrink: 0;
  transition: opacity 0.15s;
}
.dialog-list:hover .dialog-more,
.dialog-list.is-active .dialog-more {
  opacity: 1;
}
.dialog-more:hover {
  background-color: #e4e1ff;
  color: #615ced;
}
.user-info {
  position: fixed;
  bottom: 0;
  left: 0;
  width: 230px;
  height: 120px;
  background-color: #ffffff;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
}
.user-actions {
  display: flex;
}
.avatar-name {
  display: flex;
  align-items: center;
  padding-bottom: 20px;
}
.avatar-name img{
  width: 30px;
  height: 30px;
  object-fit: cover;
  border-radius: 20%;
  margin-right: 7px;
}
</style>
