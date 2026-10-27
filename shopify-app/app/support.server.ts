export async function sendSupportMessage(input: { shop: string; email: string; message: string }) {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.SUPPORT_FROM_EMAIL;
  if (!apiKey || !from) throw new Error("Support email is not configured");
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    signal: AbortSignal.timeout(15000),
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from,
      to: ["support@visully.io"],
      reply_to: input.email,
      subject: `Tryora support: ${input.shop}`,
      text: `Store: ${input.shop}\nReply email: ${input.email}\n\n${input.message}`,
    }),
  });
  if (!response.ok) throw new Error("Support email delivery failed");
}
