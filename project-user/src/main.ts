import { createApp } from 'vue'
import App from './App.vue'
import router from './router/index'
import {  createPinia } from 'pinia'
const pinia = createPinia()

const app = createApp(App)
app.use(router)
app.use(pinia)
app.mount('#app')
// 初始化获取用户数据
import { useUserStore } from "@/store/index.ts"
useUserStore().initFromStorage()