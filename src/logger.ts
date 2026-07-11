import pino from "pino";
import { config } from "./config.js";

export const logger = pino({
  level: config.logLevel,
  transport:
    config.logLevel === "debug" || process.env.NODE_ENV !== "production"
      ? { target: "pino-pretty" }
      : undefined,
});
