import { handleTokenExchange } from "../lib/token-exchange.js";

/** AWS Lambda entry point (API Gateway HTTP API). */
export const handler = async (event) => {
  const result = await handleTokenExchange({
    method: event?.requestContext?.http?.method || event?.httpMethod || "",
    body: event?.body,
    isBase64Encoded: event?.isBase64Encoded,
  });

  return {
    statusCode: result.statusCode,
    headers: result.headers,
    body: typeof result.body === "string" ? result.body : JSON.stringify(result.body),
  };
};
