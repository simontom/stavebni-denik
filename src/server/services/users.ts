import "server-only";

import { z } from "zod";

import { prisma } from "@/lib/db";
import { hashPassword, verifyPassword } from "@/lib/crypto";
import {
  generatePassword,
  validatePasswordPolicy,
} from "@/lib/password-gen";
import type { Role } from "@/generated/prisma/client";

import type { AuditContext } from "@/server/audit";
import { withAudit } from "@/server/audit";

/**
 * Project a `User` row for the audit log. We MUST never write the
 * argon2id hash into `audit_log` — even though it's a hash, leaking
 * it tightens the attacker's offline-cracking window.
 */
function projectUserForAudit(u: {
  id: string;
  nickname: string;
  displayName: string;
  role: Role;
  ckaitNumber: string | null;
  isActive: boolean;
  mustChangePwd: boolean;
  createdAt: Date;
  createdById: string | null;
  deletedAt: Date | null;
}) {
  return {
    id: u.id,
    nickname: u.nickname,
    displayName: u.displayName,
    role: u.role,
    ckaitNumber: u.ckaitNumber,
    isActive: u.isActive,
    mustChangePwd: u.mustChangePwd,
    createdAt: u.createdAt.toISOString(),
    createdById: u.createdById,
    deletedAt: u.deletedAt ? u.deletedAt.toISOString() : null,
  };
}

/**
 * Validation schema for creating a new user via the admin UI.
 * Nicknames are case-insensitive globally unique — we store them
 * lower-cased to avoid duplicates differing only by case.
 */
export const createUserSchema = z.object({
  nickname: z
    .string()
    .min(3, "Přihlašovací jméno musí mít alespoň 3 znaky.")
    .max(64, "Maximálně 64 znaků.")
    .regex(
      /^[a-z0-9._-]+$/,
      "Povolená jsou malá písmena bez diakritiky, číslice a znaky . _ -",
    ),
  displayName: z
    .string()
    .min(1, "Vyplňte jméno a příjmení.")
    .max(128, "Maximálně 128 znaků."),
  role: z.enum(["BOSS", "WORKER", "GUEST"]),
  ckaitNumber: z
    .string()
    .max(32, "Maximálně 32 znaků.")
    .optional()
    .nullable(),
});

export type CreateUserInput = z.infer<typeof createUserSchema>;

export interface CreateUserResult {
  id: string;
  nickname: string;
  displayName: string;
  role: Role;
  /**
   * The system-generated password. Shown exactly once in the UI and
   * NEVER stored anywhere else. Throw it away after the user copies it.
   */
  generatedPassword: string;
}

export class NicknameInUseError extends Error {
  code = "NicknameInUse" as const;
}

export class PasswordPolicyError extends Error {
  code = "PasswordPolicy" as const;
  constructor(public issues: string[]) {
    super("Heslo nesplňuje pravidla.");
  }
}

export class InvalidCurrentPasswordError extends Error {
  code = "InvalidCurrentPassword" as const;
}

/**
 * BOSS-only — creates a WORKER/GUEST/BOSS user with a freshly generated
 * password. Returns the plaintext password exactly once; the database
 * only ever sees the argon2id hash.
 *
 * `createdById` is recorded for forensic traceability and will be
 * captured in the Stage-3 audit log.
 */
export async function createUser(
  input: CreateUserInput,
  ctx: AuditContext,
  createdById: string,
): Promise<CreateUserResult> {
  const data = createUserSchema.parse(input);
  const nickname = data.nickname.toLowerCase();

  const existing = await prisma.user.findUnique({ where: { nickname } });
  if (existing) throw new NicknameInUseError();

  const generatedPassword = generatePassword();
  const passwordHash = await hashPassword(generatedPassword);

  const created = await withAudit(
    {
      ctx,
      action: "user.create",
      entityType: "user",
      resolveEntityId: (u) => u.id,
      before: null,
      projectAfter: projectUserForAudit,
    },
    (tx) =>
      tx.user.create({
        data: {
          nickname,
          displayName: data.displayName,
          role: data.role,
          ckaitNumber: data.ckaitNumber ?? null,
          passwordHash,
          mustChangePwd: true,
          isActive: true,
          createdById,
        },
      }),
  );

  return {
    id: created.id,
    nickname: created.nickname,
    displayName: created.displayName,
    role: created.role,
    generatedPassword,
  };
}

/**
 * Sets `User.isActive`. Used by BOSS to suspend a user without deleting
 * any historical data (soft-delete-only policy).
 */
export async function setUserActive(
  userId: string,
  isActive: boolean,
  ctx: AuditContext,
): Promise<void> {
  const before = await prisma.user.findUnique({ where: { id: userId } });
  if (!before) return;
  // No-op when already in desired state — keeps the audit log clean.
  if (before.isActive === isActive) return;

  await withAudit(
    {
      ctx,
      action: isActive ? "user.activate" : "user.deactivate",
      entityType: "user",
      resolveEntityId: (u) => u.id,
      before: projectUserForAudit(before),
      projectAfter: projectUserForAudit,
    },
    (tx) =>
      tx.user.update({
        where: { id: userId },
        data: { isActive },
      }),
  );

  // Defence in depth: revoke any live session if we are disabling.
  if (!isActive) {
    await prisma.session.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }
}

/**
 * Self-service password change. The acting user proves possession of
 * the old password before we accept the new one.
 *
 * Used both by the "first password change" forced flow and by an
 * authenticated user updating their password voluntarily.
 */
export async function changePassword(
  userId: string,
  currentPassword: string,
  newPassword: string,
  ctx: AuditContext,
): Promise<void> {
  const issues = validatePasswordPolicy(newPassword);
  if (issues.length > 0) throw new PasswordPolicyError(issues);

  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user || user.deletedAt) throw new InvalidCurrentPasswordError();
  const valid = await verifyPassword(currentPassword, user.passwordHash);
  if (!valid) throw new InvalidCurrentPasswordError();

  // Prevent setting the new password equal to the old one.
  const same = await verifyPassword(newPassword, user.passwordHash);
  if (same) {
    throw new PasswordPolicyError(["Nové heslo musí být odlišné od stávajícího."]);
  }

  const newHash = await hashPassword(newPassword);
  await withAudit(
    {
      ctx,
      action: "user.password-change",
      entityType: "user",
      resolveEntityId: (u) => u.id,
      before: { mustChangePwd: user.mustChangePwd },
      // Never include the hash itself — only the fact that it changed.
      projectAfter: (u) => ({
        id: u.id,
        mustChangePwd: u.mustChangePwd,
        passwordChangedAt: new Date().toISOString(),
      }),
    },
    async (tx) => {
      const updated = await tx.user.update({
        where: { id: userId },
        data: { passwordHash: newHash, mustChangePwd: false },
      });
      // Revoke all live sessions in the same transaction so an
      // attacker holding an old cookie loses access immediately.
      await tx.session.updateMany({
        where: { userId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      return updated;
    },
  );
}

export async function listUsers() {
  return prisma.user.findMany({
    where: { deletedAt: null },
    orderBy: [{ isActive: "desc" }, { createdAt: "asc" }],
    select: {
      id: true,
      nickname: true,
      displayName: true,
      role: true,
      ckaitNumber: true,
      isActive: true,
      mustChangePwd: true,
      createdAt: true,
    },
  });
}
