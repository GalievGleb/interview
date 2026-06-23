import { IsEnum, IsOptional, IsString } from 'class-validator';
import { Plan, BillingProvider } from '@interview/shared';

export class CheckoutDto {
  @IsEnum(Plan)
  plan!: Plan;

  @IsEnum(BillingProvider)
  provider!: BillingProvider;

  @IsOptional()
  @IsString()
  successUrl?: string;

  @IsOptional()
  @IsString()
  cancelUrl?: string;
}
