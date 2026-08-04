import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Request } from 'express';
import { VerifiedLicense } from './license.util';
import { GatewayService } from './gateway.service';
import { GatewaySttQuotaService } from './gateway-stt-quota.util';

export interface LicensedSttUploadRequest extends Request {
  skillcueSttLicense?: VerifiedLicense;
}

/** Authenticate/rate-limit before Multer buffers a potentially large WAV. */
@Injectable()
export class GatewaySttUploadGuard implements CanActivate {
  constructor(
    private readonly gateway: GatewayService,
    private readonly quota: GatewaySttQuotaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<LicensedSttUploadRequest>();
    const license = this.gateway.authorize(request.headers.authorization);
    await this.quota.assertCanStart(license);
    request.skillcueSttLicense = license;
    return true;
  }
}
