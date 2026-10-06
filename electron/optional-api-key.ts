/** An explicitly empty provider key must not inherit another provider's credentials. */
export function connectionKey(explicit: string | undefined, baseUrl: string | undefined, fallback: string | undefined) {
  return explicit ?? (baseUrl ? '' : fallback);
}
/** SDKs require a key value; remove authentication headers for anonymous endpoints. */
export function optionalKeyFetch(apiKey: string | undefined, delegate: typeof fetch = fetch): typeof fetch {
  if (apiKey) return delegate;
  return async (input, init) => {
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    headers.delete('authorization');
    headers.delete('x-api-key');
    return delegate(input, {...init, headers});
  };
}
