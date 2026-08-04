import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const source = fs.readFileSync(path.resolve(__dirname, 'DocumentsPage.tsx'), 'utf8');

describe('document upload behavior', () => {
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
    expect(source).toContain("busyKind !== null ? 'true' : undefined");
  });
});
