import express from "express";
import type { Role } from "./types";

/** Serves the app. */
export class Server {
  private readonly app = express();

  constructor(private readonly db: unknown) {}

  get port(): number {
    return Number(process.env.PORT ?? 3000);
  }

  start(): void {
    this.app.listen(this.port);
  }

  handle = (role: Role): boolean => {
    return role === "admin";
  };
}

export function createServer(db: unknown): Server {
  return new Server(db);
}
