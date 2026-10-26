import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import type { Prisma } from "@prisma/client";

/** Mandatory privacy webhooks. Preview lead names/emails are retained for the
 * merchant's dashboard; photos and generated images are never persisted.
 * Match by email as well as Shopify ID, including leads whose customer sync failed.
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic, payload } = await authenticate.webhook(request);
  const body = payload as any;
  const rawId = body?.customer?.id;
  const ids = rawId && /^\d+$/.test(String(rawId)) ? [`gid://shopify/Customer/${rawId}`, String(rawId)] : [];
  const email = typeof body?.customer?.email === "string" ? body.customer.email.trim().slice(0, 254) : null;
  const subject: Prisma.LeadDeliveryWhereInput[] = [
    ...(ids.length ? [{ customerRef: { in: ids } }] : []),
    ...(email ? [{ email: { equals: email, mode: "insensitive" as const } }] : []),
  ];

  switch (topic) {
    case "CUSTOMERS_DATA_REQUEST": {
      const leads = subject.length ? await prisma.leadDelivery.count({ where: { shopId: shop, OR: subject } }) : 0;
      // The merchant can access retained contact details in Leads & offers to
      // respond through their privacy process. Never print the details in logs.
      console.log(`Data request for ${shop}: ${leads} lead record(s) available in the merchant dashboard.`);
      break;
    }
    case "CUSTOMERS_REDACT": {
      if (subject.length) {
        await prisma.$transaction([
          prisma.leadDelivery.deleteMany({ where: { shopId: shop, OR: subject } }),
          ...(ids.length ? [
            prisma.previewJob.updateMany({ where: { shopId: shop, verifiedCustomerId: { in: ids } }, data: { verifiedCustomerId: null } }),
            prisma.quotaUsage.updateMany({ where: { shopId: shop, verifiedCustomerId: { in: ids } }, data: { verifiedCustomerId: null } }),
            prisma.consentRecord.deleteMany({ where: { shopId: shop, subjectRef: { in: ids } } }),
          ] : []),
        ]);
      }
      break;
    }
    case "SHOP_REDACT": {
      // Sent 48 hours after a store uninstalls: remove everything we hold for it.
      await prisma.$transaction([
        prisma.shop.deleteMany({ where: { id: shop } }), // cascades to all Tryora data for the store
        prisma.session.deleteMany({ where: { shop } }),
      ]);
      break;
    }
  }
  return new Response();
};
