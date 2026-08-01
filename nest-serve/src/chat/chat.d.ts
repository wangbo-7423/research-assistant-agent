// 用户上传的文档
export interface uploadFileListType {
    fileName: string;
    fileSize: string;
    fileType: string;
    docId: string;
}
// 用户和模型的对话结构
export interface MessageType {
    role: 'user' | 'assistant' | 'system';
    content: string;
    uploadFileList?:{
        fileName: string;
        fileSize: string;
        fileType: string;
        docId: string;
    }[]; // 上传的文件列表
    readFileData?: {
        type:'readDocument' | 'queryKB'; // 阅读文档 | 检索知识库
        statusInfo:'inProgress' | 'completed'; // 进行中 | 完成
        promptInfo:string; // 服务器返回的提示
        fileList:string[]; // 服务器返回的文件列表
    }
    displayContent?:string; // 用户原始问题
    // 携带的图片
    uploadImageList?: {
        imagePath: string;
        mimetype: string;
        imageUrl: string;
    }
}