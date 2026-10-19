/** Shared by channel.tsx (CHANNEL_CODE) and index.tsx (Intelligence config). */
export function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}
