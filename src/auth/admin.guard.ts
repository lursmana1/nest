import {
  Injectable,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
} from '@nestjs/common';
import type { UserRole } from './user-role';

@Injectable()
export class AdminGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const { user } = context
      .switchToHttp()
      .getRequest<{ user?: { type?: UserRole } }>();
    if (user?.type !== 'admin') {
      throw new ForbiddenException('Admin access required');
    }
    return true;
  }
}
