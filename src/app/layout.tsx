import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Hexweave",
  description: "Hexweave — generate printable Honeycomb Storage Wall panels",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className={`${geistSans.variable} ${geistMono.variable}`}>
      {/* suppressHydrationWarning: Grammarly and other content-script
          extensions inject data-* attributes on <body> before React
          hydrates, which trips the SSR/client attribute match. Suppressing
          here is the recommended Next.js fix; it only ignores attribute
          diffs on this one element, not children. */}
      <body suppressHydrationWarning>{children}</body>
    </html>
  );
}
