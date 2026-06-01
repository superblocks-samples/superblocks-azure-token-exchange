import { app } from "@azure/functions";
import { handleTokenExchange } from "../../lib/token-exchange.js";

app.http("tokenExchange", {
  methods: ["POST", "OPTIONS"],
  authLevel: "anonymous",
  route: "oauth2/token",
  handler: async (request) => {
    const result = await handleTokenExchange({
      method: request.method,
      body: await request.text(),
    });

    return {
      status: result.statusCode,
      headers: result.headers,
      body: typeof result.body === "string" ? result.body : JSON.stringify(result.body),
    };
  },
});
