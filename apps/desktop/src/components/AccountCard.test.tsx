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
    createCheckout: vi.fn(), logout: vi.fn(), refresh: vi.fn(), onState: vi.fn(() => () => {}),
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

  it('shows a Home sign-in prompt until login completes, then removes it', async () => {
    vi.mocked(accountApi.googleLogin).mockResolvedValue({ ...signedOut, authenticated: true,
      user: { id: 'u1', email: 'person@example.com', displayName: null, avatarUrl: null } });
    const { container } = render(<AccountCard homePrompt />);
    expect(await screen.findByText('Подключите профиль SkillCue')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /google/i }));
    await waitFor(() => expect(container.textContent).toBe(''));
  });

  it('explains expired OAuth attempts without exposing callback secrets', async () => {
    vi.mocked(accountApi.googleLogin).mockRejectedValue(new Error('GOOGLE_OAUTH_STATE_INVALID'));
    render(<AccountCard />);
    fireEvent.click(await screen.findByRole('button', { name: /google/i }));
    expect((await screen.findByRole('alert')).textContent).toContain('Попробуйте войти через Google заново');
  });

  it('offers Google as the only sign-in method', async () => {
    render(<AccountCard />);

    expect(await screen.findByRole('button', { name: /google/i })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /почте|email/i })).toBeNull();
    expect(screen.queryByLabelText(/электронная почта|email/i)).toBeNull();
    expect(screen.queryByLabelText(/пароль|password/i)).toBeNull();
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

  it('refreshes the account plan after a bot grants access', async () => {
    const user = { id: 'u1', email: 'person@example.com', displayName: null, avatarUrl: null };
    vi.mocked(accountApi.getState).mockResolvedValue({ ...signedOut, authenticated: true, user });
    vi.mocked(accountApi.refresh).mockResolvedValue({
      ...signedOut, authenticated: true, user,
      subscription: {
        plan: 'PRO', status: 'ACTIVE', currentPeriodEnd: '2026-10-23T00:00:00.000Z',
        sttMinutesUsed: 0, llmTokensUsed: 0, limits: null,
      },
    });

    render(<AccountCard />);
    fireEvent.click(await screen.findByRole('button', { name: 'Обновить тариф' }));

    expect(await screen.findByText('SkillCue Максимум')).toBeTruthy();
    expect(accountApi.refresh).toHaveBeenCalledOnce();
  });
});
