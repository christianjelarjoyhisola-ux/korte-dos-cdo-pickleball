const MAILEROO_EMAIL_ENDPOINT = "https://smtp.maileroo.com/api/v2/emails";

export type MailerooAddress = {
  address: string;
  display_name?: string;
};

export type MailerooDelivery = {
  referenceId: string | null;
  response: Record<string, unknown>;
};

export function parseEmailAddress(value: string): MailerooAddress {
  const input = String(value || "").trim();
  const named = input.match(/^\s*(.*?)\s*<([^<>\s]+@[^<>\s]+)>\s*$/);
  const address = named ? named[2].trim() : input;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address)) {
    throw new Error(
      "EMAIL_FROM must be a valid address, optionally formatted as Name <email@example.com>",
    );
  }
  const displayName = named?.[1]?.trim().replace(/^['"]|['"]$/g, "");
  return displayName ? { address, display_name: displayName } : { address };
}

export async function sendMailerooEmail(options: {
  apiKey: string;
  from: string;
  to: string;
  toName?: string;
  subject: string;
  html: string;
  tags?: Record<string, string>;
}): Promise<MailerooDelivery> {
  const apiKey = String(options.apiKey || "").trim();
  if (!apiKey) throw new Error("MAILEROO_API_KEY is not configured");

  const recipient = parseEmailAddress(options.to);
  if (options.toName?.trim()) recipient.display_name = options.toName.trim();

  const response = await fetch(MAILEROO_EMAIL_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Api-Key": apiKey,
    },
    body: JSON.stringify({
      from: parseEmailAddress(options.from),
      to: [recipient],
      subject: options.subject,
      html: options.html,
      tracking: true,
      ...(options.tags ? { tags: options.tags } : {}),
    }),
  });

  const json = await response.json().catch(() => ({})) as Record<
    string,
    unknown
  >;
  if (!response.ok || json.success === false) {
    throw new Error(
      `Maileroo error ${response.status}: ${JSON.stringify(json)}`,
    );
  }
  const data =
    (json.data && typeof json.data === "object" ? json.data : {}) as Record<
      string,
      unknown
    >;
  return {
    referenceId: typeof data.reference_id === "string"
      ? data.reference_id
      : null,
    response: json,
  };
}
