import {
  Controller,
  Post,
  Body,
  Res,
  Get,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { CookieOptions, Request, Response } from 'express';
import { AuthService } from './auth.service';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
import { AuthGuard } from '@nestjs/passport';
import { JwtAuthGuard } from './jwt-auth.guard';
import {
  resolveApiPublicUrl,
  resolveGoogleCallbackUrl,
  resolveGoogleLoginUrl,
} from './auth-url.util';

function getCookieOptions(): CookieOptions {
  const isProduction = process.env.NODE_ENV === 'production';
  return {
    httpOnly: true,
    // Cross-origin SPA (frontend on Vercel, API on Render) needs SameSite=None.
    sameSite: isProduction ? 'none' : 'lax',
    secure: isProduction,
    path: '/',
    maxAge: 7 * 24 * 60 * 60 * 1000,
  };
}

function appendAccessTokenToRedirect(
  baseUrl: string,
  accessToken: string,
): string {
  try {
    const url = new URL(baseUrl);
    url.searchParams.set('access_token', accessToken);
    return url.toString();
  } catch {
    const sep = baseUrl.includes('?') ? '&' : '?';
    return `${baseUrl}${sep}access_token=${encodeURIComponent(accessToken)}`;
  }
}

@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  /** Frontend: redirect the browser to `googleLoginUrl` from this response. */
  @Get('config')
  getAuthConfig() {
    return {
      googleLoginUrl: resolveGoogleLoginUrl(),
      googleCallbackUrl: resolveGoogleCallbackUrl(),
      apiPublicUrl: resolveApiPublicUrl(),
    };
  }

  @Get('google')
  @UseGuards(AuthGuard('google'))
  async googleAuth() {
    // Guard redirects to Google
  }

  @Get('google/callback')
  @UseGuards(AuthGuard('google'))
  async googleAuthCallback(
    @Req()
    req: Request & { user: { googleId: string; email: string; name: string } },
    @Res() res: Response,
  ) {
    const result = await this.authService.validateOrCreateGoogleUser(
      req.user.googleId,
      req.user.email,
      req.user.name,
    );

    res.cookie('access_token', result.access_token, getCookieOptions());

    const redirectBase = process.env.GOOGLE_REDIRECT_AFTER_LOGIN || '/';
    res.redirect(
      appendAccessTokenToRedirect(redirectBase, result.access_token),
    );
  }

  @Post('register')
  async register(
    @Body() dto: RegisterDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.authService.register({
      name: dto.name,
      email: dto.email,
      password: dto.password,
      surname: dto.surname,
    });

    res.cookie('access_token', result.access_token, getCookieOptions());

    return { access_token: result.access_token, user: result.user };
  }

  @Post('login')
  async login(
    @Body() dto: LoginDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.authService.login(dto.email, dto.password);

    res.cookie('access_token', result.access_token, getCookieOptions());

    return { access_token: result.access_token, user: result.user };
  }

  @Get('me')
  @UseGuards(JwtAuthGuard)
  me(
    @Req()
    req: Request & { user: { userId: number; email: string; type: string } },
  ) {
    return this.authService.getMe(req.user.userId);
  }

  @Post('logout')
  logout(@Res({ passthrough: true }) res: Response) {
    res.clearCookie('access_token', getCookieOptions());
    return { ok: true };
  }
}
