import type { AccountDevice, AccountState } from '../types/electron';

const unavailableState: AccountState = {
  available: false,
  authenticated: false,
  user: null,
  subscription: null,
  error: 'ACCOUNT_SERVICE_UNAVAILABLE',
};

function bridge() {
  const account = window.electronAPI?.account;
  if (!account) throw new Error('ACCOUNT_SERVICE_UNAVAILABLE');
  return account;
}

export const accountApi = {
  getState: (): Promise<AccountState> =>
    window.electronAPI?.account?.getState?.() ?? Promise.resolve(unavailableState),
  refresh: (): Promise<AccountState> => bridge().refresh(),
  googleLogin: (): Promise<AccountState> => bridge().googleLogin(),
  register: (email: string, password: string) => bridge().register(email, password),
  verifyEmail: (email: string, code: string): Promise<AccountState> => bridge().verifyEmail(email, code),
  login: (email: string, password: string): Promise<AccountState> => bridge().login(email, password),
  requestVerification: (email: string) => bridge().requestVerification(email),
  requestPasswordReset: (email: string) => bridge().requestPasswordReset(email),
  confirmPasswordReset: (email: string, code: string, password: string) =>
    bridge().confirmPasswordReset(email, code, password),
  listDevices: (): Promise<AccountDevice[]> => bridge().listDevices(),
  revokeDevice: (sessionId: string) => bridge().revokeDevice(sessionId),
  createCheckout: (plan: 'BASIC' | 'PRO', provider: 'stripe' | 'yookassa', period: 'monthly' | 'yearly') =>
    bridge().createCheckout(plan, provider, period),
  logout: (): Promise<AccountState> => bridge().logout(),
  onState: (callback: (state: AccountState) => void): (() => void) =>
    window.electronAPI?.account?.onState?.(callback) ?? (() => {}),
};
