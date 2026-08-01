import { ElMessage } from 'element-plus'

export const validators = {
    // 空值校验
    isNotEmpty: (value: string, message="不能为空") => {
        if(value.trim() === '') {
            ElMessage(message)
            throw message;
        }
    },
    // 手机号码校验
    isPhoneNumber: (value: string, message="手机号码格式不正确") => {
        const phoneRegex = /^1[3-9]\d{9}$/;
        if(!phoneRegex.test(value)) {
            ElMessage(message)
            throw message;
        }
    },
    // 密码校验
    isPasswordValid: (value: string, message="密码长度至少8位，且至少包含一个大写字母、一个小写字母和一个数字。") => {
        const pwdRegex = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)[a-zA-Z\d]{8,}$/;
        if(!pwdRegex.test(value)) {
            ElMessage(message)
            throw message;
        }
    },
    isEqual(value1: string, value2: string, message="两次输入的密码不一致") {
        if(value1.trim() !== value2.trim()) {
            ElMessage(message)
            throw message;
        }
    }
}