import { execFile } from 'node:child_process';
import { watch, type FSWatcher } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ObserverCallbacks, SessionProvider } from '../provider';
import type { Session } from '../../shared/types';
import {
  processAlive,
  readDesktopRecords,
  readHookSessions,
  readLiveProcesses,
  validCliSessionId,
  validSessionId,
  type DesktopRecord,
} from './catalog';
import { sessionFromRecord, sessionFromTerminal } from './projection';
import { LineageReader } from '../lineage';

export interface ClaudeProviderOptions {
  /** Claude desktop's Code-tab session store. */
  desktopDir?: string;
  /** Claude Code config directory holding the `sessions/` process registry. */
  configDir?: string;
  /** Where plugins/monitor-hooks writes terminal session events. */
  hooksDir?: string;
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
  readonly hooksDir: string;
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
  private lineage = new LineageReader();
  private configDir: string;
  constructor(private options: ClaudeProviderOptions = {}) {
    this.desktopDir =
      options.desktopDir ||
      join(homedir(), 'Library', 'Application Support', 'Claude', 'claude-code-sessions');
    this.configDir =
      options.configDir || process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
    this.registryDir = join(this.configDir, 'sessions');
    this.hooksDir =
      options.hooksDir ||
      process.env.MONITOR_CLAUDE_HOOKS_DIR ||
      join(homedir(), 'Library', 'Application Support', 'Monitor', 'claude-hooks');
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
    for (const dir of [this.desktopDir, this.registryDir, this.hooksDir]) {
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
    let records: DesktopRecord[] = [],
      desktopProblem: string | null = null;
    try {
      records = readDesktopRecords(this.desktopDir);
    } catch (error) {
      desktopProblem =
        (error as NodeJS.ErrnoException).code === 'ENOENT'
          ? 'No Claude desktop Code sessions found'
          : `Could not read Claude desktop sessions: ${(error as Error).message}`;
    }
    const live = readLiveProcesses(this.registryDir, this.options.processAlive ?? processAlive);
    const hooks = readHookSessions(this.hooksDir);
    const now = Date.now();
    const sessions: Session[] = records
      .filter((record) => !record.archived || this.tracked.has(record.sessionId))
      .map((record) =>
        sessionFromRecord(
          record,
          // A desktop session resumed with `claude --resume` runs as a terminal process.
          live.desktop.get(record.sessionId) ??
            (record.cliSessionId ? live.terminal.get(record.cliSessionId) : undefined),
          running,
          now,
        ),
      );
    // Terminal sessions: hook-reported or live CLI processes, plus any already followed.
    const desktopCli = new Set(records.map((r) => r.cliSessionId));
    const terminal = new Set([
      ...[...hooks.values()].filter((h) => h.entrypoint === 'cli').map((h) => h.sessionId),
      ...live.terminal.keys(),
      ...[...this.tracked].filter((id) => id.startsWith('cli_')).map((id) => id.slice(4)),
    ]);
    let terminals = 0;
    for (const id of terminal)
      if (!desktopCli.has(id)) {
        sessions.push(sessionFromTerminal(id, hooks.get(id), live.terminal.get(id), now));
        terminals++;
      }
    const desktopByCli = new Map(
      records.filter((r) => r.cliSessionId).map((r) => [r.cliSessionId!, r]),
    );
    for (const session of sessions) {
      const cliId = session.resumeId;
      const desktop = cliId ? desktopByCli.get(cliId) : undefined;
      if (!cliId || !session.directory || desktop?.forkedFromSessionId || desktop?.lineageDetached)
        continue;
      const project = session.directory.replace(/[^a-zA-Z0-9]/g, '-');
      const meta = this.lineage.read(
        join(this.configDir, 'projects', project, `${cliId}.jsonl`),
        cliId,
        (value) => {
          if (!value || !['user', 'assistant'].includes(value.type)) return undefined;
          if (value.sessionId !== cliId || value.isSidechain === true)
            throw new Error('Unsupported session metadata');
          const parent = value.forkedFrom?.sessionId ?? null;
          if (
            parent !== null &&
            (typeof parent !== 'string' || !validCliSessionId(parent) || parent === cliId)
          )
            throw new Error('Invalid fork metadata');
          return { parent };
        },
      );
      if (meta)
        session.lineage = {
          parentId: meta.parent
            ? `claude:${desktopByCli.get(meta.parent)?.sessionId || `cli_${meta.parent}`}`
            : null,
        };
    }
    if (running || live.terminal.size) this.lastObservedAt = now;
    // Offline health first so the service drops its baseline before the
    // unavailable states; reconnect then re-baselines without replaying results.
    if (!running && this.connected !== false)
      this.health('offline', 'Claude desktop is not running');
    this.callbacks?.sessions(sessions);
    const terminalNote = terminals ? ` · ${terminals} terminal` : '';
    if (running && desktopProblem) this.health('degraded', desktopProblem + terminalNote);
    else if (running) this.health('live', `Reading Claude desktop${terminalNote}`);
    else if (terminals) this.health('degraded', `Claude desktop is not running${terminalNote}`);
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
    this.tracked = new Set(
      externalIds.filter(
        (id) => validSessionId(id) || (id.startsWith('cli_') && validCliSessionId(id.slice(4))),
      ),
    );
  }
  sessionUrl(externalId: string) {
    if (externalId.startsWith('cli_'))
      throw new Error('Terminal sessions have no Claude desktop page; copy the resume command.');
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
