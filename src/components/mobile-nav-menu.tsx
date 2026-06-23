"use client";

import Link from "next/link";
import { Archive, Briefcase, Menu, Users } from "lucide-react";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

interface Props {
  isAdmin: boolean;
}

/**
 * Mobile-only menu (skryté ≥ sm). Replaces the desktop horizontal
 * nav that's `hidden sm:flex` in the header. Without this, WORKER
 * (and anyone really) on a phone only sees logo + bell + sign-out
 * and has no way to navigate to /projects or admin pages.
 *
 * Renders as a hamburger button with a dropdown. We picked dropdown
 * over a full-screen sheet because:
 *   - only 1-3 items, no need for sheet's overlay
 *   - shadcn `sheet` isn't installed yet, dropdown is
 *   - dropdown closes automatically on item click
 *
 * Note: @base-ui (shadcn primitive) uses `render` prop, not Radix `asChild`.
 */
export function MobileNavMenu({ isAdmin }: Props) {

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <button
            type="button"
            aria-label="Otevřít menu"
            className="inline-flex size-9 items-center justify-center rounded-md text-foreground hover:bg-accent hover:text-accent-foreground sm:hidden"
          >
            <Menu className="size-5" aria-hidden />
          </button>
        }
      />
      <DropdownMenuContent align="start" className="w-56">
        <DropdownMenuLabel>Navigace</DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem render={<Link href="/projects" />}>
          <Briefcase className="mr-2 size-4" aria-hidden /> Zakázky
        </DropdownMenuItem>
        {isAdmin && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem render={<Link href="/admin/users" />}>
              <Users className="mr-2 size-4" aria-hidden /> Uživatelé
            </DropdownMenuItem>
            <DropdownMenuItem render={<Link href="/admin/audit" />}>
              <Archive className="mr-2 size-4" aria-hidden /> Audit log
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
