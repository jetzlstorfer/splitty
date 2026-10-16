import { createServer } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { handler } from "./handler";
import { getConfig } from "./config";

const settingsPath = resolve("local.settings.json");
if (existsSync(settingsPath)) {
  const settings = JSON.parse(readFileSync(settingsPath, "utf8")) as { Values: Record<string, string> };
  for (const [key, value] of Object.entries(settings.Values)) process.env[key] ??= value;
} else if (process.env.LOCAL_DEVELOPMENT === "true") {
  console.log("No local settings file; using explicitly supplied development environment.");
} else {
  throw new Error("Copy api/local.settings.example.json to api/local.settings.json and configure it.");
}
if (process.env.LOCAL_DEVELOPMENT !== "true") throw new Error("The development server requires LOCAL_DEVELOPMENT=true.");
getConfig();

const server = createServer(async (incoming, outgoing) => {
  try {
    const chunks: Buffer[] = [];
    let length = 0;
    for await (const chunk of incoming) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      length += buffer.length;
      if (length > 128_000) { outgoing.writeHead(413); outgoing.end("Request too large."); return; }
      chunks.push(buffer);
    }
    const headers = new Headers();
    for (const [name, value] of Object.entries(incoming.headers)) {
      if (Array.isArray(value)) for (const item of value) headers.append(name, item);
      else if (value !== undefined) headers.set(name, value);
    }
    const method = incoming.method ?? "GET";
    const response = await handler(new Request(`http://127.0.0.1:7071${incoming.url}`, {
      method, headers, body: method === "GET" || method === "HEAD" ? undefined : Buffer.concat(chunks)
    }));
    outgoing.writeHead(response.status, Object.fromEntries(response.headers.entries()));
    outgoing.end(await response.text());
  } catch (error) {
    console.error(`Development HTTP request failed (${error instanceof Error ? error.name : "unknown error"}).`);
    outgoing.writeHead(500); outgoing.end("Request failed.");
  }
});
server.listen(7071, "127.0.0.1", () => console.log("Splitty API listening on http://127.0.0.1:7071"));
