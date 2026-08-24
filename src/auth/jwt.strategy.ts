import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';

function cookieExtractor(req?: {
  headers?: { cookie?: string };
}): string | null {
  // No cookie-parser dependency: parse raw Cookie header.
  const cookieHeader: string | undefined = req?.headers?.cookie;
  if (!cookieHeader) return null;

  const parts = cookieHeader.split(';').map((p) => p.trim());
  const tokenPart = parts.find((p) => p.startsWith('access_token='));
  if (!tokenPart) return null;

  const token = tokenPart.substring('access_token='.length);
  return token || null;
}

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(configService: ConfigService) {
    const secret = configService.get<string>('JWT_SECRET');
    if (!secret) {
      throw new Error('JWT_SECRET is not defined in configuration');
    }

    super({
      jwtFromRequest: ExtractJwt.fromExtractors([
        cookieExtractor,
        ExtractJwt.fromAuthHeaderAsBearerToken(),
      ]),
      ignoreExpiration: false,
      secretOrKey: secret,
    });
  }

  validate(payload: { sub: number; email: string; type?: 'admin' | 'user' }) {
    // This becomes req.user
    return {
      userId: payload.sub,
      email: payload.email,
      type: payload.type ?? 'user',
    };
  }
}
