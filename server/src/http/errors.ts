import type { ErrorHandler } from "hono";
import { HTTPException } from "hono/http-exception";
import { ZodError } from "zod";

import type { AppBindings } from "../app";
import { InvalidCallStateError } from "../data/calls";

const errors = {
  400: { code: "INVALID_REQUEST", message: "Invalid request" },
  401: { code: "UNAUTHORIZED", message: "Authentication required" },
  404: { code: "NOT_FOUND", message: "Resource not found" },
  409: {
    code: "INVALID_STATE",
    message: "Operation conflicts with recording state",
  },
  413: {
    code: "FILE_TOO_LARGE",
    message: "Request exceeds the configured size limit",
  },
  416: {
    code: "INVALID_REQUEST",
    message: "Requested byte range is not satisfiable",
  },
  429: { code: "RATE_LIMITED", message: "Retry after backing off" },
  500: { code: "INTERNAL_ERROR", message: "Internal server error" },
} as const;

export const handleError: ErrorHandler<AppBindings> = (error, context) => {
  const status =
    error instanceof HTTPException
      ? error.status
      : error instanceof ZodError || error instanceof SyntaxError
        ? 400
        : error instanceof InvalidCallStateError
          ? 409
          : 500;
  const safeStatus = status in errors ? (status as keyof typeof errors) : 500;
  return context.json(
    { requestId: context.get("requestId"), error: errors[safeStatus] },
    safeStatus,
  );
};
