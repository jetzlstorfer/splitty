import { app } from "@azure/functions";
import { handler } from "./handler";

app.http("splitty", {
  route: "{*path}",
  methods: ["GET", "POST"],
  authLevel: "anonymous",
  handler: async (request, context) => {
    const response = await handler(new Request(request.url, {
      method: request.method, headers: request.headers,
      body: request.method === "GET" ? undefined : await request.text()
    }), (message) => context.error(message));
    return { status: response.status, headers: Object.fromEntries(response.headers.entries()), body: await response.text() };
  }
});
