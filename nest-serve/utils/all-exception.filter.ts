import { 
    ExceptionFilter,
    Catch,
    ArgumentsHost,
    HttpException,
    HttpStatus,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { MyLogger } from "./no-timestamp-logger"

@Catch()  // 捕获所有异常
export class HttpExceptionFilter implements ExceptionFilter {
  private readonly logger = new MyLogger();

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    // 默认值
    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let message = 'Internal server error';
    let stack: string | undefined;

    // 处理 HttpException（NestJS 标准异常）
    if (exception instanceof HttpException) {
      status = exception.getStatus();
      const res = exception.getResponse();
      message = typeof res === 'string' ? res : (res as any).message || message;
      
      this.logger.error(
        `HTTP异常 [${status}] ${message} | 路径: ${request.url} | 方法: ${request.method}`
      );
    } 
    // 处理普通 Error
    else if (exception instanceof Error) {
      message = exception.message || message;
      stack = exception.stack;
      
      this.logger.error(
        `系统异常: ${message} | 路径: ${request.url} | 方法: ${request.method}`,
        stack
      );
    }
    // 处理未知类型（比如 throw 'error'）
    else {
      message = String(exception) || message;
      
      this.logger.error(
        `未知异常: ${message} | 路径: ${request.url} | 方法: ${request.method}`
      );
    }

    // 统一响应格式
    response
      .status(status)
      .json({
        statusCode: status,
        message: message,
        data: null,
        timestamp: new Date().toISOString(),
        path: request.url,
      });
  }
}