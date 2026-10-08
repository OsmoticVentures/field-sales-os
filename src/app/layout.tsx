import type { Metadata, Viewport } from "next";
import { Fraunces } from "next/font/google";
import { OutboxRunner } from "../lib/core/outbox-runner";
import { stage } from "../lib/core/stage";
import "./globals.css";

// Display-only, self-hosted at build time (next/font needs no extra
// dependency and ships zero layout shift, no external request at runtime).
// The system stack in globals.css stays the default everywhere else; this
// variable is opted into only by lib/core/ui.tsx's PageHead h1 and the
// pay-period total in ExpensesClient.tsx, matching the source app's
// display-only use (portfolio's layout.tsx sidebar title, lib/ui.tsx's
// PageHead and Stat).
const fraunces = Fraunces({
  subsets: ["latin"],
  variable: "--font-fraunces",
  display: "swap",
});

// Staging reads "Staging" at the front of every tab title,
// so it is never mistaken for the app the reps use. Production keeps its
// plain titles untouched.
const STAGING = stage() === "staging";

export const metadata: Metadata = {
  title: STAGING ? { default: "Staging ClientOS", template: "Staging %s" } : "ClientOS",
  description: "ClientOS",
  robots: { index: false, follow: false },
  appleWebApp: { capable: true, statusBarStyle: "default" },
  other: { "apple-mobile-web-app-capable": "yes" },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className={fraunces.variable}>
      <body>
        {children}
        <OutboxRunner />
      </body>
    </html>
  );
}
