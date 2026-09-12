import { IsEnum, IsOptional, IsString, MaxLength } from 'class-validator';
import { Plan, BillingPeriod, BillingProvider } from '@interview/shared';

export class CheckoutDto {
  @IsEnum(Plan)
  plan!: Plan;

  @IsEnum(BillingProvider)
  provider!: BillingProvider;

  @IsEnum(BillingPeriod)
  period!: BillingPeriod;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  successUrl?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  cancelUrl?: string;
}
