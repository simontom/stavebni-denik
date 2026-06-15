import type { Metadata, Viewport } from "next";
import { Inter, Geist } from "next/font/google";

import { Toaster } from "sonner";

import { env } from "@/lib/env";
import "./globals.css";
import { cn } from "@/lib/utils";

// Latin Extended is required for full Czech diacritics (ě, š, č, ř, ž, ý, …).
const geist = Geist({subsets:['latin'],variable:'--font-sans'});

export const metadata: Metadata = {
  title: {
    default: env.appName,
    template: `%s · ${env.appName}`,
  },
  description:
    "Elektronický stavební deník dle § 157 stavebního zákona a vyhlášky 499/2006 Sb.",
  applicationName: env.appName,
  // Building-site app — no need to be crawled by search engines.
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  // Lock zoom only on iOS form focus; allow user pinch-zoom otherwise.
  maximumScale: 5,
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#ffffff" },
    { media: "(prefers-color-scheme: dark)", color: "#0a0a0a" },
  ],
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="cs" className={cn("h-full", "antialiased", "font-sans", geist.variable)}>
      <body className="min-h-full flex flex-col bg-background text-foreground">
        {children}
        <Toaster
          position="top-center"
          richColors
          closeButton
          // Mobile-first: stick to viewport edges instead of corners.
          toastOptions={{ duration: 5000 }}
        />
      </body>
    </html>
  );
}
