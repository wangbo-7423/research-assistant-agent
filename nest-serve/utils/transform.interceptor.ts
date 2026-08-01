import {
    Injectable,
    NestInterceptor,
    ExecutionContext,
    CallHandler
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';
import { Request } from 'express';

// 统一响应接口
export interface ApiResponse<T = any> {
    statusCode: number;
    message: string;
    data: T | null;
    timestamp: string;
    path?: string;
}

// 控制器可返回的自定义格式
interface CustomResponse<T> {
    message?: string;
    data?: T;
    code?: number;
}

@Injectable()
export class TransformInterceptor<T>
    implements NestInterceptor<T, ApiResponse<T>> {
    intercept(context: ExecutionContext, next: CallHandler): Observable<ApiResponse<T>> {
        const ctx = context.switchToHttp();
        const response = ctx.getResponse();
        const request = ctx.getRequest<Request>();

        return next.handle().pipe(
            map((data) => {
                let message = 'SUCCESS';
                let realData = data;
                let statusCode = 200;

                // 检查是否为自定义响应格式 { message, data, code? }
                if (
                    data !== null &&
                    typeof data === 'object' &&
                    'message' in data &&
                    'data' in data
                ) {
                    message = data.message || 'SUCCESS';
                    realData = data.data;
                    if (data.code !== undefined) {
                        statusCode = data.code;
                    }
                }

                // 设置状态码
                response.status(statusCode);

                // 统一响应格式（与异常过滤器保持一致）
                return {
                    statusCode: statusCode,
                    message: message,
                    data: realData,
                    timestamp: new Date().toISOString(),
                    path: request.url,
                };
            }),
        );
    }
}