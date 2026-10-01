export const MIN_PASSWORD = 12;

/** Client-side password checks; returns the problem or null. The server re-validates. */
export function passwordProblem(pw: string, confirm: string): string | null {
  if (pw.length < MIN_PASSWORD) return `The password must be at least ${MIN_PASSWORD} characters.`;
  if (pw !== confirm) return "The two passwords do not match.";
  return null;
}
