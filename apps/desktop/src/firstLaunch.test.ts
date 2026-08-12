import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const appSource = fs.readFileSync(path.resolve(__dirname, 'App.tsx'), 'utf8');
const contextSource = fs.readFileSync(path.resolve(__dirname, 'context/AppContext.tsx'), 'utf8');
const settingsSource = fs.readFileSync(path.resolve(__dirname, 'pages/SettingsPage.tsx'), 'utf8');

describe('first launch', () => {
  it('opens the main app directly without onboarding slides or a microphone gate', () => {
    expect(appSource).not.toContain('OnboardingPage');
    expect(appSource).not.toContain('path="/onboarding"');
    expect(appSource).not.toContain('onboardingDone');
    expect(contextSource).not.toContain('copilot-onboarding-done');
    expect(contextSource).not.toContain('completeOnboarding');
    expect(fs.existsSync(path.resolve(__dirname, 'pages/OnboardingPage.tsx'))).toBe(false);
    expect(fs.existsSync(path.resolve(__dirname, 'components/OnboardingSttStep.tsx'))).toBe(false);
    expect(fs.existsSync(path.resolve(__dirname, 'components/OnboardingWizard.tsx'))).toBe(false);
  });

  it('keeps microphone controls available from regular settings', () => {
    expect(settingsSource).toContain("import MicrophoneSettings from '../components/MicrophoneSettings'");
    expect(settingsSource).toContain('<MicrophoneSettings />');
  });
});
