# Next Safe Action Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Integrate `next-safe-action` into the codebase, creating secure, typed server action clients and migrating the `admin/users` module.

**Architecture:** We will create reusable granular clients (`actionClient`, `authActionClient`, `adminActionClient`, `bossActionClient`) in `src/server/safe-action.ts`. These clients will centralize RBAC middleware and audit context injection. We will then iteratively migrate the admin user management actions and their UI components to use the new clients and `useAction` hooks.

**Tech Stack:** Next.js 16 (React 19), Zod, `next-safe-action`

**Spec:** `docs/superpowers/specs/2026-09-12-next-safe-action-migration.md`

## Global Constraints

- Use standard `zod` objects for action parameters in the pilot (no `zfd` / `FormData` inside safe actions).
- Keep existing RBAC functions (`requireUser`, `requireAdmin`, `requireBoss`) and `getAuditContext`.
- Use TDD strictly. Watch tests fail before writing implementation code.
- Commit after each task.

---

### Task 1: Core Action Clients Setup

**Files:**

- Create: `src/server/safe-action.ts`
- Create: `src/server/safe-action.test.ts`

**Interfaces:**

- Produces: `actionClient`, `authActionClient`, `adminActionClient`, `bossActionClient`

- [ ] **Step 1: Install dependency**

```bash
pnpm add next-safe-action
```

- [ ] **Step 2: Write the failing test for action clients**

In `src/server/safe-action.test.ts`:

```typescript
import { describe, it, expect, vi } from "vitest";
import { z } from "zod";
import * as rbac from "@/server/rbac";
import * as auditCtx from "@/server/audit-context";
import { actionClient, authActionClient, adminActionClient } from "./safe-action";

// Mock dependencies
vi.mock("@/server/rbac", () => ({
  requireUser: vi.fn(),
  requireAdmin: vi.fn(),
  requireBoss: vi.fn(),
}));

vi.mock("@/server/audit-context", () => ({
  getAuditContext: vi.fn(),
}));

describe("Safe Action Clients", () => {
  it("authActionClient calls requireUser and getAuditContext", async () => {
    vi.mocked(rbac.requireUser).mockResolvedValue({ id: "user1", role: "WORKER", isAdmin: false });
    vi.mocked(auditCtx.getAuditContext).mockResolvedValue({
      actor: { id: "user1" },
      ip: null,
      userAgent: "test",
    });

    const action = authActionClient
      .schema(z.object({ msg: z.string() }))
      .action(async ({ parsedInput, ctx }) => {
        return { msg: parsedInput.msg, user: ctx.user.id };
      });

    const res = await action({ msg: "hello" });

    expect(res.data).toEqual({ msg: "hello", user: "user1" });
    expect(rbac.requireUser).toHaveBeenCalled();
    expect(auditCtx.getAuditContext).toHaveBeenCalled();
  });

  it("adminActionClient blocks non-admin users", async () => {
    vi.mocked(rbac.requireAdmin).mockRejectedValue(new Error("Forbidden"));

    const action = adminActionClient.schema(z.object({})).action(async () => {
      return { ok: true };
    });

    const res = await action({});
    // actionClient catches errors by default and returns serverError
    expect(res.serverError).toBeDefined();
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm test src/server/safe-action.test.ts`
Expected: FAIL because `safe-action.ts` doesn't exist yet.

- [ ] **Step 4: Write minimal implementation**

Create `src/server/safe-action.ts`:

```typescript
import { createSafeActionClient } from "next-safe-action";
import { requireUser, requireAdmin, requireBoss } from "@/server/rbac";
import { getAuditContext } from "@/server/audit-context";

export const actionClient = createSafeActionClient({
  handleServerError: (e) => {
    console.error("Action error:", e);
    return "Při zpracování požadavku došlo k chybě.";
  },
});

export const authActionClient = actionClient.use(async ({ next }) => {
  const user = await requireUser();
  const auditContext = await getAuditContext();
  return next({ ctx: { user, auditContext } });
});

export const adminActionClient = actionClient.use(async ({ next }) => {
  const user = await requireAdmin();
  const auditContext = await getAuditContext();
  return next({ ctx: { user, auditContext } });
});

export const bossActionClient = actionClient.use(async ({ next }) => {
  const user = await requireBoss();
  const auditContext = await getAuditContext();
  return next({ ctx: { user, auditContext } });
});
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm test src/server/safe-action.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add package.json pnpm-lock.yaml src/server/safe-action.ts src/server/safe-action.test.ts
git commit -m "feat: add safe action clients architecture"
```

