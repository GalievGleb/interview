import { Module } from '@nestjs/common';
import { ResendMailClient } from './resend-mail.client';

@Module({
  providers: [
    {
      provide: ResendMailClient,
      useFactory: () => new ResendMailClient(),
    },
  ],
  exports: [ResendMailClient],
})
export class MailModule {}
