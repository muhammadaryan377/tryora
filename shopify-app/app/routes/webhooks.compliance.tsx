import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { privacySubject } from "../privacy.server";

/**
 * Mandatory Shopify privacy webhooks. Never print customer IDs, email addresses, or
 * personal data in logs. Incoming webhook signatures are verified by Shopify SDK.
 * Tested only with an isolated database; never trigger redaction against production to test.
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic, payload } = await authenticate.webhook(request);
  const body = payload as {
    customer?: { id?: number | string | null; email?: string | null };
    data_request?: { id?: number | string | null };
  };
  const subject = privacySubject(body?.customer);

  switch (topic) {
    case "CUSTOMERS_DATA_REQUEST": {
      const raw = body?.data_request?.id;
      const id = raw !== null && raw !== undefined ? String(raw) : "";
      if (!/^\d{1,30}$/.test(id)) throw new Error("Invalid Shopify data request ID");
      // The merchant sees this request on the authenticated Privacy Requests page.
      // Store no images/messages and never claim that webhook ACK means fulfilled.
      await prisma.privacyRequest.upsert({
        where: { shopId_requestId: { shopId: shop, requestId: id } },
        create: { shopId: shop, requestId: id, customerId: subject.customerId, email: subject.email },
        update: {},
      });
      break;
    }

    case "CUSTOMERS_REDACT": {
      if (!subject.or.length) break;
      await prisma.$transaction(async tx => {
        // Customer may have only an email in Shopify's payload, while a previous
        // customerSet call stored a Shopify ID. Resolve both before cleanup.
        const linked = await tx.leadDelivery.findMany({
          where: { shopId: shop, OR: subject.or },
          select: { customerRef: true },
        });
        const refs = Array.from(new Set([
          ...subject.ids,
          ...linked.map(item => item.customerRef).filter((ref): ref is string => !!ref),
        ]));
        const consentSubjects = Array.from(new Set([...subject.consentSubjects, ...refs]));
        await tx.leadDelivery.deleteMany({ where: { shopId: shop, OR: subject.or } });
        if (refs.length) {
          await tx.previewJob.updateMany({
            where: { shopId: shop, verifiedCustomerId: { in: refs } },
            data: { verifiedCustomerId: null },
          });
          await tx.quotaUsage.updateMany({
            where: { shopId: shop, verifiedCustomerId: { in: refs } },
            data: { verifiedCustomerId: null },
          });
        }
        if (consentSubjects.length) {
          await tx.consentRecord.deleteMany({
            where: { shopId: shop, subjectRef: { in: consentSubjects } },
          });
        }
        await tx.privacyRequest.deleteMany({
          where: { shopId: shop, OR: [
            ...(subject.customerId ? [{ customerId: subject.customerId }] : []),
            ...(subject.email ? [{ email: { equals: subject.email, mode: "insensitive" as const } }] : []),
          ] },
        });
      });
      break;
    }

    case "SHOP_REDACT": {
      // Store-owned records (including PrivacyRequest) cascade. Sessions are
      // stored separately and must be removed explicitly as before.
      await prisma.$transaction([
        prisma.shop.deleteMany({ where: { id: shop } }),
        prisma.session.deleteMany({ where: { shop } }),
      ]);
      break;
    }
  }
  return new Response(null, { status: 200 });
};
