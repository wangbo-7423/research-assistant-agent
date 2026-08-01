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
          v-if="uploadFileItem.length <= 0 && !uploadImageItem"
        >
          <div class="query-kb">
            <img src="../assets/knowledge.png" alt="">
            <span>知识库问答</span>
          </div>
        </el-button>

        <!-- 图片上传：一次识别一张图片 -->
        <input
          type="file"
          :accept="uploadImageType.join(',')"
          style="display: none"
          @change="handleImageUpload"
          ref="imageInputRef"
        />
        <el-button
          class="query-kb-button check-report-button"
          :loading="imageUploading"
          :disabled="imageUploading || imageDeleting"
          @click="triggerImageInput"
        >
          <el-tooltip content="上传一张不超过10MB的JPG/PNG/JPEG/WEBP图片，可用于图表识别与分析" effect="customized" placement="top">
            <div class="query-kb">
              <img src="../assets/research.png" alt=""/>
              <span>{{ imageUploading ? '图片上传中...' : '上传数据可视化图片' }}</span>
            </div>
          </el-tooltip>
        </el-button>
      </div>

      <!-- 已上传图片预览 -->
      <div class="upload-image-preview" v-if="uploadImageItem">
        <img class="image-thumb" :src="uploadImageItem.imageUrl" :alt="uploadImageItem.fileName">
        <div class="file-info">
          <span class="hidden-text">{{ uploadImageItem.fileName }}</span>
          <span class="file-size">{{ formatFileSize(uploadImageItem.fileSize) }}</span>
        </div>
        <el-icon
          :size="11"
          class="delete-file"
          :class="{ 'is-disabled': imageDeleting || imageUploading }"
          @click="deleteImage"
        ><CloseBold/></el-icon>
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
      <div class="chat-input-content">
        <input
          type="file"
          multiple
          :accept="uploadFileType.join(',')"
          style="display: none"
          @change="handleFileUpload"
          :ref="(el: any) => fileInputRef = el"
        />
        <el-tooltip
          content="每次最多上传3个文件(每个5MB)，仅支持PDF，DOCX文件类型"
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
          placeholder="任何问题都可以问我哦~，shift + enter 换行"
          :autosize="{ minRows: 1, maxRows: 7 }"
          resize="none"
          @keydown="handleKeyDown"
        />
        <el-button @click="sendMessage" :disabled="sending || imageUploading">
          <img src="../assets/send.png" alt="" class="send-icon">
        </el-button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import { CloseBold } from '@element-plus/icons-vue'
import {
  UploadDialogApi,
  DeleteFileApi,
  SendMessageApi,
  UploadImageApi,
  DeleteImageApi,
} from "@/api/request"
import { userFileUploader } from "@/api/getItemChat"
import docxIcon from "@/assets/docx.png"
import pdfIcon from "@/assets/pdf.png"
import { ElLoading, ElMessage } from 'element-plus'
import { projectStore } from '@/store/index'
import type { UploadImageItem, UploadImageRefType } from '@/types/index'

const project = projectStore()

const isActive = ref<boolean>(false)
const userMessage = ref<string>('')
const sending = ref<boolean>(false) // 是否正在等待模型回复，防止重复发送
const imageInputRef = ref<HTMLInputElement | null>(null)
const uploadImageItem = ref<UploadImageItem | null>(null)
const imageUploading = ref<boolean>(false)
const imageDeleting = ref<boolean>(false)

// 使用数组存储支持的文件类型，方便维护和扩展
const uploadFileType = ['application/pdf', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document']
const uploadImageType = ['image/png', 'image/jpeg', 'image/jpg', 'image/webp']
const maxImageSize = 10 * 1024 * 1024

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

const triggerImageInput = (): void => {
  if (!project.userInfo) {
    project.showLoginPopup = true
    return
  }
  if (uploadImageItem.value) {
    ElMessage('一次只能识别一张图片，请先删除当前图片')
    return
  }
  imageInputRef.value?.click()
}

// 本地校验后立即上传到服务端；发送消息时只传递服务端确认过的图片引用
const handleImageUpload = async (event: Event): Promise<void> => {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file) return

  if (!uploadImageType.includes(file.type)) {
    ElMessage('仅支持 JPG、JPEG、PNG、WEBP 图片')
    input.value = ''
    return
  }
  if (file.size <= 0 || file.size > maxImageSize) {
    ElMessage('请上传10MB以内且内容不为空的图片')
    input.value = ''
    return
  }

  imageUploading.value = true
  const formData = new FormData()
  formData.append('file', file)

  try {
    const res = await UploadImageApi(formData)
    const image = res.data?.image
    if (!res.data?.success || !image) {
      throw new Error('图片上传响应格式异常')
    }
    uploadImageItem.value = {
      ...image,
      fileName: file.name,
      fileSize: file.size,
    }
  } catch (error) {
    // HTTP 错误已由响应拦截器统一提示
    console.error('图片上传失败', error)
  } finally {
    imageUploading.value = false
    input.value = '' // 允许重复选择同一张图片
  }
}

// 删除尚未发送的图片；已发送的图片保留在历史记录中用于回显
const deleteImage = async (): Promise<void> => {
  if (!uploadImageItem.value || imageUploading.value || imageDeleting.value) return
  imageDeleting.value = true
  try {
    await DeleteImageApi({ imagePath: uploadImageItem.value.imagePath })
    uploadImageItem.value = null
  } catch (error) {
    console.error('图片删除失败', error)
  } finally {
    imageDeleting.value = false
  }
}

const sendMessage = async () => {
  if (imageUploading.value) {
    ElMessage('图片正在上传，请稍后再发送')
    return
  }

  let content = userMessage.value.trim()
  const hasImage = Boolean(uploadImageItem.value)
  if (!content && !hasImage) {
    ElMessage('请输入内容或上传图片')
    return
  }
  if (!content && hasImage) {
    content = '请识别并分析这张图片'
  }

  // 未登录先引导登录
  if (!project.userInfo) {
    project.showLoginPopup = true
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

  const imageRef: UploadImageRefType | undefined = uploadImageItem.value
    ? {
        imagePath: uploadImageItem.value.imagePath,
        mimetype: uploadImageItem.value.mimetype,
        imageUrl: uploadImageItem.value.imageUrl,
      }
    : undefined

  if (imageRef) {
    isActive.value = false // 图片识别与知识库检索互斥
  }

  project.messageList.push({
      role: 'user',
      content,
      ...(fileRefs.length > 0 && { uploadFileList: fileRefs }),
      ...(fileRefs.length > 0 && { displayContent: content }),
      ...(imageRef && { uploadImageList: imageRef })
    },
    {
      role: 'assistant',
      content: '',
      loadingCircle: true
    }
  )
  // 从数组里取响应式对象，流式更新才能触发视图刷新
  const aiMessageObj = project.messageList[project.messageList.length - 1]

  // 清空输入框、文件列表和图片预览
  userMessage.value = ''
  uploadFileItem.value = []
  uploadImageItem.value = null

  try {
    await SendMessageApi({
      content,
      sessionId: project.sessionId,
      uploadFileList: fileRefs.length > 0 ? fileRefs : undefined,
      uploadImageList: imageRef,
      isKnowledgeBased: imageRef ? false : isActive.value,
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

.send-icon {
  width: 40px;
  height: auto;
  cursor: pointer;
}

.chat-input-content :deep(.el-button) {
  width: 40px;
  height: 32px;
  background: none;
  border: none;
  margin-left: 10px;
}

.check-report-button {
  border: 1px solid #d9d9d9;
  background-color: #ffffff;
}
</style>
