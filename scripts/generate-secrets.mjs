import { randomBytes, scryptSync } from "node:crypto";

const password = process.argv[2];
console.log(`OAUTH_SIGNING_SECRET=${randomBytes(48).toString("base64url")}`);
console.log(`OAUTH_STORE_ENCRYPTION_KEY=${randomBytes(32).toString("base64url")}`);
if (password) {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 64);
  console.log(`OAUTH_ADMIN_PASSWORD_HASH=scrypt:${salt.toString("base64url")}:${hash.toString("base64url")}`);
} else {
  console.error("Tip: pass your admin password as the first argument to also generate OAUTH_ADMIN_PASSWORD_HASH.");
}
