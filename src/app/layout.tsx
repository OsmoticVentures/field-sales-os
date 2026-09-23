import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Field Sales OS",
  description: "Field Sales OS",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
