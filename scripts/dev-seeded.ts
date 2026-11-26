// Starts a local Splitty stack with a synthetic, pre-populated household:
// a private Table emulator, the real API handler and the Vite dev server.
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer as createNetServer } from "node:net";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { createServer, type Plugin } from "vite";
import { getConfig } from "../api/src/config";
import { handler } from "../api/src/handler";
import { expenseLedger, todoLedger } from "../api/src/ledger";
import { tables } from "../api/src/storage";
import { calculateShareA, expenseBalance, type Entry, type Member, type SplitType } from "../shared/model";
import type { Todo } from "../shared/todo";

const { values: options } = parseArgs({
  options: { port: { type: "string", default: "5174" }, reset: { type: "boolean", default: false } }
});
const port = Number(options.port);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Use --port with a valid port number.");

const household = "local-seeded";
// Synthetic loopback-only tokens, matching the browser-test fixtures.
const memberAToken = "A".repeat(43), memberBToken = "B".repeat(43);
const directory = resolve(".azure", "seeded");

async function freePort() {
  const server = createNetServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No emulator port was allocated.");
  await new Promise<void>((done, fail) => server.close((error) => error ? fail(error) : done()));
  return address.port;
}

async function storageAccount() {
  const file = join(directory, "account.json");
  try { return JSON.parse(await readFile(file, "utf8")) as { account: string; key: string }; }
  catch {
    const created = { account: `splitty${randomBytes(6).toString("hex")}`, key: randomBytes(32).toString("base64") };
    await writeFile(file, JSON.stringify(created));
    return created;
  }
}

