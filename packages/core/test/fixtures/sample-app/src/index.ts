import { createServer } from "./server";
import { connect } from "@/lib/db";
import type { User } from "./types";
import React from "react";
import { z } from "zod/v4";
import "./styles.css";
export { slugify } from "./utils";

export async function main(user: User): Promise<void> {
  const db = await connect();
  const server = createServer(db);
  const { default: Lazy } = await import("./lazy");
  console.log(React, z, Lazy, user, server);
}
