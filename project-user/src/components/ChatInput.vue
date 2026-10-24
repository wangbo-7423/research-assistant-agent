<template>
  <!-- 底部输入框 -->
  <div class="chat-input">
    <div class="chat-input-flex">
      <div class="function-select">
        <!-- 查询知识库的按钮：携带文档或图片时自动禁用知识库模式 -->
        <el-button
          class="query-kb-button"
          :class="{ 'is-active': isActive }"
          @click="toggleActive"
          v-if="uploadFileItem.length <= 0 && pastedImages.length <= 0"
        >
          <div class="query-kb">
            <img src="../assets/knowledge.png" alt="">
            <span>知识库问答</span>
          </div>
        </el-button>
      </div>

      <!-- 已粘贴图片预览：一次最多 4 张，可单张删除 -->
      <div class="upload-image-list" v-if="pastedImages.length > 0">
        <div class="upload-image-preview" v-for="image in pastedImages" :key="image.id">
          <img class="image-thumb" :src="image.dataUrl" :alt="image.fileName">
          <div class="file-info">
            <span class="hidden-text">{{ image.fileName }}</span>
            <span class="file-size">{{ formatFileSize(image.fileSize) }}</span>
          </div>
          <el-icon :size="11" class="delete-file" @click="removeImage(image.id)"><CloseBold/></el-icon>
        </div>
      </div>

      <!-- 文件上传的列表 -->
      <div class="upload-file-list" v-if="uploadFileItem && uploadFileItem.length > 0">
        <div class="upload-file-item" v-for="(file, index) in uploadFileItem" :key="file.id || `${file.fileName}-${index}`">
          <img :src="file.fileType === 'pdf' ? pdfIcon : docxIcon" alt="">
          <div class="file-info">
            <span class="hidden-text">{{ file.fileName }}</span>
            <span class="file-size">{{ formatFileSize(file.fileSize) }}</span>
          </div>
          <el-icon :size="11" class="delete-file" @click="deleteFile(file.id, index)"><CloseBold/></el-icon>
        </div>
      </div>

      <!-- 输入框 -->
      <div class="chat-input-content" @paste.capture="handlePaste">
        <input
          type="file"
          multiple
          :accept="uploadAcceptType.join(',')"
          style="display: none"
          @change="handleFilePickerChange"
          :ref="(el: any) => fileInputRef = el"
        />
        <el-tooltip
          content="文档：PDF/DOCX，每个5MB、最多3个；图片：JPG/PNG/WEBP，单张10MB、最多4张"
          effect="customized"
          placement="top"
        >
          <div class="upload-icon">
            <img src="../assets/upload.png" alt="" @click="triggerFileInput">
          </div>
        </el-tooltip>
        <el-input
          v-model="userMessage"
          type="textarea"
          placeholder="输入问题，可粘贴（Ctrl+V）或点左侧图标上传图片/文档，shift + enter 换行"
          :autosize="{ minRows: 1, maxRows: 7 }"
          resize="none"
          @keydown="handleKeyDown"
        />
        <el-button class="send-button" @click="sendMessage" :disabled="sending">
          <el-icon :size="18"><Promotion /></el-icon>
        </el-button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import { CloseBold, Promotion } from '@element-plus/icons-vue'
import {
  UploadDialogApi,
  DeleteFileApi,
  SendMessageApi,
} from "@/api/request"
import { userFileUploader } from "@/api/getItemChat"
import docxIcon from "@/assets/docx.png"
import pdfIcon from "@/assets/pdf.png"
import { ElLoading, ElMessage } from 'element-plus'
import { useUserStore, useChatStore, useUiStore } from '@/store/index'
import type { InlineImagePayload, PastedImageItem, UploadImageRefType } from '@/types/index'
import { ACCEPTED_IMAGE_TYPES, MAX_IMAGE_COUNT, extractClipboardImages, isSupportedImage, prepareImage } from '@/utils/image'

const user = useUserStore()
const chat = useChatStore()
const ui = useUiStore()

const isActive = ref<boolean>(false)
const userMessage = ref<string>('')
const sending = ref<boolean>(false) // 是否正在等待模型回复，防止重复发送
const pasting = ref<boolean>(false) // 粘贴图片的解码/压缩过程
const pastedImages = ref<PastedImageItem[]>([])

