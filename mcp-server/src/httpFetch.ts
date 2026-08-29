// Shared fetch/error-handling shape used by both wledClient.ts (talking to a WLED
// device on the LAN) and triggerServerClient.ts (talking to the always-on add-on).
// The two callers differ in how they build the URL/headers and in exactly what they
// report on failure, so those bits are left as parameters rather than unified away.

export interface HttpFetchOptions {
  /** Fully-qualified request URL. */
  url: string;
  init?: RequestInit;
  /** Wrap a network-level fetch failure (host unreachable, DNS, etc.) into a domain-specific Error. */
  onNetworkError: (err: unknown) => Error;
  /** Produce the Error thrown for a non-ok response. May read the response body itself. */
  onHttpError: (res: Response) => Promise<Error>;
  /** Parse the response body for a successful (ok) response. */
  parseBody: (res: Response) => Promise<unknown>;
}

export async function httpFetch(options: HttpFetchOptions): Promise<unknown> {
  const { url, init, onNetworkError, onHttpError, parseBody } = options;
  let res: Response;
  try {
    res = await fetch(url, init);
  } catch (err) {
    throw onNetworkError(err);
  }
  if (!res.ok) {
    throw await onHttpError(res);
  }
  return parseBody(res);
}
