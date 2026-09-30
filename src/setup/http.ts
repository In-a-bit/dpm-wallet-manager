import { API_KEY_HEADER, type SetupHttp } from "./steps";

const REQUEST_TIMEOUT_MS = 30_000;

/** SetupHttp over fetch. A connection failure rejects; any HTTP answer resolves. */
export const fetchHttp: SetupHttp = async (method, url, options = {}) => {
  const headers: Record<string, string> = {};
  if (options.apiKey) headers[API_KEY_HEADER] = options.apiKey;
  if (options.body !== undefined) headers["Content-Type"] = "application/json";
  const response = await fetch(url, {
    method,
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const text = await response.text();
  return { status: response.status, body: parseBody(text) };
};

function parseBody(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
