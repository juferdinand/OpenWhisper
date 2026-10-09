import german from "../../locales/de.json";

export type UILanguage = "en" | "de";
let locale: UILanguage = "en";
const translations: Record<string, string> = german;

export function setLocale(value: UILanguage) {
  locale = value === "de" ? "de" : "en";
  document.documentElement.lang = locale;
}

/** Translate UI messages only. Dictated text, vocabulary, snippets, paths, and names stay untouched. */
export function t(
  message: string,
  values: Record<string, string | number> = {},
): string {
  let template = locale === "de" ? (translations[message] ?? message) : message;
  // Native services emit English diagnostics; translate known templates while retaining error details.
  if (locale === "de" && !translations[message]) {
    for (const [source, translated] of Object.entries(translations)) {
      if (!source.includes("{error}") && !source.includes("{app}")) continue;
      const names = Array.from(
        source.matchAll(/\{([a-z_]+)\}/g),
        (match) => match[1],
      );
      const pattern = source
        .split(/\{[a-z_]+\}/g)
        .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
        .join("(.*?)");
      const match = new RegExp(`^${pattern}$`, "s").exec(message);
      if (match) {
        template = translated;
        values = Object.fromEntries(
          names.map((name, i) => [name, match[i + 1]]),
        );
        break;
      }
    }
  }
  return template.replace(/\{([a-z_]+)\}/g, (token, name: string) =>
    Object.hasOwn(values, name) ? String(values[name]) : token,
  );
}
