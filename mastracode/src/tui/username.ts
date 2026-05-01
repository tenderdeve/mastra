export function getMastraCodeUsername(): string | undefined {
  const username = process.env.MC_USER?.trim() || process.env.USER?.trim() || process.env.USERNAME?.trim();
  return username || undefined;
}