async function startStorage() {
  if (options.reset) await rm(directory, { recursive: true, force: true });
  await mkdir(join(directory, "data"), { recursive: true });
  const { account, key } = await storageAccount();
  const storagePort = await freePort();
  const child = spawn(process.execPath, [
    resolve("api", "node_modules", "azurite", "dist", "src", "table", "main.js"),
    "--silent", "--skipApiVersionCheck", "--tableHost", "127.0.0.1",
    "--tablePort", String(storagePort), "--location", join(directory, "data")
  ], { env: { ...process.env, AZURITE_ACCOUNTS: `${account}:${key}` }, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", (chunk: Buffer) => { output += chunk.toString(); });
  child.stderr.on("data", (chunk: Buffer) => { output += chunk.toString(); });
  let stopping = false;
  const stop = () => { stopping = true; if (child.exitCode === null && child.signalCode === null) child.kill(); };
  process.once("exit", stop);
  child.once("exit", (code, signal) => {
    if (stopping) return;
    console.error(`The Table emulator stopped unexpectedly (${signal ?? code}): ${output}`);
    process.exit(1);
  });
  console.log("Starting the local Table emulator; the first start can take a minute or two...");
  const deadline = Date.now() + 180_000;
  while (true) {
    if (child.exitCode !== null) { stopping = true; throw new Error(`Table emulator exited: ${output}`); }
    try { await fetch(`http://127.0.0.1:${storagePort}/`, { signal: AbortSignal.timeout(1000) }); break; }
    catch (error) {
      if (Date.now() >= deadline) { stop(); throw new Error(`Table emulator did not start: ${output}`, { cause: error }); }
      await new Promise((done) => setTimeout(done, 100));
    }
  }
  return {
    connection: `DefaultEndpointsProtocol=http;AccountName=${account};AccountKey=${key};TableEndpoint=http://127.0.0.1:${storagePort}/${account};`,
    stop
  };
}

const day = (offset: number) => {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() - offset);
  return date.toISOString().slice(0, 10);
};

function expense(id: string, description: string, category: string, daysAgo: number, amountCents: number,
  paidBy: Member, splitType: SplitType, custom = 0, extra: Partial<Entry> = {}): Entry {
  const shareA = calculateShareA(amountCents, paidBy, splitType, custom);
  return {
    id, kind: "expense", description, date: day(daysAgo), category, currency: "EUR", amountCents, paidBy, shareA,
    balanceA: expenseBalance(amountCents, paidBy, shareA), splitType, categoryMode: "manual",
    ...(splitType === "percent" ? { percentageA: custom } : {}),
    revision: 1, updatedAt: new Date().toISOString(), deleted: false, ...extra
  };
}

function seedEntries(): Entry[] {
  return [
    expense("seed-groceries", "Weekly groceries", "groceries", 1, 8645, "a", "equal"),
    expense("seed-dinner", "Pizza night", "restaurant", 3, 4200, "b", "equal"),
    expense("seed-dentist", "Dentist check-up", "health", 6, 9500, "a", "all-a"),
    expense("seed-electricity", "Electricity bill", "utilities", 10, 12000, "a", "percent", 60),
    expense("seed-fuel", "Fuel", "fuel", 14, 6800, "b", "exact", 2000),
    expense("seed-pharmacy", "Pharmacy", "pharmacy", 20, 2390, "b", "equal", 0,
      { insuranceSubmittedAt: `${day(18)}T09:00:00.000Z` }),
    {
      id: "seed-settlement", kind: "settlement", description: "Settle up", date: day(25), category: "payment",
      currency: "EUR", amountCents: 5000, paidBy: "b", shareA: null, balanceA: -5000,
      revision: 1, updatedAt: new Date().toISOString(), deleted: false
    },
    expense("seed-shelf", "Bookshelf", "home", 35, 14999, "a", "equal"),
    expense("seed-train", "Train tickets", "travel", 40, 11800, "b", "equal"),
    expense("seed-internet", "Internet", "internet", 45, 3990, "a", "equal")
  ];
}

function seedTodos(): Todo[] {
  const todo = (id: string, title: string, daysAgo: number, done = false, description?: string): Todo => ({
    id, title, ...(description ? { description } : {}), done, createdAt: `${day(daysAgo)}T08:00:00.000Z`,
    revision: 1, updatedAt: new Date().toISOString(), deleted: false
  });
  return [
    todo("seed-todo-car", "Book car service", 2, false, "Ask about winter tyres."),
    todo("seed-todo-heating", "Call landlord about heating", 5),
    todo("seed-todo-gift", "Buy birthday gift", 8, false, "Budget around 40 EUR."),
    todo("seed-todo-photos", "Order passport photos", 15, true)
  ];
}

async function seed() {
  const { ledger } = await tables(getConfig());
  if ((await expenseLedger.readChanges(ledger, household, 0)).entries.length) return false;
  for (const entry of seedEntries()) {
    const result = await expenseLedger.applyMutation(ledger, household, { id: `seed-m-${entry.id}`, expectedRevision: 0, entry });
    if (result.status !== "ok") throw new Error(`Could not seed ${entry.id}.`);
  }
  for (const todo of seedTodos()) {
    const result = await todoLedger.applyMutation(ledger, household, { id: `seed-m-${todo.id}`, expectedRevision: 0, entry: todo });
    if (result.status !== "ok") throw new Error(`Could not seed ${todo.id}.`);
  }
  return true;
}

const api: Plugin = {
  name: "seeded-local-api",
  configureServer(server) {
    server.middlewares.use((incoming, outgoing, next) => {
      if (!incoming.url?.startsWith("/api/")) return next();
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
      })().catch(() => {
        console.error("Seeded API request failed.");
        outgoing.writeHead(500);
        outgoing.end("Request failed.");
      });
    });
  }
};

const storage = await startStorage();
Object.assign(process.env, {
  LOCAL_DEVELOPMENT: "true", APP_ORIGIN: `http://127.0.0.1:${port}`, HOUSEHOLD_ID: household,
  TABLE_STORAGE_CONNECTION_STRING: storage.connection, MEMBER_A_TOKEN: memberAToken, MEMBER_B_TOKEN: memberBToken,
  MEMBER_A_NAME: "Alex", MEMBER_B_NAME: "Sam"
});
try {
  const seeded = await seed();
  const server = await createServer({ server: { host: "127.0.0.1", port, strictPort: true }, plugins: [api] });
  await server.listen();
  const shutdown = async () => { await server.close(); storage.stop(); process.exit(0); };
  process.once("SIGINT", () => void shutdown());
  process.once("SIGTERM", () => void shutdown());
  console.log(`
Splitty seeded session: ${process.env.APP_ORIGIN}
${seeded ? "Seeded a synthetic household with expenses and to-dos." : "Reusing existing seeded data (use --reset to start over)."}
Sign in from the cloud icon with a synthetic member token:
  Alex: ${memberAToken}
  Sam:  ${memberBToken}
Data is stored in .azure\\seeded. After --reset, also clear this origin's site data in your browser.
Press Ctrl+C to stop.`);
} catch (error) {
  storage.stop();
  throw error;
}
