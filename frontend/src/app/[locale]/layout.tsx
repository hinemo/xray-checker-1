import type { ReactNode } from "react";
import { notFound } from "next/navigation";
import { NextIntlClientProvider } from "next-intl";

import "../globals.css";
import { locales, type Locale } from "@/i18n/routing";
import { QueryProvider } from "@/components/providers/query-provider";
import { PWARegister } from "@/components/pwa-register";

export const metadata = {
  title: "Xray Checker",
  description: "Proxy health dashboard for Xray Checker",
  manifest: "/manifest.webmanifest",
  icons: {
    icon: "/favicon.svg",
    apple: "/icon.svg",
  },
};

export const viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#0f172a",
};

export const dynamicParams = false;

export function generateStaticParams() {
  return locales.map((locale) => ({ locale }));
}

async function getMessages(locale: string) {
  if (locale === "en") {
    return (await import("@/messages/en.json")).default;
  }
  if (locale === "zh") {
    return (await import("@/messages/zh.json")).default;
  }
  return null;
}

export default async function LocaleLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: { locale: string };
}) {
  const { locale } = params;
  const typedLocale = locale as Locale;
  if (!locales.includes(typedLocale)) {
    notFound();
  }

  const messages = await getMessages(typedLocale);
  if (!messages) {
    notFound();
  }

  return (
    <html lang={typedLocale} suppressHydrationWarning>
      <body className="bg-grid">
        <NextIntlClientProvider messages={messages} locale={locale}>
          <QueryProvider>{children}</QueryProvider>
        </NextIntlClientProvider>
        <PWARegister />
      </body>
    </html>
  );
}
