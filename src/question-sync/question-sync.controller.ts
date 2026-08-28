import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import { QuestionSyncService } from './question-sync.service';
import { RunSyncDto } from './dto/run-sync.dto';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AdminGuard } from '../auth/admin.guard';

@Controller('question-sync')
@UseGuards(JwtAuthGuard, AdminGuard)
export class QuestionSyncController {
  constructor(private readonly syncService: QuestionSyncService) {}

  /**
   * Trigger question sync with optional batch params.
   *
   * Examples:
   * - Test (5 IDs): POST { "limit": 5 }
   * - Day 1: POST { "limit": 1200 }
   * - Day 2: POST { "offset": 1200, "limit": 600 }
   */
  @Post()
  async runSync(@Body() body: RunSyncDto) {
    const result = await this.syncService.runSync(body);
    return {
      message: 'Sync completed',
      processed: result.processed,
      errors: result.errors,
    };
  }
}
