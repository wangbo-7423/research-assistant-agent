import { defineStore } from 'pinia'

/**
 * 纯界面状态：只放弹窗开关这类"看起来怎样"，不放业务数据。
 * 放 store 是因为弹窗由多个地方触发（顶部按钮、未登录拦截、401 自动弹窗）。
 */
export const useUiStore = defineStore('ui', {
  state: () => ({
    showLoginPopup: false, // 登录弹窗
    knowledgePopup: false, // 知识库管理抽屉
  }),
  actions: {
    openLoginPopup() {
      this.showLoginPopup = true
    },
    closeLoginPopup() {
      this.showLoginPopup = false
    },
    openKnowledgePopup() {
      this.knowledgePopup = true
    },
  },
})
