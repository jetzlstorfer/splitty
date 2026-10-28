import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { randomBytes } from "node:crypto";
import { preview } from "vite";
import { handler } from "../../api/src/handler";
import { getConfig } from "../../api/src/config";
import { tables } from "../../api/src/storage";

async function freePort() {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No browser-test port was allocated.");
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return address.port;
}

export async function startStorage() {
  const port = await freePort();
  const directory = await mkdtemp(join(tmpdir(), "splitty-e2e-"));
  const account = `splitty${randomBytes(6).toString("hex")}`;
  const key = randomBytes(32).toString("base64");
  const child = spawn(process.execPath, [
    resolve("api", "node_modules", "azurite", "dist", "src", "table", "main.js"),
    "--silent", "--skipApiVersionCheck", "--tableHost", "127.0.0.1",
    "--tablePort", String(port), "--location", directory
  ], { env: { ...process.env, AZURITE_ACCOUNTS: `${account}:${key}` }, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", (chunk: Buffer) => { output += chunk.toString(); });
  child.stderr.on("data", (chunk: Buffer) => { output += chunk.toString(); });
  const running = () => child.exitCode === null && child.signalCode === null;
  const stop = () => { if (running()) child.kill(); };
  process.once("exit", stop);
  const close = async () => {
    process.removeListener("exit", stop);
    if (running()) {
      const exited = once(child, "exit");
      stop();
      await exited;
    }
    await rm(directory, { recursive: true, force: true });
  };
  try {
    const deadline = Date.now() + 30_000;
    while (true) {
      if (!running()) throw new Error(`Browser-test storage exited: ${output}`);
      try { await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(1000) }); break; }
      catch (error) {
        if (Date.now() >= deadline) throw new Error(`Browser-test storage did not start: ${output}`, { cause: error });
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    return {
      connection: `DefaultEndpointsProtocol=http;AccountName=${account};AccountKey=${key};TableEndpoint=http://127.0.0.1:${port}/${account};`,
      close
    };
  } catch (error) {
    await close();
    throw error;
  }
}

export async function startApp() {
  const serviceWorker = await readFile(resolve("dist", "sw.js"), "utf8");
  let revision = 0;
  const server = await preview({
    configFile: false,
    preview: { host: "127.0.0.1", port: 0, strictPort: true },
    plugins: [{
      name: "isolated-browser-test-api",
      configurePreviewServer(server) {
        server.middlewares.use((incoming, outgoing, next) => {
          if (incoming.url?.split("?")[0] === "/sw.js") {
            outgoing.writeHead(200, { "Content-Type": "application/javascript", "Cache-Control": "no-store" });
            outgoing.end(`${serviceWorker}\n/* Browser-test deployment ${revision} */\n`);
          } else if (incoming.url?.startsWith("/api/")) {
            void (async () => {
              const chunks: Buffer[] = [];
              for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
              const headers = new Headers();
              for (const [name, value] of Object.entries(incoming.headers)) {
                if (Array.isArray(value)) for (const item of value) headers.append(name, item);
                else if (value !== undefined) headers.set(name, value);
              }
              const method = incoming.method ?? "GET";
              const response = await handler(new Request(`${process.env.APP_ORIGIN}${incoming.url}`, {
                method, headers, body: method === "GET" || method === "HEAD" ? undefined : Buffer.concat(chunks)
              }));
              outgoing.writeHead(response.status, Object.fromEntries(response.headers));
              outgoing.end(await response.text());
            })().catch((error: unknown) => {
              console.error("Browser-test HTTP request failed.", error);
              outgoing.writeHead(500);
              outgoing.end("Browser-test HTTP request failed.");
            });
          } else next();
        });
      }
    }]
  });
  const address = server.httpServer.address();
  if (!address || typeof address === "string") throw new Error("No browser-test app port was allocated.");
  return {
    origin: `http://127.0.0.1:${address.port}`,
    publishUpdate: () => { revision++; },
    close: () => new Promise<void>((resolve, reject) => {
      if ("closeAllConnections" in server.httpServer) server.httpServer.closeAllConnections();
      server.httpServer.close((error) => error ? reject(error) : resolve());
    })
  };
}

export async function removeHousehold(household: string) {
  if (!/^browser-test-[a-f0-9-]+$/.test(household)) throw new Error("Refusing to remove a non-test household.");
  const clients = await tables(getConfig());
  for (const [table, partitionKey] of [[clients.ledger, household], [clients.auth, `auth-${household}`]] as const) {
    const rows: string[] = [];
    for await (const entity of table.listEntities({ queryOptions: { filter: `PartitionKey eq '${partitionKey}'` } })) {
      if (!entity.rowKey) throw new Error("A browser-test entity has no row key.");
      rows.push(entity.rowKey);
    }
    for (let offset = 0; offset < rows.length; offset += 100) {
      await table.submitTransaction(rows.slice(offset, offset + 100).map((rowKey) => ["delete", { partitionKey, rowKey }]));
    }
  }
}
