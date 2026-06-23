import { SetMetadata } from '@nestjs/common';

export const SKIP_SUBSCRIPTION_KEY = 'skipSubscription';
export const SkipSubscription = () => SetMetadata(SKIP_SUBSCRIPTION_KEY, true);
