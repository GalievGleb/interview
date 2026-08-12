import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const source = fs.readFileSync(path.resolve(__dirname, 'DocumentsPage.tsx'), 'utf8');

describe('document upload behavior', () => {
  it('does not expose the generated candidate-profile review card', () => {
    expect(source).not.toContain('profilePackGet');
    expect(source).not.toContain('profilePackSave');
    expect(source).not.toContain("t('docs.profile.");
  });

  it('shows a spinner while a resume or context document is uploading', () => {
    expect(source).toContain("useState<'text' | 'file' | null>(null)");
    expect(source).toContain('LoaderCircle');
    expect(source).toContain('animate-spin');
    expect(source).toContain("t('docs.add.addingResume')");
    expect(source).toContain("t('docs.add.addingContext')");
  });

  it('prevents duplicate file and text submissions while either upload is active', () => {
    expect(source).toMatch(/const addText = async \(\) => \{\s*if \(busyKind !== null/);
    expect(source).toMatch(
      /const onFile = async[^]*if \(busyKind !== null \|\| uploadInFlightRef\.current\)/,
    );
    expect(source).toContain('disabled={busyKind !== null}');
    expect(source).toContain('onClick={() => fileRef.current?.click()}');
    expect(source).toContain('setTextError(');
  });

  it('lets the user dictate experience that did not fit the resume', () => {
    expect(source).toContain('useVoiceAnswer');
    expect(source).toContain('Надиктовать опыт');
    expect(source).toContain("kind === 'legend'");
    expect(source).toContain("[current.trim(), transcript].filter(Boolean).join('\\n\\n')");
    expect(source).not.toContain('prep-next-card');
  });
});
