import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = { title: "FOMO Overtime", description: "Overtime slots, claims and payroll totals" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en-GB">
      <body>{children}</body>
    </html>
  );
}
