// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import AccountCard from './AccountCard';
import { accountApi } from '../lib/accountApi';

vi.mock('../lib/accountApi', () => ({
  accountApi: {
    getState: vi.fn(), googleLogin: vi.fn(), register: vi.fn(), verifyEmail: vi.fn(),
    login: vi.fn(), requestVerification: vi.fn(), requestPasswordReset: vi.fn(),
    confirmPasswordReset: vi.fn(), listDevices: vi.fn(), revokeDevice: vi.fn(),
    createCheckout: vi.fn(), logout: vi.fn(), onState: vi.fn(() => () => {}),
  },
}));

const signedOut = {
  available: true, authenticated: false, user: null, subscription: null, error: null,
};

describe('AccountCard', () => {
  afterEach(cleanup);
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(accountApi.getState).mockResolvedValue(signedOut);
    vi.mocked(accountApi.onState).mockReturnValue(() => {});
    vi.mocked(accountApi.listDevices).mockResolvedValue([]);
  });

  it('makes Google the primary sign-in action', async () => {
    vi.mocked(accountApi.googleLogin).mockResolvedValue({
      ...signedOut, authenticated: true,
      user: { id: 'u1', email: 'person@example.com', displayName: 'Person', avatarUrl: null },
    });
    render(<AccountCard />);

    fireEvent.click(await screen.findByRole('button', { name: /google/i }));

    await waitFor(() => expect(accountApi.googleLogin).toHaveBeenCalledOnce());
    expect(await screen.findByText('person@example.com')).toBeTruthy();
  });

  it('keeps email registration and the six-digit verification step as fallback', async () => {
    vi.mocked(accountApi.register).mockResolvedValue({ verificationRequired: true, email: 'new@example.com' });
    render(<AccountCard />);

    fireEvent.click(await screen.findByRole('button', { name: /почте|email/i }));
    fireEvent.change(screen.getByLabelText(/электронная почта|email/i), { target: { value: 'new@example.com' } });
    fireEvent.change(screen.getByLabelText(/пароль|password/i), { target: { value: 'strong-password' } });
    fireEvent.click(screen.getByRole('button', { name: /создать профиль|create account/i }));

    expect(await screen.findByLabelText(/код из письма|email code/i)).toBeTruthy();
  });

  it('labels the current device and does not offer to revoke its own session', async () => {
    vi.mocked(accountApi.getState).mockResolvedValue({
      ...signedOut,
      authenticated: true,
      user: { id: 'u1', email: 'person@example.com', displayName: null, avatarUrl: null },
    });
    vi.mocked(accountApi.listDevices).mockResolvedValue([
      { id: 'current', name: 'This PC', createdAt: '2026-09-13T00:00:00.000Z', lastSeenAt: '2026-09-13T00:00:00.000Z', current: true },
      { id: 'other', name: 'Laptop', createdAt: '2026-09-13T00:00:00.000Z', lastSeenAt: '2026-09-13T00:00:00.000Z', current: false },
    ]);

    render(<AccountCard />);

    expect(await screen.findByText(/текущее|current/i)).toBeTruthy();
    expect(await screen.findByText('Laptop')).toBeTruthy();
    expect(screen.getAllByRole('button', { name: /отключить|disconnect|revoke/i })).toHaveLength(1);
  });
});
