import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { Strategy, VerifyCallback } from 'passport-google-oauth20';
import { ConfigService } from '@nestjs/config';
import {
  assertGoogleOAuthConfig,
  resolveGoogleCallbackUrl,
} from './auth-url.util';

@Injectable()
export class GoogleStrategy
  extends PassportStrategy(Strategy, 'google')
  implements OnModuleInit
{
  private readonly logger = new Logger(GoogleStrategy.name);

  constructor(configService: ConfigService) {
    const callbackURL = resolveGoogleCallbackUrl();
    const clientID = (
      configService.get<string>('GOOGLE_CLIENT_ID') ?? ''
    ).replace(/\s/g, '');
    const clientSecret = (
      configService.get<string>('GOOGLE_CLIENT_SECRET') ?? ''
    ).replace(/\s/g, '');

    super({
      clientID,
      clientSecret,
      callbackURL,
      scope: ['email', 'profile'],
      passReqToCallback: false,
    });
  }

  onModuleInit(): void {
    for (const warning of assertGoogleOAuthConfig()) {
      this.logger.warn(warning);
    }
    this.logger.log(`Google OAuth callback URL: ${resolveGoogleCallbackUrl()}`);
  }

  validate(
    _accessToken: string,
    _refreshToken: string,
    profile: { id: string; emails?: { value: string }[]; displayName?: string },
    done: VerifyCallback,
  ): void {
    const { id, emails, displayName } = profile;
    const email = emails?.[0]?.value;
    const name = displayName ?? email?.split('@')[0] ?? 'User';

    const user = {
      googleId: id,
      email,
      name,
    };

    done(null, user);
  }
}
