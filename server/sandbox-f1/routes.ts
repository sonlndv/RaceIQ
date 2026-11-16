import { Hono } from "hono";
import { getSandboxF1Store, flushSandboxF1, getSandboxF1CaptureError } from "./runtime";
import { sessionDetail, type SandboxF1Store } from "./store";

/** Parent mounts behind existing dashboard authentication middleware. No write endpoints. */
export function createSandboxF1Routes(getStore: () => SandboxF1Store, flush: () => void = () => {}, getCaptureError: () => string | null = () => null) {
  return new Hono()
    .get("/api/sandbox/f1/sessions", (c) => {
      flush();
      return c.json({ sessions: getStore().list() });
    })
    .get("/api/sandbox/f1/sessions/:id", (c) => {
      flush();
      const state = getStore().get(c.req.param("id"));
      if (!state) return c.json({ error: "F1 sandbox session not found" }, 404);
      const detail = sessionDetail(state);
      const error = getCaptureError();
      if (error) {
        detail.coverage.missingData = true;
        detail.coverage.message += ` Capture/checkpoint failure observed: ${error}`;
      }
      return c.json(detail);
    });
}

export const sandboxF1Routes = createSandboxF1Routes(getSandboxF1Store, flushSandboxF1, getSandboxF1CaptureError);
