import fs from 'node:fs';
import path from 'node:path';

export type OperationalCategory = 'app' | 'overlay' | 'hh' | 'checkout';

export interface OperationalEventInput {
  category: OperationalCategory;
  code: string;
  count: number;
}

export interface OperationalEvent extends OperationalEventInput {
  at: string;
  version: string;
}

interface PersistedTelemetry {
  enabled: boolean;
  events: OperationalEvent[];
}

const CATEGORY = new Set<OperationalCategory>(['app', 'overlay', 'hh', 'checkout']);
const CODE_RE = /^[a-z0-9][a-z0-9_.-]{0,63}$/i;

export class OperationalTelemetryStore {
  private readonly filePath: string;
  private state: PersistedTelemetry;

  constructor(userDataDir: string, private readonly version: string) {
    this.filePath = path.join(userDataDir, 'operational-telemetry.json');
    this.state = this.load();
  }

  private load(): PersistedTelemetry {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf8')) as Partial<PersistedTelemetry>;
      return {
        enabled: parsed.enabled === true,
        events: Array.isArray(parsed.events) ? parsed.events.slice(-200) : [],
      };
    } catch {
      return { enabled: false, events: [] };
    }
  }

  private save(): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    fs.writeFileSync(this.filePath, JSON.stringify(this.state), 'utf8');
  }

  setEnabled(enabled: boolean): PersistedTelemetry {
    this.state.enabled = enabled === true;
    if (!this.state.enabled) this.state.events = [];
    this.save();
    return this.snapshot();
  }

  record(value: OperationalEventInput): void {
    if (!this.state.enabled || !CATEGORY.has(value?.category) || !CODE_RE.test(String(value?.code ?? ''))) return;
    this.state.events.push({
      at: new Date().toISOString(),
      version: this.version.slice(0, 32),
      category: value.category,
      code: String(value.code).slice(0, 64),
      count: Math.max(0, Math.min(10_000, Math.round(Number(value.count) || 0))),
    });
    this.state.events = this.state.events.slice(-200);
    this.save();
  }

  snapshot(): PersistedTelemetry {
    return { enabled: this.state.enabled, events: this.state.events.map((event) => ({ ...event })) };
  }
}
