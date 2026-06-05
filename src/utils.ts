import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export function csv(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

export function asBoolean(value: string | undefined, fallback = false): boolean {
  if (value === undefined || value === "") return fallback;
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

export function asInteger(value: string | undefined, fallback: number): number {
  if (value === undefined || value === "") return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) throw new Error(`Expected integer, got ${value}`);
  return parsed;
}

export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("base64url");
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

export function safeEqual(a: string, b: string): boolean {
  const aa = Buffer.from(a);
  const bb = Buffer.from(b);
  return aa.length === bb.length && timingSafeEqual(aa, bb);
}

export function normalizeRepo(value: string): string {
  return value.trim().toLowerCase();
}

export function splitRepo(repository: string): { owner: string; repo: string } {
  const match = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/.exec(repository.trim());
  if (!match) throw new Error(`Invalid repository name: ${repository}`);
  return { owner: match[1]!, repo: match[2]! };
}

export function normalizePath(input: string): string {
  const path = input.replaceAll("\\", "/").replace(/^\/+/, "").replace(/\/{2,}/g, "/");
  if (!path || path === ".") throw new Error("Path must not be empty");
  if (path.includes("\0")) throw new Error("Path contains a null byte");
  const parts = path.split("/");
  if (parts.some((part) => part === "" || part === "." || part === "..")) {
    throw new Error(`Unsafe path: ${input}`);
  }
  return parts.join("/");
}

export function sanitizeBranchSegment(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._/-]+/g, "-")
    .replace(/\.{2,}/g, ".")
    .replace(/\/{2,}/g, "/")
    .replace(/^[-./]+|[-./]+$/g, "")
    .slice(0, 80);
}

export function isLikelyBinary(text: string): boolean {
  if (text.includes("\0")) return true;
  const sample = text.slice(0, 4096);
  let controls = 0;
  for (const char of sample) {
    const code = char.charCodeAt(0);
    if (code < 9 || (code > 13 && code < 32)) controls += 1;
  }
  return sample.length > 0 && controls / sample.length > 0.02;
}

export function htmlEscape(value: string): string {
  return value.replace(/[&<>'"]/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "'": "&#39;",
    '"': "&quot;",
  })[char]!);
}