// 使用数组存储支持的文件类型，方便维护和扩展
const uploadFileType = ['application/pdf', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document']
// 同一个上传入口同时支持文档与图片（图片在本地压缩，不上传）
const uploadAcceptType = [...uploadFileType, ...ACCEPTED_IMAGE_TYPES]

// 文件上传逻辑
const {
  uploadFileItem,
  fileInputRef,
  triggerFileInput,
  handleFileUpload
} = userFileUploader({ page: "chatinput", uploadApi: UploadDialogApi })

const toggleActive = (): void => {
  isActive.value = !isActive.value
}

// 图片统一入口：粘贴与「选择文件」都走本地压缩，不再调用上传接口
const addImages = async (files: File[], fallbackName?: string): Promise<void> => {
  if (!user.isLogin) {
    ui.openLoginPopup()
    return
  }
  const remaining = MAX_IMAGE_COUNT - pastedImages.value.length
  if (remaining <= 0) {
    ElMessage(`最多一次携带 ${MAX_IMAGE_COUNT} 张图片`)
    return
  }
  if (files.length > remaining) {
    ElMessage(`最多一次携带 ${MAX_IMAGE_COUNT} 张图片，已忽略多余的图片`)
  }
  // 图片与知识库检索互斥，避免两套上下文混在一起
  isActive.value = false

  pasting.value = true
  try {
    for (const file of files.slice(0, remaining)) {
      try {
        pastedImages.value.push(await prepareImage(file, fallbackName))
      } catch (error) {
        ElMessage(error instanceof Error ? error.message : '图片处理失败，请重试')
      }
    }
  } finally {
    pasting.value = false
  }
}

// 粘贴图片：剪贴板里的文件名往往是 hash，统一换成「粘贴的图片」
const handlePaste = async (event: ClipboardEvent): Promise<void> => {
  const files = extractClipboardImages(event)
  if (files.length === 0) return

  // 命中图片时阻止默认粘贴，避免图片二进制/文件名被插进输入框
  event.preventDefault()
  await addImages(files, '粘贴的图片')
}

// 同一个上传入口分流：图片走本地压缩，PDF/DOCX 交回原有的文档上传逻辑
const handleFilePickerChange = async (event: Event): Promise<void> => {
  const input = event.target as HTMLInputElement
  const files = Array.from(input.files || [])
  if (files.length === 0) return

  const images = files.filter(file => isSupportedImage(file.type))
  const documents = files.filter(file => !isSupportedImage(file.type))
  input.value = '' // 允许重复选择同一文件

  if (images.length > 0) {
    await addImages(images, '图片')
  }
  if (documents.length > 0) {
    // 文档仍走 userFileUploader：只把文档交回去，复用其校验/占位/上传逻辑
    await handleFileUpload(event, documents)
  }
}

// 删除尚未发送的图片（纯前端状态，不请求服务端）
const removeImage = (id: string): void => {
  pastedImages.value = pastedImages.value.filter(image => image.id !== id)
}

const sendMessage = async () => {
  if (pasting.value) {
    ElMessage('图片正在处理，请稍后再发送')
    return
  }

  let content = userMessage.value.trim()
  const images: InlineImagePayload[] = pastedImages.value.map(image => ({
    mimetype: image.mimetype,
    data: image.base64,
    fileName: image.fileName,
    fileSize: image.fileSize,
  }))
  if (!content && images.length === 0) {
    ElMessage('请输入内容或粘贴图片')
    return
  }
  if (!content) {
    content = images.length > 1 ? '请识别并分析这些图片' : '请识别并分析这张图片'
  }

  // 未登录先引导登录
  if (!user.isLogin) {
    ui.openLoginPopup()
    return
  }
  if (sending.value) return
  sending.value = true

  // 发送时上传中的文件（id 为空说明还没传完，过滤掉）
  const fileRefs = uploadFileItem.value
    .filter(f => f.id)
    .map(f => ({
      fileName: f.fileName,
      fileSize: String(f.fileSize),
      fileType: f.fileType,
      docId: f.id
    }))

  // 本地消息用 dataURL 预览；历史会话由后端回传的 imagePath/imageUrl 回显
  const imageRefs: UploadImageRefType[] = pastedImages.value.map(image => ({
    imageUrl: image.dataUrl,
    mimetype: image.mimetype,
    fileName: image.fileName,
    fileSize: image.fileSize,
  }))

  if (images.length > 0) {
    isActive.value = false // 图片识别与知识库检索互斥
  }

  chat.messageList.push({
      role: 'user',
      content,
      ...(fileRefs.length > 0 && { uploadFileList: fileRefs }),
      ...(fileRefs.length > 0 && { displayContent: content }),
      ...(imageRefs.length > 0 && { uploadImageList: imageRefs })
    },
    {
      role: 'assistant',
      content: '',
      loadingCircle: true
    }
  )
  // 从数组里取响应式对象，流式更新才能触发视图刷新
  const aiMessageObj = chat.messageList[chat.messageList.length - 1]

  // 清空输入框、文件列表和图片预览
  userMessage.value = ''
  uploadFileItem.value = []
  pastedImages.value = []

  try {
    await SendMessageApi({
      content,
      sessionId: chat.sessionIdForApi,
      uploadFileList: fileRefs.length > 0 ? fileRefs : undefined,
      images: images.length > 0 ? images : undefined,
      isKnowledgeBased: images.length > 0 ? false : isActive.value,
    }, aiMessageObj)
  } catch {
    // 错误提示已在 SendMessageApi 内处理
  } finally {
    aiMessageObj.loadingCircle = false
    sending.value = false
  }
}

const handleKeyDown = (event: KeyboardEvent): void => {
  if (!event.shiftKey && event.key === 'Enter') {
    event.preventDefault()
    sendMessage()
  }
}

const formatFileSize = (bytes: number): string => {
  if (bytes < 1024) return bytes + 'B'
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + 'KB'
  return (bytes / (1024 * 1024)).toFixed(1) + 'MB'
}

// 删除文件
const deleteFile = async (id:string, index: number) => {
  // id 为空说明文件还在上传/解析中，服务端尚未建档，仅移除本地占位项
  if (!id) {
    uploadFileItem.value.splice(index, 1)
    return
  }
  const loading = ElLoading.service({
    lock: true,
    text: '文档删除中...',
    background: 'rgba(0, 0, 0, 0.4)'
  })
  try {
    await DeleteFileApi({id})
    uploadFileItem.value.splice(index, 1)
  } catch (error) {
    console.error('文件删除失败', error)
  } finally {
    loading.close()
  }
}
</script>

<style scoped>
.chat-input {
  background-color: aliceblue;
  position: fixed;
  left: 230px;
  bottom: 0;
  right: 0;
  padding-bottom: 30px;
}

.chat-input-flex {
  display: flex;
  flex-direction: column;
  max-width: 1000px;
  margin: 0 auto;
  background-color: #ffffff;
  border: 1px solid #615ced;
  padding: 15px;
  border-radius: 20px;
  box-shadow: 0 1px 11px 7px rgba(0, 0, 0, 0.1);
  overflow: hidden;
}

.function-select {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}

.query-kb-button {
  width: fit-content;
  padding: 0;
  height: auto;
  border: 1px solid #d9d9d9;
  border-radius: 20px;
  background-color: #ffffff;
  margin: 0 0 10px;
  transition: all 0.3s ease;
  cursor: pointer;
}

.query-kb-button:hover {
  background-color: #f5f0eb;
  border-color: #d0c8c0;
}

.query-kb-button.is-active {
  background-color: #e6f0ff;
  border-color: #409eff;
}

.query-kb-button:active {
  transform: scale(0.97);
}

.query-kb {
  display: flex;
  align-items: center;
  padding: 7px 16px;
}

.query-kb span {
  font-size: 14px;
  padding-left: 6px;
  color: #333333;
}

.query-kb img {
  width: 15px;
  height: 15px;
}

.upload-file-list {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  padding-bottom: 15px;
}

.upload-image-list {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  padding-bottom: 15px;
}

.upload-file-item img {
  width: 30px;
  height: 30px;
  margin-right: 5px;
}

.upload-file-item,
.upload-image-preview {
  display: inline-flex;
  align-items: center;
  border-radius: 10px;
  max-width: 260px;
  margin: 0 10px 15px 0;
  transition: all 0.2s ease;
  border: 1px solid rgb(61, 54, 54) !important;
  padding: 5px;
  position: relative;
}

.upload-image-preview {
  align-self: flex-start;
  background-color: #fafafa;
}

.image-thumb {
  width: 54px;
  height: 54px;
  object-fit: cover;
  border-radius: 8px;
  margin-right: 8px;
  border: 1px solid #e4e7ed;
}

.delete-file {
  position: absolute;
  bottom: 2px;
  right: 4px;
  cursor: pointer;
}

.delete-file.is-disabled {
  cursor: not-allowed;
  opacity: 0.45;
}

.upload-file-item span:nth-child(1) {
  font-size: 14px;
}

.upload-file-item span:nth-child(2) {
  font-size: 10px;
  color: #575867;
}

.file-info {
  display: flex;
  flex-direction: column;
  line-height: 1.4;
  margin-right: 8px;
  min-width: 0;
}

.file-size {
  font-size: 11px;
  color: #999;
}

.chat-input-content {
  display: flex;
  align-items: flex-end;
}

.upload-icon {
  width: 34px;
  height: 34px;
  display: flex;
  align-items: center;
  cursor: pointer;
}

.upload-icon img {
  width: 15px;
  height: 15px;
}

.chat-input-content :deep(.el-textarea__inner):focus {
  box-shadow: none;
  border: none;
}

.chat-input-content :deep(.el-textarea__inner) {
  box-shadow: none;
  background: none;
  font-size: 16px;
}

.chat-input-content :deep(.send-button) {
  width: 34px;
  height: 34px;
  padding: 0;
  border: none;
  border-radius: 50%;
  margin-left: 10px;
  background-color: #615ced;
  color: #ffffff;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  transition: background-color 0.2s ease, transform 0.15s ease;
}

.chat-input-content :deep(.send-button:hover:not(.is-disabled)) {
  background-color: #4f49d6;
  transform: translateY(-1px);
}

.chat-input-content :deep(.send-button.is-disabled) {
  background-color: #c9c7f2;
}

</style>
