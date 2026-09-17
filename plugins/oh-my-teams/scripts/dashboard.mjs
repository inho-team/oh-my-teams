/**
 * Dashboard for headless workers: what Orca's tabs showed, served by oh my teams.
 *
 * A dependency-free HTTP server reads the same worker files the headless
 * supervisor writes, and lets a person answer a worker's question or stop a
 * turn from a phone. Every request needs the token printed at start, because
 * the server is usually bound to all interfaces so a tailnet phone can reach
 * it; answering and stopping act on real provider processes.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assert } from "./core.mjs";
import {
  answerHeadless,
  headlessDetail,
  listHeadless,
  stopHeadless,
} from "./headless.mjs";

// The page is a plain HTML file beside this module, read once at load.
const DASHBOARD_HTML = fs.readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), "dashboard.html"),
  "utf8",
);

const BODY_LIMIT = 64 * 1024;
const WORKER_PATH =
  /^\/api\/workers\/([a-z0-9][a-z0-9-]{0,62})(?:\/(answer|stop))?$/;

function sameToken(given, expected) {
  const a = Buffer.from(String(given ?? ""));
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function send(
  response,
  status,
  body,
  type = "application/json; charset=utf-8",
) {
  response.writeHead(status, {
    "content-type": type,
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
  });
  response.end(
    type.startsWith("application/json") ? JSON.stringify(body) : body,
  );
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > BODY_LIMIT) {
        reject(new Error("Request body too large"));
        request.destroy();
      } else chunks.push(chunk);
    });
    request.on("end", () => {
      try {
        resolve(
          chunks.length
            ? JSON.parse(Buffer.concat(chunks).toString("utf8"))
            : {},
        );
      } catch {
        reject(new Error("Request body is not JSON"));
      }
    });
    request.on("error", reject);
  });
}

/**
 * Creates the dashboard HTTP server for one coordinator state directory.
 *
 * @param {object} options - Server options.
 * @param {string} options.stateDir - Coordinator state holding `headless/`.
 * @param {string} options.token - Token every request must carry.
 * @param {object} [options.headless] - `codexHome` and `timeoutMs` passed on.
 * @returns {http.Server} A server that is not yet listening.
 * @throws {Error} When the token is too short to guess safely.
 */
export function createDashboardServer({ stateDir, token, headless = {} }) {
  assert(
    typeof token === "string" && token.length >= 16,
    "Dashboard token must be at least 16 characters",
  );
  return http.createServer(async (request, response) => {
    const url = new URL(request.url, "http://dashboard.local");
    const given =
      request.headers["x-omt-token"] ?? url.searchParams.get("token");
    try {
      if (url.pathname === "/favicon.ico")
        return send(response, 204, "", "text/plain");
      if (request.method === "GET" && url.pathname === "/") {
        // The page itself carries no data; it reads the token from its own URL.
        if (!sameToken(given, token))
          return send(
            response,
            401,
            "토큰이 필요합니다.",
            "text/plain; charset=utf-8",
          );
        return send(response, 200, DASHBOARD_HTML, "text/html; charset=utf-8");
      }
      if (!sameToken(given, token))
        return send(response, 401, { error: "unauthorized" });
      if (request.method === "GET" && url.pathname === "/api/workers") {
        const workers = listHeadless(stateDir, headless);
        return send(response, 200, {
          stateDir,
          workers,
          now: new Date().toISOString(),
        });
      }
      const match = WORKER_PATH.exec(url.pathname);
      if (!match) return send(response, 404, { error: "not found" });
      const [, id, action] = match;
      if (request.method === "GET" && !action) {
        return send(response, 200, headlessDetail(stateDir, id, headless));
      }
      if (request.method === "POST" && action === "answer") {
        const body = await readBody(request);
        return send(
          response,
          200,
          answerHeadless(stateDir, id, body.text, {
            ...headless,
            timeoutMs: headless.timeoutMs,
          }),
        );
      }
      if (request.method === "POST" && action === "stop") {
        return send(response, 200, stopHeadless(stateDir, id));
      }
      return send(response, 405, { error: "method not allowed" });
    } catch (error) {
      return send(response, 400, { error: error.message });
    }
  });
}

/**
 * Starts the dashboard and reports where to open it.
 *
 * @param {object} options - Listen options.
 * @param {string} options.stateDir - Coordinator state holding `headless/`.
 * @param {number} [options.port=4812] - Port to listen on; 0 picks a free one.
 * @param {string} [options.host="0.0.0.0"] - Interface; all by default for a tailnet phone.
 * @param {string} [options.token] - Token to require; generated when omitted.
 * @returns {Promise<{server: http.Server, port: number, host: string, token: string, path: string}>}
 *   The listening server and the path with its token.
 */
export async function startDashboard({
  stateDir,
  port = 4812,
  host = "0.0.0.0",
  token,
}) {
  const secret = token ?? crypto.randomBytes(18).toString("base64url");
  const server = createDashboardServer({ stateDir, token: secret });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      const address = server.address();
      resolve({
        server,
        port: address.port,
        host,
        token: secret,
        path: `/?token=${encodeURIComponent(secret)}`,
      });
    });
  });
}
