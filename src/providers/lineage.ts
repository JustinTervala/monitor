import { closeSync, constants, fstatSync, openSync, readSync, statSync } from 'node:fs';

/** A bounded, metadata-only cache. Never retain JSON records or transcript text. */
export class LineageReader {
  private cache = new Map<string, { identity: string; size: number; parent: string | null }>();

  read(
    path: string,
    id: string,
    parse: (value: any) => { parent: string | null } | undefined,
  ): { parent: string | null } | undefined {
    let fd: number | undefined;
    try {
      const stat = statSync(path);
      if (!stat.isFile()) return;
      const key = `${path}\0${id}`;
      const identity = `${stat.dev}:${stat.ino}:${stat.birthtimeMs}`;
      const cached = this.cache.get(key);
      if (cached?.identity === identity && stat.size >= cached.size)
        return { parent: cached.parent };
      fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
      if (!fstatSync(fd).isFile()) return;
      const chunk = Buffer.alloc(16 * 1024);
      let pending = Buffer.alloc(0);
      // The prefix can include large instruction metadata. Never scan an entire
      // conversation to guess ancestry; unavailable is a valid observation.
      for (let offset = 0; offset < 1024 * 1024;) {
        const count = readSync(fd, chunk, 0, chunk.length, offset);
        if (!count) return;
        offset += count;
        pending = Buffer.concat([pending, chunk.subarray(0, count)]);
        let newline: number;
        while ((newline = pending.indexOf(10)) !== -1) {
          const line = pending.subarray(0, newline).toString('utf8');
          pending = pending.subarray(newline + 1);
          if (!line.trim()) continue;
          const result = parse(JSON.parse(line));
          if (result) {
            this.cache.set(key, { identity, size: offset, parent: result.parent });
            return result;
          }
        }
      }
    } catch {
      // Missing, partial, or unsupported source metadata is not a root task.
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  }
}
