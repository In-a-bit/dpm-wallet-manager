import type { Request, Response } from "express";

/** The admin UI's session cookie. HttpOnly, so the page's own scripts cannot read it. */
export const SESSION_COOKIE = "dpmm_session";

/**
 * Required on every cookie-authenticated request that changes something. A page on another site
 * cannot set a custom header on a request to this origin without a CORS preflight this service
 * never approves for credentials — so its presence proves the request came from the admin UI.
 */
export const CSRF_HEADER = "x-requested-with";
export const CSRF_HEADER_VALUE = "dpmm-admin";

/** Reads one cookie without pulling in a parser for the single cookie this service sets. */
export function readSessionCookie(request: Request): string | undefined {
  const header = request.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0) continue;
    if (part.slice(0, separator).trim() !== SESSION_COOKIE) continue;
    const value = part.slice(separator + 1).trim();
    return value || undefined;
  }
  return undefined;
}

/**
 * `SameSite=Strict` keeps the browser from sending the cookie on any request another site starts;
 * the CSRF header is the second, independent layer. No `Max-Age`: the server decides when a
 * session ends, and a browser-session cookie does not outlive closing the browser either.
 */
export function setSessionCookie(response: Response, token: string, secure: boolean): void {
  response.setHeader("Set-Cookie", serialize(token, secure, false));
}

export function clearSessionCookie(response: Response, secure: boolean): void {
  response.setHeader("Set-Cookie", serialize("", secure, true));
}

function serialize(value: string, secure: boolean, expire: boolean): string {
  const parts = [`${SESSION_COOKIE}=${value}`, "Path=/", "HttpOnly", "SameSite=Strict"];
  if (secure) parts.push("Secure");
  if (expire) parts.push("Max-Age=0");
  return parts.join("; ");
}
