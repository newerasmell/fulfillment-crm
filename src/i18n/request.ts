import { cookies } from "next/headers";
import { getRequestConfig } from "next-intl/server";
import { DEFAULT_LOCALE, isLocale, LOCALE_COOKIE } from "./locales";

export default getRequestConfig(async () => {
  const store = await cookies();
  const fromCookie = store.get(LOCALE_COOKIE)?.value;
  const locale = isLocale(fromCookie) ? fromCookie : DEFAULT_LOCALE;
  return {
    locale,
    // Every date and time on screen is Sofia time (the team's time zone), whatever the server's clock zone is
    // (Render runs in UTC). APP_TIMEZONE can override it.
    timeZone: process.env.APP_TIMEZONE?.trim() || "Europe/Sofia",
    messages: (await import(`../../messages/${locale}.json`)).default,
  };
});
