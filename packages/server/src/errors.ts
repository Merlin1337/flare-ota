import { Invalid } from "./services.ts";
import { Conflict, NotFound } from "./store.ts";

/** Maps domain errors to JSON responses; anything unexpected is logged and hidden. */
export function errorResponse(error: unknown): Response {
  const [status, message] =
    error instanceof Invalid ? [400, error.message]
    : error instanceof NotFound ? [404, error.message]
    : error instanceof Conflict ? [409, error.message]
    : [500, "Internal error"];
  if (status === 500) console.error(error);
  return Response.json({ error: message }, { status, headers: { "cache-control": "no-store" } });
}
