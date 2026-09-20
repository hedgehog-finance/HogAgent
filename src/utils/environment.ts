/** Plain object copies lose process.env's case-insensitive Windows lookup. */
export function normalizeEnvironment(env: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform): NodeJS.ProcessEnv {
  if (platform !== "win32") return { ...env };
  return Object.fromEntries(Object.entries(env).map(([name, value]) => [name.toUpperCase(), value]));
}
