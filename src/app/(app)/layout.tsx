import { AppHeader } from "@/components/app-header";
import { requireUser } from "@/server/rbac";

/**
 * Wraps every authenticated page with the persistent app chrome:
 * top navigation, current-user badge, sign-out button. Layouts in
 * Next.js App Router run on every nested render so the gate is
 * automatically applied to all children.
 */
export default async function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const user = await requireUser();
  return (
    <div className="flex min-h-svh flex-col">
      {/* AppHeader is async (it loads the user's notifications). */}
      <AppHeader user={user} />
      <main className="flex-1 px-4 py-6 sm:px-6 sm:py-8 lg:px-8">
        {children}
      </main>
    </div>
  );
}
