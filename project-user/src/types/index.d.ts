// 登录传递的参数
export type UserLoginType = {
    phoneNumber: string;
    password: string;
}

// 注册需要的参数
export type UserRegisterType = UserLoginType & {
    confirmPassWord: string;
}

// 所有接口返回的格式
export type ApiResponse<T> = {
	statusCode: number;
	message: string;
	data: T;
	timestamp: string;
	path: string;
};

// 登录接口返回的数据
export type UserInfoResType = {
    token: string;
	phonenumber: string;
}

// 单个文件信息
export interface UploadFileItem {
  id: string;
  fileName: string;
  fileSize: number;
  fileType: string;
}

// 上传接口返回的数据（经过 TransformInterceptor 包装为 ApiResponse 格式）
export type UploadResponse = ApiResponse<{
  success: boolean;
  message: string;
  files: UploadFileItem[];
}>;

// 已上传图片（服务端识别所需的最小字段）
export type UploadImageRefType = {
  imagePath: string;
  mimetype: string;
  imageUrl: string;
}

// 前端图片预览项：在服务端字段基础上补充本地文件名与大小
export type UploadImageItem = UploadImageRefType & {
  fileName: string;
  fileSize: number;
}

// 图片上传接口返回的数据
export type UploadImageResponse = ApiResponse<{
  success: boolean;
  image: UploadImageRefType;
}>;

// 获取知识库文件列表返回的数据
export type kbFileListType = {
    id: string,
    fileName: string,
    fileSize: number,
    fileType: string,
}[];

// 用户和模型的对话结构
export interface MessageListType {
    role: 'user' | 'assistant' | 'system';
    content: string;
    uploadFileList?:{
        fileName: string;
        fileSize: string;
        fileType: string;
        docId: string;
    }[]; // 上传的文件列表
    uploadImageList?: UploadImageRefType; // 携带的图片
    readFileData?: {
        type:'readDocument' | 'queryKB'; // 阅读文档 | 检索知识库
        statusInfo:'inProgress' | 'completed'; // 进行中 | 完成
        promptInfo:string; // 服务器返回的提示
        fileList:string[]; // 服务器返回的文件列表
    }
    displayContent?:string; // 用户原始问题
    loadingCircle?:boolean; // 发送时等待模型回复的loading
}

// 对话中引用的文件（带后端文档id）
export type UploadFileRefType = {
    fileName: string;
    fileSize: string;
    fileType: string;
    docId: string;
}

// 用户发送消息传递的参数
export type SendMessageType = {
    content: string;
    sessionId: string;
    uploadFileList?:UploadFileRefType[];
    uploadImageList?:UploadImageRefType;
    isKnowledgeBased?:boolean;
}

// 后端流式推送的数据（###ABC### 分隔的 JSON 块）
export type AiMessageType = {
    type?: 'readDocument' | 'queryKB' | 'answer' | 'sessionId' | 'error';
    statusInfo?: 'inProgress' | 'completed';
    promptInfo?: string;
    fileList?: string[];
    content?: string;
    sessionId?: string;
}

// 会话列表项（/chat/sessionlist 返回）
export type SessionListItemType = {
    sessionId: string;
    createDate: string;
    createTime: number;
    title: string;
    messageCount: number;
}
