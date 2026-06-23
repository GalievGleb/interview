import {
  Body,
  Controller,
  Post,
  Res,
  UseGuards,
  Request,
  ForbiddenException,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { Response } from 'express';
import { IsEnum, IsString, MinLength } from 'class-validator';
import { PersonaMode } from '@interview/shared';
import { LlmService } from './llm.service';
import { SubscriptionGuard } from '../auth/subscription.guard';

class SuggestDto {
  @IsString()
  @MinLength(1)
  transcript!: string;

  @IsEnum(PersonaMode)
  mode!: PersonaMode;
}

@Controller('llm')
@UseGuards(AuthGuard('jwt'), SubscriptionGuard)
export class LlmController {
  constructor(private readonly llmService: LlmService) {}

  @Post('suggest')
  async suggest(
    @Request() req: { user: { id: string } },
    @Body() dto: SuggestDto,
    @Res() res: Response,
  ) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    try {
      for await (const event of this.llmService.streamSuggest(
        req.user.id,
        dto.transcript,
        dto.mode,
      )) {
        res.write(`data: ${JSON.stringify(event)}\n\n`);
        if (event.type === 'error' || event.type === 'done') {
          break;
        }
      }
    } catch (error) {
      if (error instanceof ForbiddenException) {
        res.write(`data: ${JSON.stringify({ type: 'error', message: error.message })}\n\n`);
      } else {
        res.write(
          `data: ${JSON.stringify({ type: 'error', message: 'Internal error' })}\n\n`,
        );
      }
    }

    res.end();
  }
}
