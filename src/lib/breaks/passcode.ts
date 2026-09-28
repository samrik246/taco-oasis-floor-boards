import { randomBytes, scrypt as scryptCallback, timingSafeEqual, type ScryptOptions } from "node:crypto";
import { prisma } from "@/lib/db";

function scryptAsync(
  password: Buffer,
  salt: Buffer,
  keylen: number,
  options: ScryptOptions,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCallback(password, salt, keylen, options, (error, derivedKey) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(derivedKey);
    });
  });
}

export const SCRYPT_N = 16_384;
export const SCRYPT_R = 8;
export const SCRYPT_P = 1;
export const SCRYPT_KEYLEN = 32;
export const SALT_BYTES = 16;

const DUMMY_SALT = Buffer.alloc(SALT_BYTES, 0);
const DUMMY_HASH = Buffer.alloc(SCRYPT_KEYLEN, 0);

export class PasscodeRefused extends Error {
  readonly code = "PEPPER";

  constructor() {
    super("STAFF_PASSCODE_PEPPER must be at least 32 bytes");
  }
}

export function staffPasscodePepper(env: NodeJS.ProcessEnv = process.env): string {
  const pepper = env.STAFF_PASSCODE_PEPPER ?? "";
  if (Buffer.byteLength(pepper, "utf8") < 32) throw new PasscodeRefused();
  return pepper;
}

/** scrypt(pepper + code, salt). The salt is the per-row random value, not part of the password. */
export async function hashStaffPasscode(code: string, salt: Buffer, pepper: string): Promise<Buffer> {
  return scryptAsync(Buffer.from(`${pepper}${code}`, "utf8"), salt, SCRYPT_KEYLEN, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
  });
}

export function newPasscodeSalt(): Buffer {
  return randomBytes(SALT_BYTES);
}

/**
 * Timing-safe check. A missing row still runs scrypt, then returns false.
 * Throws when the pepper is missing or shorter than 32 bytes.
 */
export async function verifyStaffPasscode(employeeId: string, code: string): Promise<boolean> {
  const pepper = staffPasscodePepper();
  const row = await prisma.staffPasscode.findUnique({
    where: { employeeId },
    select: { hash: true, salt: true },
  });
  const salt = row ? Buffer.from(row.salt, "hex") : DUMMY_SALT;
  const digest = await hashStaffPasscode(code, salt, pepper);
  const stored = row ? Buffer.from(row.hash, "hex") : DUMMY_HASH;
  if (digest.length !== stored.length) return false;
  const match = timingSafeEqual(digest, stored);
  return row ? match : false;
}
