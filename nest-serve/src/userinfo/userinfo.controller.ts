import { BadRequestException, Body, Controller, Get, Post, Query } from '@nestjs/common';
import { LoginUserDto, RegisterDto } from './userinfo.dto';
import { UserinfoService } from './userinfo.service';

@Controller('userinfo')
export class UserinfoController {
    constructor(private readonly userinfoService: UserinfoService) {}
    @Post('registeruser')
    async registerUser(@Body() body: RegisterDto){
        console.log(body);
        if(body.password !== body.confirmPassWord){
            throw new BadRequestException('Password does not match');
        }
        // 存储数据库
        return await this.userinfoService.registerUser(body.phoneNumber, body.password);
    }

    @Post('loginuser')
    async loginUser(@Body() body: LoginUserDto){
        return await this.userinfoService.loginUser(body.phoneNumber, body.password);
    }
}
