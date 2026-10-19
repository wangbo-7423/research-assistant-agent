import { defineStore } from 'pinia'
import type { MessageListType } from "@/types/index"

/**
 * 后端约定：新会话传字符串 "null"，不是 null / 空串。
 * 见 py-serve/app/chat/service.py: `is_new_session = session_id == "null"`
 */
export const NEW_SESSION_ID = 'null'

const SESSION_STORAGE_KEY = 'sessionId'

/**
 * 对话状态：当前会话 id + 消息列表
 * 内部统一用 null 表示"还没有会话"，只在发请求时通过 sessionIdForApi 转成后端要的 "null"。
 */
export const useChatStore = defineStore('chat', {
  state: () => ({
    sessionId: null as string | null,
    messageList: [] as MessageListType[],
  }),
  getters: {
    // 请求体里用的 sessionId，屏蔽后端 "null" 字符串的约定
    sessionIdForApi: (state): string => state.sessionId ?? NEW_SESSION_ID,
  },
  actions: {
    // 唯一写入口：同时维护内存与 localStorage（新建会话时清掉磁盘上的旧 id）
    setSessionId(sessionId: string | null) {
      this.sessionId = sessionId
      if (sessionId) localStorage.setItem(SESSION_STORAGE_KEY, sessionId)
      else localStorage.removeItem(SESSION_STORAGE_KEY)
    },
    // 新建会话：重置会话 id 并清空消息列表
    resetSession() {
      this.setSessionId(null)
      this.messageList = []
    },
    // 加载历史会话到当前窗口
    loadSession(sessionId: string, chatList: MessageListType[]) {
      this.setSessionId(sessionId)
      this.messageList = chatList
    },
  },
})