---

### Task 2: Migrate `setUserActiveAction`

**Files:**

- Modify: `src/app/(app)/admin/users/actions.ts`
- Modify: `src/app/(app)/admin/users/ToggleActiveButton.tsx`
- Modify: `test/integration/users-delete.int.test.ts` (if it tests toggling) or `test/integration/users-update.int.test.ts`

**Interfaces:**

- Produces: Safe action `setUserActiveAction` receiving `{ userId: string, isActive: boolean }`.

- [ ] **Step 1: Write the failing test**

In `test/integration/users-update.int.test.ts`, update the existing test for toggle active. Change it to pass an object instead of `FormData` and assert on the `next-safe-action` result format (e.g. `result.data.ok` instead of `result.ok`).

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test:integration test/integration/users-update.int.test.ts`
Expected: FAIL due to interface mismatch.

- [ ] **Step 3: Write minimal implementation**

Update `src/app/(app)/admin/users/actions.ts`:

```typescript
import { z } from "zod";
import { adminActionClient } from "@/server/safe-action";
// ... other imports

export const setUserActiveAction = adminActionClient
  .schema(z.object({ userId: z.string(), isActive: z.boolean() }))
  .action(async ({ parsedInput, ctx }) => {
    // move existing logic inside here.
    // ctx.auditContext is available.
    // replace `await requireAdmin()` and `getAuditContext()` with ctx usage.
    // return { ok: true } on success.
  });
```

Update `ToggleActiveButton.tsx` to use `useAction` from `next-safe-action/hooks`:

```tsx
import { useAction } from "next-safe-action/hooks";
// ...
const { execute, isExecuting } = useAction(setUserActiveAction, {
  onSuccess: () => {
    toast.success(isActive ? `${displayName} deaktivován.` : `${displayName} aktivován.`);
  },
  onError: ({ error }) => {
    if (error.serverError) toast.error(error.serverError);
  },
});
// in handleClick: execute({ userId, isActive: !isActive });
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test:integration test/integration/users-update.int.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git commit -am "refactor: migrate setUserActiveAction to next-safe-action"
```

---

### Task 3: Migrate `resetPasswordAction` and `deleteUserAction`

**Files:**

- Modify: `src/app/(app)/admin/users/actions.ts`
- Modify: `src/app/(app)/admin/users/ResetPasswordButton.tsx`
- Modify: `src/app/(app)/admin/users/DeleteUserButton.tsx`
- Modify: `test/integration/users-password-reset.int.test.ts`
- Modify: `test/integration/users-delete.int.test.ts`

- Follow the same TDD steps as Task 2:
  - Update integration tests to use the new object payload and `result.data` structure.
  - See tests fail.
  - Migrate action to `adminActionClient.schema(...).action(...)`.
  - Update UI components to use `useAction`.
  - Verify tests pass.
  - Commit.

---

### Task 4: Migrate `createUserAction` and `editUserAction`

**Files:**

- Modify: `src/app/(app)/admin/users/actions.ts`
- Modify: `src/app/(app)/admin/users/CreateUserDialog.tsx`
- Modify: `src/app/(app)/admin/users/EditUserDialog.tsx`
- Modify: `test/integration/users-update.int.test.ts`
- Modify: `test/integration/audit-chain.int.test.ts` (if affected)

- Follow the same TDD steps:
  - Update tests to send object payloads (no FormData).
  - Assert failing tests.
  - Migrate `createUserAction` and `editUserAction` using `adminActionClient`. Use `next-safe-action` validation errors automatically mapped to `error.validationErrors`.
  - In `CreateUserDialog` and `EditUserDialog`, intercept the form `onSubmit`, construct a payload object (e.g., `Object.fromEntries(new FormData(e.currentTarget))`), parse numeric/boolean fields as needed, and pass it to `execute(payload)`. Use `result.validationErrors` for field-level errors.
  - Verify tests pass.
  - Commit.
