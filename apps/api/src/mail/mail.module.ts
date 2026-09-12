import { Module } from '@nestjs/common';
import { ResendMailClient } from './resend-mail.client';

@Module({
  providers: [ResendMailClient],
  exports: [ResendMailClient],
})
export class MailModule {}
