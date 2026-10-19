<template>
  <el-drawer
    v-model="ui.knowledgePopup"
    title="个人知识库管理"
    append-to-body
    size="600"
  >
    <div class="drawer-content">
      <div class="file-data-list">
        <div v-for="(item, index) in uploadFileItem" :key="index">
          <img :src="item.fileType === 'docx' ? docxIcon : pdfIcon" alt="">
          <span class="hidden-text">{{ item.fileName }} </span>
          <el-icon class="delete-file" @click="deleteFilekb(item.id, index)"><CloseBold /></el-icon>
        </div>
      </div>
      <div class="file-upload">
        <input 
          type="file" 
          multiple 
          :accept="uploadFileType"
          :ref="(el: any) => fileInputRef = el"
          style="display: none;"
          @change="handleFileUpload"
        />
        <el-tooltip 
          content="每次最多上传3个文件(每个5MB)，仅支持PDF，DOCX文件类型"
          effect="customized" 
          placement="top"
        >
          <el-button type="primary" @click="triggerFileInput">
            上传文件
          </el-button>
        </el-tooltip>
      </div>
    </div>

  </el-drawer>
</template>

<script setup lang="ts">
import { CloseBold } from '@element-plus/icons-vue'
import { useUiStore } from "@/store/index"
import { UploadkbApi, DeletekbFileApi, GetkbFileListApi } from "@/api/request"
import { userFileUploader } from "@/api/getItemChat"
import docxIcon from "@/assets/docx.png"
import pdfIcon from "@/assets/pdf.png"
import { ElLoading } from 'element-plus'
import { watch } from 'vue'
const ui = useUiStore()
const uploadFileType = "application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
const { uploadFileItem, fileInputRef, triggerFileInput, handleFileUpload } = userFileUploader({ page: "knowledge", uploadApi: UploadkbApi })
// 删除知识库文件
const deleteFilekb = async (id: string, index: number) => {
    const loading = ElLoading.service({
    lock: true,
    text: '文档删除中...',
    background: 'rgba(0, 0, 0, 0.4)'
  })
  try {
    await DeletekbFileApi({id})
    loading.close()
    uploadFileItem.value.splice(index, 1)
  } catch (error) {
    loading.close()
  }
}
// 请求知识库文件：每次打开抽屉都重新拉取，保证列表是最新的
watch(
  () => ui.knowledgePopup,
  async (newVal) => {
    if(newVal){
      try {
        const res = await GetkbFileListApi()
        const list = res.data?.result || []
        uploadFileItem.value = Array.isArray(list) ? list.map(item => ({
          id: item.id,
          fileName: item.fileName,
          fileSize: Number(item.fileSize) || 0,
          fileType: item.fileType
        })) : []
      } catch {
        // 错误提示已在拦截器中处理
      }
    }
  }
)
</script>

<style scoped>
.drawer-content {
  display: flex;
  flex-direction: column;
  height: 100%;
}

.file-data-list {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(100px, 1fr));
  gap: 20px;
  flex: 1;
  overflow-y: auto;
  padding-bottom: 20px;
}

.file-data-list img {
  width: 70px;
  height: 70px;
}

.file-data-list > div {
  border: 1px solid #888;
  padding: 7px;
  border-radius: 10px;
  position: relative;
  height: fit-content;
}

.delete-file {
  position: absolute;
  top: 4px;
  right: 4px;
  opacity: 0;
  cursor: pointer;
  transition: opacity 0.2s;
}

.file-data-list > div:hover .delete-file {
  opacity: 1;
}

.file-upload {
  flex-shrink: 0;
  height: 70px;
  display: flex;
  justify-content: center;
  align-items: center;
  background-color: #ffffff;
  border-top: 1px solid #eee;
}
</style>