// 后端地址通过环境变量配置（见项目根 .env 的 VITE_API_BASE_URL）。
// 默认仍是本地 3000 端口，保持原有行为不变；部署/换端口时改 .env 即可。
const requestUrl = import.meta.env.VITE_API_BASE_URL || "http://127.0.0.1:3000"
import axios from "axios";
import type{ UserLoginType, UserRegisterType, ApiResponse, UserInfoResType, UploadResponse, UploadImageResponse, kbFileListType, SendMessageType, AiMessageType, MessageListType, SessionListItemType } from "@/types/index"
import { projectStore } from "@/store/index"

// 注意：不要在模块顶层调用 projectStore()，
// 本模块会在 main.ts 完成 app.use(pinia) 之前被加载，顶层调用会报 "active pinia" 错误。
// 统一在函数/拦截器执行时惰性获取。
const getStore = () => projectStore()

// 创建一个实例
const axiosInstance= axios.create({
  baseURL: requestUrl,
  timeout: 10000,
  headers: {
    'Content-Type': 'application/json'
  }
})
// 拦截器：请求之前
axiosInstance.interceptors.request.use(
  (config) => {
    const project = getStore()
    config.headers.Authorization = "Bearer " + (project.userInfo?.token || "");

    // FormData 上传时删除默认 Content-Type，让浏览器自动设置 multipart/form-data + boundary
    if (config.data instanceof FormData) {
      delete config.headers['Content-Type'];
    }

    return config
  },
  (error) => {
    return Promise.reject(error)
  }
)

// 拦截器：请求之后
axiosInstance.interceptors.response.use(
  (response) => {
    return response.data
  },
  (error: any) => {
    console.log(error)
    const status = error.response?.status
    const message = error.response?.data?.message

    if (error.response) {
      const tip = typeof message === 'string' ? message : message?.[0]
      switch (status) {
        case 404:
          ElMessage('接口不存在或者请求方式不对');
          break;
        case 422:
          ElMessage(tip || '请求参数错误')
          break;
        case 400:
          ElMessage(tip || '请求错误')
          break;
        case 401:
          // token 缺失或失效：弹出登录框
          getStore().showLoginPopup = true
          break;
        default:
          ElMessage(tip || '服务器异常')
      }
    } else {
      ElMessage('网络连接失败，请检查后端服务是否启动')
    }
    return Promise.reject(error)
  }
)

// 用户请求和模型对话，模型流式输出
// aiMessageObj 必须是 project.messageList 中的响应式对象（push 之后从数组里取），
// 这样增量修改 content/readFileData 才能触发视图更新
export const SendMessageApi = async(params:SendMessageType, aiMessageObj: MessageListType) => {
  const project = getStore()
  const { content, sessionId, uploadFileList, uploadImageList, isKnowledgeBased } = params
  const body:Record<string, any> = {
    content,
    sessionId,
    isKnowledgeBased,
  }
  if (uploadFileList && uploadFileList.length > 0) {
    body.uploadFileList = uploadFileList
  }
  if (uploadImageList) {
    body.uploadImageList = uploadImageList
  }
  const response = await fetch(`${requestUrl}/chat/sendmessage`,{
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + (project.userInfo?.token || '')
    },
    body: JSON.stringify(body)
  })
  if(!response.ok) {
    const errorText = await response.text()
    console.log('发送失败', errorText)
    ElMessage('发送失败,你可以尝试重试')
    aiMessageObj.loadingCircle = false
    throw new Error('发送失败' + errorText)
  }
  const reader = response.body?.getReader()
  if (!reader) {
    ElMessage('发送失败,你可以尝试重试')
    aiMessageObj.loadingCircle = false
    throw new Error('发送失败')
  }

  // 处理单个 JSON 块
  const handleChunk = (aiMessage: AiMessageType) => {
    // 新会话id
    if(aiMessage.type === 'sessionId' && aiMessage.sessionId){
      project.getSessionId(aiMessage.sessionId)
      return
    }
    // 阅读文档 / 检索知识库的状态通知
    if(aiMessage.type === 'readDocument' || aiMessage.type === 'queryKB'){
      aiMessageObj.readFileData = {
        type: aiMessage.type,
        statusInfo: aiMessage.statusInfo || 'completed',
        promptInfo: aiMessage.promptInfo || '',
        fileList: aiMessage.fileList || [],
      }
      return
    }
    // 模型增量回复
    if(aiMessage.type === 'answer' && aiMessage.content){
      aiMessageObj.content += aiMessage.content
      return
    }
    // 服务端错误通知
    if(aiMessage.type === 'error'){
      ElMessage(aiMessage.content || '服务异常，请稍后重试')
    }
  }

  // TCP 分片可能把一个 JSON 块切开，需要先累积缓冲区再按分隔符切分
  const decoder = new TextDecoder()
  let buffer = ''
  while(true){
    const {done, value} = await reader.read()
    if (done) {
      break
    }
    buffer += decoder.decode(value, {stream: true})
    const parts = buffer.split('###ABC###')
    // 最后一段可能不完整，留到下次拼接
    buffer = parts.pop() || ''
    for (const part of parts) {
      if(part.trim() === '') {
        continue
      }
      try {
        handleChunk(JSON.parse(part) as AiMessageType)
      } catch (e) {
        console.log('流式数据解析失败', part, e)
      }
    }
  }
  // 冲刷解码器并处理缓冲区里剩余的最后一块
  buffer += decoder.decode()
  if(buffer.trim() !== ''){
    try {
      handleChunk(JSON.parse(buffer) as AiMessageType)
    } catch (e) {
      console.log('流式数据解析失败', buffer, e)
    }
  }
  aiMessageObj.loadingCircle = false
}

