// Thin client for the flare-ota REST API. The server URL and token come from the environment
// (FLARE_OTA_URL, FLARE_OTA_TOKEN); --server/--token override them for one command.

export class ApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

export interface ClientOptions {
  server: string;
  token: string | null;
}

export function resolveClientOptions(flags: { server?: string; token?: string }): ClientOptions {
  const server = (flags.server ?? process.env.FLARE_OTA_URL ?? "").replace(/\/+$/, "");
  if (!server) throw new Error("Set FLARE_OTA_URL to your updates server (e.g. https://ota.example.com) or pass --server.");
  const url = new URL(server);
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname.endsWith(".localhost");
  if (url.protocol !== "https:" && !local) throw new Error("The server must use https:// (http is only accepted for localhost).");
  return { server, token: flags.token ?? process.env.FLARE_OTA_TOKEN ?? null };
}

export class Client {
  constructor(readonly options: ClientOptions) {}

  async request<T>(method: string, path: string, body?: unknown, extraHeaders: Record<string, string> = {}): Promise<T> {
    if (!this.options.token) throw new Error("Set FLARE_OTA_TOKEN (a token from the dashboard's Tokens page).");
    const headers: Record<string, string> = { authorization: `Bearer ${this.options.token}`, ...extraHeaders };
    let payload: BodyInit | undefined;
    if (body instanceof Uint8Array) {
      payload = body as Uint8Array<ArrayBuffer>;
    } else if (body !== undefined) {
      headers["content-type"] = "application/json";
      payload = JSON.stringify(body);
    }
    const response = await fetch(`${this.options.server}${path}`, { method, headers, body: payload });
    const text = await response.text();
    if (!response.ok) {
      let message = text;
      try {
        message = (JSON.parse(text) as { error?: string }).error ?? text;
      } catch {}
      throw new ApiError(response.status, `${method} ${path}: ${response.status} ${message}`);
    }
    return (text ? JSON.parse(text) : null) as T;
  }

  get<T>(path: string) {
    return this.request<T>("GET", path);
  }

  post<T>(path: string, body: unknown = {}) {
    return this.request<T>("POST", path, body);
  }
}
