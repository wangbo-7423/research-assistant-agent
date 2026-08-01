import { Prop, SchemaFactory, Schema } from "@nestjs/mongoose";

// 定义数据库字段类型规则
@Schema({versionKey: false})
export class UserInfo {
    @Prop({required: true})
    phonenumber: string;

    @Prop({required: true, select: false})
    password: string;
}

//生成数据库需要的数据模型结构对象
export const UserInfoSchema = SchemaFactory.createForClass(UserInfo);