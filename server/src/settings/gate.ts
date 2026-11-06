import type { MiddlewareHandler } from "hono";

import { ApiError } from "../http/errors";
import type { Env } from "../env";
import type { FeatureName, Features } from "./fields";
import { loadSettings, resolveFeatures } from "./service";

/**
 * 404 `feature_disabled` unless every named feature is on. Mount it after the route's own authentication so
 * only signed-in callers learn which features exist. The app-wide settings middleware has already resolved them.
 */
export function requireFeature(...names: FeatureName[]): MiddlewareHandler {
  return async (context, next) => {
    let features = context.get("features") as Features | undefined;
    if (!features) {
      const env = context.env as Env;
      features = resolveFeatures(env, await loadSettings(env));
    }
    if (!names.every((name) => features[name])) {
      throw new ApiError(404, "feature_disabled", "This feature is turned off. An administrator can turn it on in Config.");
    }
    await next();
  };
}
