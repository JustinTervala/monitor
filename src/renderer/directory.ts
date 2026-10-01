/** Shorten only this user's home directory, at a path-component boundary. */
export function displayDirectory(directory: string | null, homeDirectory: string): string {
  if (!directory) return '';
  if (directory === homeDirectory) return '~';
  return directory.startsWith(`${homeDirectory}/`)
    ? `~${directory.slice(homeDirectory.length)}`
    : directory;
}
