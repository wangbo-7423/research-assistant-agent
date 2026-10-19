// 文件上传（对话框、知识库）
import { ref } from "vue"
import type { UploadResponse, UploadFileItem } from "@/types/index"
import { useUserStore } from "@/store/index"
import { ElLoading } from "element-plus";

interface UserFileUploaderOptions {
  page: "knowledge" | "chatinput";
  uploadApi: (formData: FormData) => Promise<UploadResponse>
}

export function userFileUploader(options: UserFileUploaderOptions) {
    // 临时存储上传的文件
    const uploadFileItem = ref<UploadFileItem[]>([])
    // 调用input上传
    const fileInputRef = ref<HTMLInputElement | null>(null)

    /** 触发文件输入框的点击事件 */
    const triggerFileInput = () => {
        fileInputRef.value?.click()
    }

    /** 本地上传文件后触发 */
    const handleFileUpload = async (env: Event) => {
        const input = env.target as HTMLInputElement
        const files = input.files
        if (!files || files.length === 0) return
        // 如果没有登录，禁止上传
        if (!useUserStore().isLogin) {
            ElMessage('请先登录')
            input.value = ''
            return
        }
        // 每次最多选择三个文件
        if (files.length > 3) {
            input.value = ''
            ElMessage('每次最多选择三个文件')
            return
        }
        // 如果是对话框上传文件，最多只能上传三个文件
        if(options.page === 'chatinput'){
            if(uploadFileItem.value.length >= 3){
                input.value = ''
                ElMessage('最多只能上传三个文件')
                return
            }
        }
        // 先校验文件类型和大小，全部合法才进入上传流程（避免 loading 泄漏）
        const allowedTypes = ['application/pdf','application/vnd.openxmlformats-officedocument.wordprocessingml.document']
        const maxsize = 5 * 1024 * 1024
        for (const file of files) {
            if(!allowedTypes.includes(file.type) || file.size > maxsize){
                input.value = ''
                ElMessage('请上传5M以内的PDF或Word文件')
                return
            }
        }
        // loading加载提示
        const loading = ElLoading.service({
            lock: true,
            text: '文档解析中...',
            background: 'rgba(0, 0, 0, 0.4)'
        })
        // 构建 FormData，后端 FilesInterceptor 固定接收字段名 "file"
        const formData = new FormData()
        for (const file of files) {
            formData.append('file', file)
        }
        // 记录现有数量
        const existingCount = uploadFileItem.value.length
        // 视图层展示
        const formDataFiles = formData.getAll('file') as File[]
        formDataFiles.forEach((file) => {
            uploadFileItem.value.push({
                id: '',
                fileName: file.name,
                fileSize: file.size, // 统一存字节数，展示层再换算
                fileType: file.type === 'application/pdf' ? 'pdf' : 'docx',
            } as UploadFileItem)
        })
        try {
            const res = await options.uploadApi(formData)
            const files = res.data.files || []
            files.forEach((file: UploadFileItem, index: number) => {
                const targetIndex = existingCount + index
                uploadFileItem.value[targetIndex] = {
                    id: file.id,
                    fileName: file.fileName,
                    fileSize: Number(file.fileSize), // 后端返回字节数
                    fileType: file.fileType,
                }
            })
            loading.close()
        } catch (error: any) {
            loading.close()
            const errMsg = error?.response?.data?.message || error?.message || '文件上传失败'
            ElMessage(typeof errMsg === 'string' ? errMsg : errMsg?.[0] || '文件上传失败')
            uploadFileItem.value = uploadFileItem.value.filter((item) => item.id != '')
        } finally {
            // 清空 input，允许重复选择同一文件
            input.value = ''
        }
    }

    return {
        uploadFileItem,
        fileInputRef,
        triggerFileInput,
        handleFileUpload
    }
}