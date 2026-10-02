import { open } from 'node:fs/promises';
import { constants } from 'node:fs';

// Read only a bounded tail, on demand. Never retain records between calls.
export async function responseTail(path: string): Promise<any[]> {
  const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const stat = await file.stat();
    if (!stat.isFile()) return [];
    const size = Math.min(stat.size, 8 * 1024 * 1024);
    const buffer = Buffer.alloc(size);
    const { bytesRead } = await file.read(buffer, 0, size, stat.size - size);
    const lines = buffer.subarray(0, bytesRead).toString('utf8').split('\n');
    if (stat.size > size) lines.shift();
    // A source may still be appending a record: a partial last line is not evidence.
    return lines.flatMap((line) => {
      try {
        const value = JSON.parse(line);
        return value && typeof value === 'object' ? [value] : [];
      } catch {
        return [];
      }
    });
  } finally {
    await file.close();
  }
}
export function boundedResponse(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim() || value.length > 24_000) return null;
  return value.trim();
}
