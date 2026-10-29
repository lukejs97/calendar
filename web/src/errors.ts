// Errors reach the website as `{ kind, message }`, exactly like the desktop
// app's (src-tauri/src/error.rs), so the shared screens handle them the same.
import type { AppError as AppErrorBody } from "../../src/api";

type Kind = AppErrorBody["kind"];

export class AppError extends Error {
  constructor(
    readonly kind: Kind,
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }

  toJSON(): AppErrorBody {
    return { kind: this.kind, message: this.message };
  }
}

export const notSignedIn = () => new AppError("notSignedIn", "Not signed in to Google", 401);
export const invalidInput = (message: string) => new AppError("input", `Invalid request: ${message}`);
export const authFailed = (message: string) => new AppError("auth", `Sign-in failed: ${message}`);
export const configError = (message: string) => new AppError("config", message, 500);
export const apiError = (status: number, message: string) =>
  new AppError("api", `Google API error (${status}): ${message}`, 502);

/** Wraps `fetch` so an unreachable service becomes a "network" error. */
export async function fetchOrFail(input: string, init?: RequestInit): Promise<Response> {
  try {
    return await fetch(input, init);
  } catch (e) {
    throw new AppError("network", `Network error: ${e instanceof Error ? e.message : String(e)}`, 502);
  }
}
