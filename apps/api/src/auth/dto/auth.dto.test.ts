import assert from 'node:assert/strict';
import test from 'node:test';
import { validate } from 'class-validator';
import { ResetPasswordDto } from './auth.dto';

test('password reset does not require device data', async () => {
  const dto = new ResetPasswordDto();
  dto.email = 'person@example.com';
  dto.code = '123456';
  dto.password = 'strong-password';

  assert.deepEqual(await validate(dto), []);
});
