<template>
  <!-- 登录界面 -->
  <el-dialog
    v-model="project.showLoginPopup"
    width="400px"
    append-to-body :close-on-click-modal="false"
    :close-on-press-escape="false"
    align-center
  >
    <el-tabs v-model="activeName" class="demo-tabs">
      <el-tab-pane label="登录" name="Login">
        <el-input v-model="phoneNumber" placeholder="手机号" size="large"></el-input>
        <el-input v-model="passWord" placeholder="密码" size="large" type="password"></el-input>
        <el-button type="primary" size="default" @click="userLogin">登录</el-button>
      </el-tab-pane>
      <el-tab-pane label="注册" name="Register">
        <el-input v-model="phoneNumber" placeholder="手机号" size="large"></el-input>
        <el-input v-model="passWord" placeholder="密码" size="large" type="password"></el-input>
        <el-input v-model="confirmPassWord" placeholder="确认密码" size="large" type="password"></el-input>
        <el-button type="primary" size="default" @click="userRegister">注册</el-button>
      </el-tab-pane>
  </el-tabs>
</el-dialog>

</template>

<script setup lang="ts">
// 逻辑层
import { ref } from 'vue'
import { validators } from '@/utils/validators'
import { UserRegisterApi, UserLoginApi } from "@/api/request"
import { projectStore } from "@/store/index"
const project = projectStore()
const phoneNumber = ref('')
const passWord = ref('')
const activeName = ref('Login')
const confirmPassWord = ref('')

// 登录
const userLogin = async() => {
  try {
    validators.isPhoneNumber(phoneNumber.value)
    validators.isPasswordValid(passWord.value)
    const res = await UserLoginApi({
      phoneNumber: phoneNumber.value,
      password: passWord.value,
    })
    project.userLogin(res.data)
    project.showLoginPopup = false
    ElMessage.success('登录成功')
  } catch {
    // 校验或请求错误已分别由 validators / 拦截器弹窗提示
  }
}

// 注册
const userRegister = async() => {
  try {
    validators.isPhoneNumber(phoneNumber.value)
    validators.isPasswordValid(passWord.value)
    validators.isEqual(passWord.value, confirmPassWord.value)
    await UserRegisterApi({
      phoneNumber: phoneNumber.value,
      password: passWord.value,
      confirmPassWord: confirmPassWord.value,
    })
    ElMessage.success('注册成功，请登录')
    activeName.value = 'Login'
  } catch {
    // 错误已在拦截器中处理（ElMessage 提示），此处静默捕获
  }
}
</script>

<style scoped>
/* 样式层 */
.demo-tabs >>> .el-tabs__item {
  font-size: 16px;
}
.demo-tabs >>> .el-input {
  margin-bottom: 20px;
}
.demo-tabs >>> .el-tab-pane {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-items: center;
}
</style>