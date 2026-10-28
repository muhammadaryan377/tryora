import { createHash } from "node:crypto";
import type { Prisma } from "@prisma/client";
import prisma from "./db.server";

/** Shopify can identify a customer by ID, email, or both. Never look up a subject across shops. */
export function privacySubject(customer: unknown) {
  const input = customer && typeof customer === "object" ? customer as Record<string, unknown> : {};
  const raw = input.id;
  const customerId = typeof raw === "number" && Number.isSafeInteger(raw) && raw > 0
    ? String(raw) : typeof raw === "string" && /^\d{1,20}$/.test(raw) ? raw : null;
  const ids = customerId ? [customerId, `gid://shopify/Customer/${customerId}`] : [];
  const email = typeof input.email === "string" && input.email.trim().length <= 254 &&
    /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.email.trim())
    ? input.email.trim().toLowerCase() : null;
  // ConsentRecord.subjectRef is a customer GID or a normalized-email hash.
  const consentSubjects = [...ids, ...(email ? [
    createHash("sha256").update(email).digest("hex"),
    email,
  ] : [])];
  const or: Prisma.LeadDeliveryWhereInput[] = [
    ...(ids.length ? [{ customerRef: { in: ids } }] : []),
    ...(email ? [{ email: { equals: email, mode: "insensitive" as const } }] : []),
  ];
  return { customerId, ids, email, consentSubjects, or };
}

export async function exportShopifyDataRequest(shopId: string, requestId: string) {
  if (!/^\d{1,30}$/.test(requestId)) throw new Error("Invalid data request ID");
  const request = await prisma.privacyRequest.findUnique({
    where: { shopId_requestId: { shopId, requestId } },
  });
  if (!request) throw new Error("Data request not found");
  const subject = privacySubject({ id: request.customerId, email: request.email });
  const where = subject.or.length ? { shopId, OR: subject.or } : null;
  // Fail closed instead of returning an incomplete customer export. The merchant can
  // contact support to handle unusually large exports with database pagination.
  const [leads, consents] = await Promise.all([
    where ? prisma.leadDelivery.findMany({
      where, take: 1001, orderBy: { createdAt: "asc" },
      select: { id: true, email: true, firstName: true, customerRef: true, marketingOptIn: true,
        marketingWording: true, productId: true, optionValue: true, status: true, createdAt: true },
    }) : [],
    subject.consentSubjects.length ? prisma.consentRecord.findMany({
      where: { shopId, subjectRef: { in: subject.consentSubjects } },
      take: 1001, orderBy: { createdAt: "asc" },
      select: { wording: true, wordingVersion: true, action: true, channel: true, createdAt: true },
    }) : [],
  ]);
  if (leads.length > 1000 || consents.length > 1000)
    throw new Error("Large data request: contact support for a complete export");
  const payload = {
    dataRequestId: requestId,
    customer: { id: request.customerId, email: request.email },
    retainedByVisully: { leadSubmissions: leads, consentRecords: consents },
    notice: "This contains records retained by Visully for this merchant, not all records held by Shopify or other applications. The merchant must deliver the requested information securely.",
  };
  await prisma.privacyRequest.update({
    where: { shopId_requestId: { shopId, requestId } },
    data: { status: "exported", exportedAt: new Date() },
  });
  return payload;
}
