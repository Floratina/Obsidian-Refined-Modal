const dictionaries = {
  en: require("./locales/en.json"),
  zh: require("./locales/zh.json"),
  "zh-TW": require("./locales/zh-TW.json"),
  ja: require("./locales/ja.json"),
};

const LANGUAGE_NAMES = {
  zh: "中文（简体）",
  "zh-TW": "中文（繁體）",
  en: "English",
  ja: "日本語",
};

function normalizeLanguage(language) {
  return Object.hasOwn(dictionaries, language) ? language : "auto";
}

function resolveLanguage(preference, getLanguage) {
  const language = normalizeLanguage(preference);
  if (language !== "auto") return language;
  try {
    const detected = typeof getLanguage === "function" ? getLanguage() : undefined;
    return Object.hasOwn(dictionaries, detected) ? detected : "en";
  } catch {
    return "en";
  }
}

function translate(language, key, values = {}) {
  const dictionary = Object.hasOwn(dictionaries, language) ? dictionaries[language] : dictionaries.en;
  const template = dictionary[key] ?? dictionaries.en[key] ?? key;
  return template.replace(/\{(\w+)\}/g, (placeholder, name) =>
    Object.hasOwn(values, name) ? String(values[name]) : placeholder
  );
}

module.exports = { LANGUAGE_NAMES, normalizeLanguage, resolveLanguage, translate };
