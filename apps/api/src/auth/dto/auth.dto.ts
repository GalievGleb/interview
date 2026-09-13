import { IsEmail, IsOptional, IsString, Length, MinLength } from 'class-validator';

export class RegisterDto {
  @IsEmail()
  email!: string;

  @IsString()
  @MinLength(8)
  password!: string;

  @IsString()
  @MinLength(16)
  deviceId!: string;

  @IsOptional()
  @IsString()
  deviceName?: string;
}

export class LoginDto {
  @IsEmail()
  email!: string;

  @IsString()
  password!: string;

  @IsString()
  @MinLength(16)
  deviceId!: string;

  @IsOptional()
  @IsString()
  deviceName?: string;
}

export class GoogleLoginDto {
  @IsString()
  @MinLength(100)
  idToken!: string;

  @IsString()
  @MinLength(16)
  deviceId!: string;

  @IsOptional()
  @IsString()
  deviceName?: string;
}

export class RefreshDto {
  @IsString()
  refreshToken!: string;
}

class EmailAndCodeDto {
  @IsEmail()
  email!: string;

  @IsString()
  @Length(6, 6)
  code!: string;
}

export class EmailCodeDto extends EmailAndCodeDto {

  @IsString()
  @MinLength(16)
  deviceId!: string;

  @IsOptional()
  @IsString()
  deviceName?: string;
}

export class RequestEmailCodeDto {
  @IsEmail()
  email!: string;
}

export class ResetPasswordDto extends EmailAndCodeDto {
  @IsString()
  @MinLength(8)
  password!: string;
}
