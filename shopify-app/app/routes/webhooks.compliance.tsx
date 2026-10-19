import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";

/**
 * Shopify's mandatory privacy webhooks (required for App Store review).
 *
 * What Tryora holds about a shopper: nothing personal. Room photos and generated images are never stored, and emails
 * go straight into the merchant's Shopify customers. The only links to a person are:
 *  - LeadDelivery.customerRef: the Shopify customer ID a lead was saved to (no email);
 *  - PreviewJob / QuotaUsage.verifiedCustomerId: set only when a signed-in customer used the popup;
 *  - a random browser ID (visitorId) used for shopper limits – not linked to an identity.
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic, payload } = await authenticate.webhook(request);
  const body = payload as any;

  switch (topic) {
    case "CUSTOMERS_DATA_REQUEST": {
      // Shopify forwards this to the merchant, who answers the customer. We hold no personal data beyond the
      // Shopify customer ID itself, so there is nothing extra to send; we just log that the request was received.
      const customerId = body?.customer?.id ? `gid://shopify/Customer/${body.customer.id}` : null;
      const leads = customerId ? await prisma.leadDelivery.count({ where: { shopId: shop, customerRef: customerId } }) : 0;
      console.log(`Data request for ${shop}: ${leads} lead record(s) reference this customer; no personal data stored.`);
      break;
    }
    case "CUSTOMERS_REDACT": {
      const customerId = body?.customer?.id ? `gid://shopify/Customer/${body.customer.id}` : null;
      const legacyId = body?.customer?.id ? String(body.customer.id) : null;
      if (customerId) {
        const ids = [customerId, legacyId!];
        await prisma.$transaction([
          prisma.leadDelivery.deleteMany({ where: { shopId: shop, customerRef: { in: ids } } }),
          prisma.previewJob.updateMany({ where: { shopId: shop, verifiedCustomerId: { in: ids } }, data: { verifiedCustomerId: null } }),
          prisma.quotaUsage.updateMany({ where: { shopId: shop, verifiedCustomerId: { in: ids } }, data: { verifiedCustomerId: null } }),
          prisma.consentRecord.deleteMany({ where: { shopId: shop, subjectRef: { in: ids } } }),
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
