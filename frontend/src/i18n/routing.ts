export const locales = ["zh", "en"] as const;
export const defaultLocale = "zh";
export type Locale = (typeof locales)[number];
