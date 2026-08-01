import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Request } from 'express';
import { ConfigService } from '@nestjs/config'

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
        private jwtService: JwtService,
        private configService: ConfigService
    ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request: Request = context.switchToHttp().getRequest();
    const token = this.extractTokenFromHeader(request);
    if (!token) {
      throw new UnauthorizedException("No token provided");
    }
    try {
      // 💡 Here the JWT secret key that's used for verifying the payload 
      // is the key that was passed in the JwtModule
      const payload = await this.jwtService.verifyAsync(
        token,
        { secret: this.configService.get('JWT_SECRET') }
      );
      // 💡 We're assigning the payload to the request object here
      // so that we can access it in our route handlers
      (request as any).user = payload;
    } catch {
      throw new UnauthorizedException("token is invalid");
    }
    return true;
  }

  private extractTokenFromHeader(request: Request): string | undefined {
    const [type, token] = request.headers.authorization?.split(' ') ?? [];
    return type === 'Bearer' ? token : undefined;
  }
}