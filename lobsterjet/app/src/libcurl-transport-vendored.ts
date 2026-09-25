/* CI/vendor seam: the real libcurl.wasm transport (BareMux-compatible)
   is dropped here by the vendoring step, replacing this stub. Until
   then, calls throw so the suite records transport-missing instead of
   silently succeeding. Interface:
     init(cfg: { websocket: string }): Promise<void>
     fetch(url: string, init?: RequestInit): Promise<Response>
     getCookies?(url: string): Promise<{ name: string; value: string }[]>
     setCookies?(url: string, cookies: { name: string; value: string }[]): Promise<void>
*/

export async function init(_cfg: { websocket: string }): Promise<void> {
  throw new Error("lobsterjet: libcurl transport not vendored yet");
}

export async function fetch(_url: string, _init?: RequestInit): Promise<Response> {
  throw new Error("lobsterjet: libcurl transport not vendored yet");
}

export async function getCookies(_url: string): Promise<{ name: string; value: string }[]> {
  throw new Error("lobsterjet: libcurl transport not vendored yet");
}

export async function setCookies(
  _url: string,
  _cookies: { name: string; value: string }[],
): Promise<void> {
  throw new Error("lobsterjet: libcurl transport not vendored yet");
}
