import { execFile } from 'node:child_process';
import { watch, type FSWatcher } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ObserverCallbacks, SessionProvider } from '../provider';
import type { Session } from '../../shared/types';
import {
  processAlive,
  readDesktopRecords,
  readLiveProcesses,
  validSessionId,
  type DesktopRecord,
} from './catalog';
import { sessionFromRecord } from './projection';

export interface ClaudeProviderOptions {
  /** Claude desktop's Code-tab session store. */
  desktopDir?: string;
  /** Claude Code config directory holding the `sessions/` process registry. */
  configDir?: string;
  desktopRunning?: () => Promise<boolean>;
  processAlive?: (pid: number) => boolean;
  pollMs?: number;
}

const DESKTOP_EXECUTABLE = /\/Claude\.app\/Contents\/MacOS\/Claude$/;
export function claudeDesktopRunning(): Promise<boolean> {
  return new Promise((resolve) =>
    execFile('/bin/ps', ['-Ax', '-o', 'comm='], { maxBuffer: 16 * 1024 * 1024 }, (error, out) =>
      resolve(!error && out.split('\n').some((line) => DESKTOP_EXECUTABLE.test(line.trim()))),
    ),
  );
}

export class ClaudeProvider implements SessionProvider {
  readonly id = 'claude' as const;
  readonly desktopDir: string;
  readonly registryDir: string;
  private callbacks: ObserverCallbacks | null = null;
  private tracked = new Set<string>();
  private connected: boolean | null = null;
  private lastObservedAt: number | null = null;
  private timer: NodeJS.Timeout | null = null;
  private debounce: NodeJS.Timeout | null = null;
  private watchers: FSWatcher[] = [];
  private inFlight: Promise<void> | null = null;
  private again = false;
  private stopped = false;
  constructor(private options: ClaudeProviderOptions = {}) {
    this.desktopDir =
      options.desktopDir ||
      join(homedir(), 'Library', 'Application Support', 'Claude', 'claude-code-sessions');
    this.registryDir = join(
      options.configDir || process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'),
      'sessions',
    );
  }
  async start(callbacks: ObserverCallbacks) {
    this.callbacks = callbacks;
    callbacks.health({
      provider: this.id,
      state: 'connecting',
      message: 'Reading Claude desktop sessions',
      lastObservedAt: null,
    });
    await this.refresh();
    if (this.stopped) return;
    for (const dir of [this.desktopDir, this.registryDir]) {
      try {
        const watcher = watch(dir, { recursive: true }, () => this.refreshSoon());
        watcher.on('error', () => watcher.close());
        this.watchers.push(watcher);
      } catch {
        // Missing directory: polling notices when Claude creates it.
      }
    }
    this.timer = setInterval(() => void this.refresh(), this.options.pollMs ?? 3000);
  }
  private refreshSoon() {
    if (this.debounce || this.stopped) return;
    this.debounce = setTimeout(() => {
      this.debounce = null;
      void this.refresh();
    }, 150);
  }
  refresh(): Promise<void> {
    if (this.inFlight) {
      this.again = true;
      return this.inFlight;
    }
    this.inFlight = (async () => {
      try {
        do {
          this.again = false;
          await this.observe();
        } while (this.again && !this.stopped);
      } finally {
        this.inFlight = null;
      }
    })();
    return this.inFlight;
  }
  private async observe() {
    const running = await (this.options.desktopRunning ?? claudeDesktopRunning)();
    if (this.stopped) return;
    let records: DesktopRecord[];
    try {
      records = readDesktopRecords(this.desktopDir);
    } catch (error) {
      const missing = (error as NodeJS.ErrnoException).code === 'ENOENT';
      this.health(
        running ? 'degraded' : 'offline',
        missing
          ? 'No Claude desktop Code sessions found. Open the Code tab in Claude first.'
          : `Could not read Claude desktop sessions: ${(error as Error).message}`,
      );
      return;
    }
    const live = running
      ? readLiveProcesses(this.registryDir, this.options.processAlive ?? processAlive)
      : new Map();
    const now = Date.now();
    const sessions: Session[] = records
      .filter((record) => !record.archived || this.tracked.has(record.sessionId))
      .map((record) => sessionFromRecord(record, live.get(record.sessionId), running, now));
    if (running) this.lastObservedAt = now;
    // Offline health first so the service drops its baseline before the
    // unavailable states; reconnect then re-baselines without replaying results.
    if (!running && this.connected !== false)
      this.health('offline', 'Claude desktop is not running');
    this.callbacks?.sessions(sessions);
    if (running) this.health('live', 'Reading Claude desktop · local Code sessions');
    this.connected = running;
  }
  private health(state: 'live' | 'degraded' | 'offline', message: string) {
    this.callbacks?.health({
      provider: this.id,
      state,
      message,
      lastObservedAt: this.lastObservedAt,
    });
  }
  track(externalIds: string[]) {
    this.tracked = new Set(externalIds.filter(validSessionId));
  }
  sessionUrl(externalId: string) {
    if (!validSessionId(externalId)) throw new Error('Invalid Claude session id.');
    return `claude://code/continue?session=${encodeURIComponent(externalId)}`;
  }
  stop() {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    if (this.debounce) clearTimeout(this.debounce);
    this.timer = this.debounce = null;
    for (const watcher of this.watchers) watcher.close();
    this.watchers = [];
  }
}
