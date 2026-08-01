import { defineStore } from 'pinia';
import type { UserInfoResType, MessageListType } from "@/types/index"

export const projectStore = defineStore('app', {
  state: () => ({//临时存储，暂存状态
    userInfo: null as UserInfoResType | null,// 用户信息
    showLoginPopup: false, // 是否显示登录弹窗
    knowledgePopup: false, // 是否显示知识库弹窗
    sessionId: 'null', // 会话id（'null' 表示新会话）
    messageList: [] as MessageListType[], // 消息列表
  }),
  actions: {
    // 登录之后获取用户信息
    userLogin(userInfo: UserInfoResType) {
      this.userInfo = userInfo
      localStorage.setItem('userInfo', JSON.stringify(userInfo))
    },
    // 退出登录：清空用户信息与当前会话
    userLogout() {
      this.userInfo = null
      localStorage.removeItem('userInfo')
      this.resetSession()
    },
    // 模型返回的会话id需要本地缓存
    getSessionId(sessionId: string) {
      this.sessionId = sessionId
      localStorage.setItem('sessionId', sessionId)
    },
    // 新建会话：重置会话id并清空消息列表
    resetSession() {
      this.sessionId = 'null'
      localStorage.setItem('sessionId', 'null')
      this.messageList = []
    },
    // 加载历史会话到当前窗口
    loadSession(sessionId: string, chatList: MessageListType[]) {
      this.sessionId = sessionId
      localStorage.setItem('sessionId', sessionId)
      this.messageList = chatList
    },
    // 页面刷新后初始化
    initUserFromStorage() {
    // 用户信息
        const userInfo = localStorage.getItem('userInfo')
        if (userInfo) {
          this.userInfo = JSON.parse(userInfo)
        }
    }
  }
})
