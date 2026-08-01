import { Prop, Schema, SchemaFactory } from "@nestjs/mongoose"
import { UserInfo } from "../userinfo/userinfo.schema"

// 文件管理（知识库+对话框文件上传）
@Schema({versionKey:false, timestamps:true})
export class Fileanagement{
    @Prop({ref:UserInfo.name, required:true})
    userId: string

    @Prop({required:true})
    fileName: string

    @Prop({default:''})
    filePath: string

    @Prop({required:true})
    fileType: string

    // 文件大小（字节）
    @Prop({required:true, type:Number})
    fileSize: number

    // 解析出的文本内容，未解析时为空字符串
    @Prop({default:''})
    fileText: string

    // 存储的文件类型：UD=知识库、UB=对话框
    @Prop({enum:['UD','UB'], required:true})
    uploadType: 'UD' | 'UB'
}

export const FileanagementSchema = SchemaFactory.createForClass(Fileanagement)
