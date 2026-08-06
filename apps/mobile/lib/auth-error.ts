/**
 * Map backend auth errors to user-facing strings. The backend returns raw
 * English messages that are fine for logs but should not surface as-is —
 * we map the known shapes to friendlier copy and fall back to the caller's
 * default for anything unrecognised.
 */
export function mapAuthError(err: unknown, fallback: string): string {
  if (!(err instanceof Error)) return fallback;
  const msg = err.message.toLowerCase();
  if (/invalid email or password|incorrect password|wrong password/.test(msg)) {
    return "Email or password is incorrect. Try again.";
  }
  if (/already exists/.test(msg)) {
    return "An account with this email already exists. Sign in instead.";
  }
  if (/valid email address/.test(msg)) {
    return "Enter a valid email address.";
  }
  if (/password must be at least/.test(msg)) {
    return "Use a password with at least 8 characters.";
  }
  if (/registration is disabled/.test(msg)) {
    return "Account registration is disabled on this server.";
  }
  if (/rate.?limit|too many|throttle/.test(msg)) {
    return "Too many attempts. Wait a moment and try again.";
  }
  if (/network|fetch|timeout|unreachable/.test(msg)) {
    return "Can't reach Multica. Check your connection and retry.";
  }
  return fallback;
}