// 注册接口
export const UserRegisterApi = (params:UserRegisterType):Promise<ApiResponse<[]>> => {
  return axiosInstance.post('/userinfo/registeruser', params)
}
// 登录接口
export const UserLoginApi = (params:UserLoginType):Promise<ApiResponse<UserInfoResType>> => {
  return axiosInstance.post('/userinfo/loginuser', params)
}
// 对话框上传文件
export const UploadDialogApi = (params:FormData):Promise<UploadResponse> => {
  return axiosInstance.post('/fileanagement/dialog', params, { timeout: 120000 })
}
// 对话框删除指定文件
export const DeleteFileApi = (params:{id:string}):Promise<ApiResponse<[]>> => {
  return axiosInstance.delete(`/fileanagement/dialog/${params.id}`)
}
// 上传待识别图片
export const UploadImageApi = (params:FormData):Promise<UploadImageResponse> => {
  return axiosInstance.post('/fileanagement/uploadimage', params, { timeout: 120000 })
}
// 删除待识别图片
export const DeleteImageApi = (params:{imagePath:string}):Promise<ApiResponse<{success:boolean}>> => {
  return axiosInstance.post('/fileanagement/deleteimage', params)
}
// 知识库文件上传
export const UploadkbApi = (params:FormData):Promise<UploadResponse> => {
  return axiosInstance.post('/fileanagement/knowledge', params, { timeout: 120000 })
}
// 知识库删除指定文件
export const DeletekbFileApi = (params:{id:string}):Promise<ApiResponse<[]>> => {
  return axiosInstance.delete(`/fileanagement/knowledge/${params.id}`)
}
// 获取知识库文件列表
export const GetkbFileListApi = ():Promise<ApiResponse<{result: kbFileListType, message: string}>> => {
  return axiosInstance.get('/fileanagement/kbfilelist')
}
// 获取会话列表
export const GetSessionListApi = ():Promise<ApiResponse<SessionListItemType[]>> => {
  return axiosInstance.get('/chat/sessionlist')
}
// 删除指定会话
export const DeleteSessionApi = (params:{sessionId:string}):Promise<ApiResponse<{deleted:boolean}>> => {
  return axiosInstance.delete('/chat/deletesession', { params: { sessionId: params.sessionId } })
}
// 获取某个会话的完整对话记录
export const GetHistoryApi = (sessionId:string):Promise<ApiResponse<{sessionId: string, chatList: MessageListType[]}>> => {
  return axiosInstance.get('/chat/history', { params: { sessionId } })
}
