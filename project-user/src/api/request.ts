// 后端地址通过环境变量配置（见项目根 .env 的 VITE_API_BASE_URL）。
// 默认仍是本地 3000 端口，保持原有行为不变；部署/换端口时改 .env 即可。
const requestUrl = import.meta.env.VITE_API_BASE_URL || "http://127.0.0.1:3000"
import { fetchEventSource } from '@microsoft/fetch-event-source'
import axios from "axios";
import type{ UserLoginType, UserRegisterType, ApiResponse, UserInfoResType, UploadResponse, UploadImageResponse, kbFileListType, SendMessageType, AiMessageType, MessageListType, SessionListItemType } from "@/types/index"
import { useUserStore, useChatStore, useUiStore } from "@/store/index"

// 注意：不要在模块顶层调用 useXxxStore()，
// 本模块会在 main.ts 完成 app.use(pinia) 之前被加载，顶层调用会报 "active pinia" 错误。
// 统一在函数 / 拦截器真正执行时再取（此时 pinia 已安装）。

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
    config.headers.Authorization = "Bearer " + useUserStore().token

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
          useUiStore().openLoginPopup()
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
// aiMessageObj 必须是 chatStore.messageList 中的响应式对象（push 之后从数组里取），
// 这样增量修改 content/readFileData 才能触发视图更新
export const SendMessageApi = async(params:SendMessageType, aiMessageObj: MessageListType) => {
  const userStore = useUserStore()
  const chatStore = useChatStore()
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
  // 处理单个 JSON 块
  const handleChunk = (aiMessage: AiMessageType) => {
    // 新会话id
    if(aiMessage.type === 'sessionId' && aiMessage.sessionId){
      chatStore.setSessionId(aiMessage.sessionId)
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

  // SSE 流式对话。
  // 这里不用 EventSource 而用 fetch：本接口需要 POST + Authorization 请求头 + JSON 请求体，
  // 这三样 EventSource 一律不支持（它只能发无自定义头、无 body 的 GET）。
  // @microsoft/fetch-event-source 正是用 fetch 实现的 SSE 客户端，保留了上述能力，
  // 并负责半包、多行 data、注释行等协议细节，因此无需再手工累积缓冲区切分。
  try {
    await fetchEventSource(`${requestUrl}/chat/sendmessage`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + userStore.token
      },
      body: JSON.stringify(body),

      // 页面切到后台时保持连接（库默认会主动断开），否则用户切走标签页回答就中断了
      openWhenHidden: true,

      // 响应头就绪：非 2xx 时后端返回的是普通 JSON 错误体而非 SSE 流，必须在此拦截
      async onopen(response) {
        if (!response.ok) {
          const errorText = await response.text()
          console.log('发送失败', errorText)
          ElMessage('发送失败,你可以尝试重试')
          throw new Error('发送失败' + errorText)
        }
      },

      // 每收到一帧消息，data 字段已由库按 SSE 规范切分好
      onmessage(ev) {
        if (!ev.data) return
        try {
          handleChunk(JSON.parse(ev.data) as AiMessageType)
        } catch (e) {
          console.log('流式数据解析失败', ev.data, e)
        }
      },

      // 出错或断流：必须抛出以禁用库的默认自动重连。
      // 重连会重新 POST 一遍完整问题，导致 LLM 重复计费、重复创建回答。
      onerror(err) {
        throw err
      },
    })
  } finally {
    aiMessageObj.loadingCircle = false
  }
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
  return axiosInstance.post('/file_management/dialog', params, { timeout: 120000 })
}
// 对话框删除指定文件
export const DeleteFileApi = (params:{id:string}):Promise<ApiResponse<[]>> => {
  return axiosInstance.delete(`/file_management/dialog/${params.id}`)
}
// 上传待识别图片
export const UploadImageApi = (params:FormData):Promise<UploadImageResponse> => {
  return axiosInstance.post('/file_management/uploadimage', params, { timeout: 120000 })
}
// 删除待识别图片
export const DeleteImageApi = (params:{imagePath:string}):Promise<ApiResponse<{success:boolean}>> => {
  return axiosInstance.post('/file_management/deleteimage', params)
}
// 知识库文件上传
export const UploadkbApi = (params:FormData):Promise<UploadResponse> => {
  return axiosInstance.post('/file_management/knowledge', params, { timeout: 120000 })
}
// 知识库删除指定文件
export const DeletekbFileApi = (params:{id:string}):Promise<ApiResponse<[]>> => {
  return axiosInstance.delete(`/file_management/knowledge/${params.id}`)
}
// 获取知识库文件列表
export const GetkbFileListApi = ():Promise<ApiResponse<{result: kbFileListType, message: string}>> => {
  return axiosInstance.get('/file_management/kbfilelist')
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
