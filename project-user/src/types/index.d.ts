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

// 已落盘的图片（历史回显用；新消息由后端落盘后回传 imagePath/imageUrl）
export type UploadImageRefType = {
  imagePath?: string;
  mimetype: string;
  imageUrl?: string;
  fileName?: string;
  fileSize?: number;
}

// 输入框里待发送的粘贴图片（纯前端内存态，不发上传请求）
export type PastedImageItem = {
  id: string;
  fileName: string;
  fileSize: number;
  mimetype: string;
  dataUrl: string;
  base64: string;
}

// 随消息一起提交给后端的内联图片（base64 不含 data: 前缀）
export type InlineImagePayload = {
  mimetype: string;
  data: string;
  fileName?: string;
  fileSize?: number;
}

// 获取知识库文件列表返回的数据
export type kbFileListType = {
    id: string,
    fileName: string,
    fileSize: number,
    fileType: string,
}[];

// 知识库回答的出处，index 与正文里的 [N] 一一对应
export type CitationType = {
    index: number;
    docId: string;
    docTitle: string;
    section: string;   // 章节路径，如 "3 方法 > 3.2 模型结构"
    page: number;      // 起始页码，0 表示未知（DOCX / 存量文档）
    para: number;      // 章节内段序，0 表示未知
    parentId: string;  // 所属父章节 id
    chunkKey: string;
    charStart: number; // 片段在全文中的起始字符偏移
    charEnd: number;
    snippet: string;   // 卡片预览（前 160 字）
    text: string;      // 模型实际看到的完整片段，可展开核对
    score: number;
    matchedBy: Array<'vector' | 'keyword' | 'qa'>;
}

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
    uploadImageList?: UploadImageRefType | UploadImageRefType[]; // 消息携带的图片（旧数据为单对象）
    readFileData?: {
        type:'readDocument' | 'queryKB'; // 阅读文档 | 检索知识库
        statusInfo:'inProgress' | 'completed'; // 进行中 | 完成
        promptInfo:string; // 服务器返回的提示
        fileList:string[]; // 服务器返回的文件列表
    }
    citations?: CitationType[]; // 知识库回答的出处列表
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
    images?: InlineImagePayload[]; // 粘贴的图片：随消息内联提交，后端落盘
    isKnowledgeBased?:boolean;
}

// 后端流式推送的数据（SSE 协议的 data: 帧，负载为 JSON）
export type AiMessageType = {
    type?: 'readDocument' | 'queryKB' | 'answer' | 'sessionId' | 'error';
    statusInfo?: 'inProgress' | 'completed';
    promptInfo?: string;
    fileList?: string[];
    citations?: CitationType[];
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
