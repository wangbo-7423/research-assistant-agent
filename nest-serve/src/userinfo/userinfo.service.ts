import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { UserInfo } from './userinfo.schema';
import { Model } from 'mongoose';
import { createHmac } from 'crypto'
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt'

@Injectable()
export class UserinfoService {
    constructor(@InjectModel(UserInfo.name) private userInfoModel:Model<UserInfo>,
    private configService:ConfigService,
    private  jwtService:JwtService) {}
    async registerUser(phonenumber:string, password:string){
        //查询是否存在
        const queryAccount = await this.userInfoModel.find({phonenumber});
        console.log(queryAccount);
        if(queryAccount.length <= 0){
            //对密码进行加密
            const passwordKey = this.configService.get('PASSWORD_KEY');
            const passwordHash = createHmac("sha256", passwordKey).update(password).digest("hex");
            const newUser = await this.userInfoModel.create({phonenumber, password:passwordHash});
            const token = this.jwtService.sign({ token: newUser._id });
            return {
                message:'SUCCESS',
                data:{
                    token,phonenumber
                }
            }
        } else {
            return {
                message:"该账号已存在",
                data:[],
                code: 422
            }
        }
    }
    async loginUser(phonenumber:string, password:string){
        const passwordKey = this.configService.get('PASSWORD_KEY');
        const passwordHash = createHmac("sha256", passwordKey).update(password).digest("hex");
        const queryAccount = await this.userInfoModel.find({phonenumber, password:passwordHash});
        if(queryAccount.length > 0){
            const token = this.jwtService.sign({token:queryAccount[0]._id});
            return {
                message:'SUCCESS',
                data:{
                    token,phonenumber
                }
            }
        } else {
            return {
                message:"账号或密码错误",
                data:[],
                code: 422
            }
        }
    }
}
