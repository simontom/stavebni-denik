import { LogOut } from "lucide-react";

import { Button } from "@/components/ui/button";
import { signOutAction } from "@/server/actions/auth";

/**
 * Sign-out button — server-action form to avoid leaking the next-auth
 * client bundle into every page just for a logout.
 */
export function SignOutButton() {
  return (
    <form action={signOutAction}>
      <Button
        type="submit"
        variant="outline"
        size="sm"
        aria-label="Odhlásit se"
      >
        <LogOut className="size-4" aria-hidden />
        <span className="hidden sm:inline">Odhlásit</span>
      </Button>
    </form>
  );
}
