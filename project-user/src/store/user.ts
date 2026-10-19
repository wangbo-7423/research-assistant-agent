import { defineStore } from 'pinia'
import type { UserInfoResType } from "@/types/index"
import { useChatStore } from '@/store/chat'

const USER_STORAGE_KEY = 'userInfo'

/**
 * 用户会话：登录态 + 用户信息
 * 内存里的 userInfo 负责驱动界面，localStorage 负责撑过刷新，两者在 action 里同步维护。
 */
export const useUserStore = defineStore('user', {
  state: () => ({
    userInfo: null as UserInfoResType | null, // null 表示未登录
  }),
  getters: {
    isLogin: (state) => Boolean(state.userInfo),
    // 未登录时为空串，拼成 "Bearer " 也不会抛错
    token: (state) => state.userInfo?.token || '',
  },
  actions: {
    // 登录成功后写入：内存给 Vue 追踪，磁盘给刷新兜底
    userLogin(userInfo: UserInfoResType) {
      this.userInfo = userInfo
      localStorage.setItem(USER_STORAGE_KEY, JSON.stringify(userInfo))
    },
    // 退出登录：清用户信息与当前会话
    userLogout() {
      this.userInfo = null
      localStorage.removeItem(USER_STORAGE_KEY)
      useChatStore().resetSession()
    },
    // 应用启动时把磁盘里的登录态搬回内存
    initFromStorage() {
      const raw = localStorage.getItem(USER_STORAGE_KEY)
      if (!raw) return
      try {
        this.userInfo = JSON.parse(raw)
      } catch {
        // 数据损坏就当作未登录，顺手清掉脏数据
        localStorage.removeItem(USER_STORAGE_KEY)
      }
    },
  },
})
