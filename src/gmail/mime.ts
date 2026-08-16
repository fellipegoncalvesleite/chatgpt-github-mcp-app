export type GmailApiHeader = {
  name?: string;
  value?: string;
};

export type GmailApiMessagePart = {
  mimeType?: string;
  filename?: string;
  headers?: GmailApiHeader[];
  body?: {
    data?: string;
    size?: number;
    attachmentId?: string;
  };
  parts?: GmailApiMessagePart[];
};

export type GmailApiMessage = {
  id?: string;
  threadId?: string;
  labelIds?: string[];
  snippet?: string;
  internalDate?: string;
  payload?: GmailApiMessagePart;
};

export type GmailMessageView = {
  id: string;
  threadId: string;
  labelIds: string[];
  snippet: string;
  internalDate: string;
  from: string;
  to: string;
  cc: string;
  bcc: string;
  subject: string;
  date: string;
  messageIdHeader: string;
  textBody: string;
  htmlBody: string;
};

export type ComposeTextMessageInput = {
  to: string[];
  cc?: string[] | undefined;
  bcc?: string[] | undefined;
  subject: string;
  bodyText: string;
};

function assertSafeHeader(value: string): void {
  if (/\r|\n/.test(value)) {
    throw new Error("Email header values must not contain line breaks");
  }
}

function normalizeBodyLines(value: string): string {
  return value.replace(/\r\n|\r|\n/g, "\r\n");
}

function encodeSubject(subject: string): string {
  assertSafeHeader(subject);
  return `=?UTF-8?B?${Buffer.from(subject, "utf8").toString("base64")}?=`;
}

function recipientHeader(name: string, values: string[] | undefined): string[] {
  if (!values?.length) return [];
  for (const value of values) {
    if (!value.trim()) throw new Error(`${name} header contains an empty recipient`);
    assertSafeHeader(value);
  }
  return [`${name}: ${values.join(", ")}`];
}

export function composeTextMessage(input: ComposeTextMessageInput): string {
  if (input.to.length === 0) throw new Error("To header requires at least one recipient");
  const lines = [
    ...recipientHeader("To", input.to),
    ...recipientHeader("Cc", input.cc),
    ...recipientHeader("Bcc", input.bcc),
    `Subject: ${encodeSubject(input.subject)}`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: 8bit",
    "",
    normalizeBodyLines(input.bodyText),
  ];
  return Buffer.from(lines.join("\r\n"), "utf8").toString("base64url");
}

export function decodeBase64Url(value: string): string {
  return Buffer.from(value, "base64url").toString("utf8");
}

function headerValue(headers: GmailApiHeader[] | undefined, name: string): string {
  const match = headers?.find((header) => header.name?.toLowerCase() === name.toLowerCase());
  return match?.value ?? "";
}

function collectBodies(part: GmailApiMessagePart | undefined, output: { text: string[]; html: string[] }): void {
  if (!part) return;
  const data = part.body?.data;
  if (data) {
    const decoded = decodeBase64Url(data);
    if (part.mimeType?.toLowerCase() === "text/plain") output.text.push(decoded);
    if (part.mimeType?.toLowerCase() === "text/html") output.html.push(decoded);
  }
  for (const child of part.parts ?? []) collectBodies(child, output);
}

export function extractMessageView(message: GmailApiMessage): GmailMessageView {
  const bodies = { text: [] as string[], html: [] as string[] };
  collectBodies(message.payload, bodies);
  const headers = message.payload?.headers;
  return {
    id: message.id ?? "",
    threadId: message.threadId ?? "",
    labelIds: message.labelIds ?? [],
    snippet: message.snippet ?? "",
    internalDate: message.internalDate ?? "",
    from: headerValue(headers, "From"),
    to: headerValue(headers, "To"),
    cc: headerValue(headers, "Cc"),
    bcc: headerValue(headers, "Bcc"),
    subject: headerValue(headers, "Subject"),
    date: headerValue(headers, "Date"),
    messageIdHeader: headerValue(headers, "Message-ID"),
    textBody: bodies.text.join("\n"),
    htmlBody: bodies.html.join("\n"),
  };
}
