import type { ActionFunctionArgs } from "react-router";
import { workerAuthorised } from "../preview-worker.server";
import { dropLocalPreview, pollLocalPreview } from "../storefront.server";
import { workerAssistantOperation } from "../assistant/turn-routes.server";

export async function action({ request }: ActionFunctionArgs) {
  if (!workerAuthorised(request.headers.get("Authorization"))) return new Response(null, { status: 401 });
  if (Number(request.headers.get("content-length") ?? 0) > 2048) return new Response(null, { status: 413 });
  const body = await request.json();
  if (typeof body.operation === "string" && body.operation.startsWith("assistant_")) {
    const result = await workerAssistantOperation(body);
    return Response.json(result, { status: result ? 200 : 404, headers: { "Cache-Control": "no-store" } });
  }
  if (typeof body.shopId !== "string" || typeof body.jobId !== "string" || body.jobId.length > 200) return new Response(null, { status: 400 });
  const result = body.operation === "poll" ? await pollLocalPreview(body.shopId, body.jobId) :
    body.operation === "drop" ? await dropLocalPreview(body.shopId, body.jobId) : null;
  return Response.json(result, { status: result ? 200 : 400, headers: { "Cache-Control": "no-store" } });
}
