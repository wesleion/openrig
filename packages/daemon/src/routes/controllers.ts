import { Hono } from "hono";
import { ControllerService, ControllerServiceError } from "../domain/controller-service.js";

export const controllerRoutes = new Hono();
controllerRoutes.get("/:nodeId", async c => {
  const service = c.get("controllerService" as never) as ControllerService | undefined;
  if (!service) return c.json({ error: "controller_unavailable" }, 503);
  try { return c.json(await service.status(c.req.param("rigId")!, c.req.param("nodeId"))); }
  catch (e) { return c.json({ error: e instanceof ControllerServiceError ? e.code : "controller_unavailable" }, e instanceof ControllerServiceError ? e.status : 503); }
});
controllerRoutes.patch("/:nodeId", async c => {
  const service = c.get("controllerService" as never) as ControllerService | undefined;
  if (!service) return c.json({ error: "controller_unavailable" }, 503);
  const body = await c.req.json();
  if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).some(k => !["mode", "expectedRevision"].includes(k)))
    return c.json({ error: "invalid_controller_mode" }, 400);
  try { return c.json(await service.setMode(c.req.param("rigId")!, c.req.param("nodeId"), body.mode, body.expectedRevision)); }
  catch (e) { return c.json({ error: e instanceof ControllerServiceError ? e.code : "controller_unavailable" }, e instanceof ControllerServiceError ? e.status : 503); }
});
