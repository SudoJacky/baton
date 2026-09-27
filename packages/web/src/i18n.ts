import { useMemo } from 'react';
import { english } from './locales/en.js';
import { getPreferences, usePreferences, type Language } from './preferences.js';

type Value = string | number | boolean | null | undefined;
export function translate(language: Language, source: string, ...values: Value[]) {
  const template = language === 'en' ? (english[source] ?? source) : source;
  return template.replace(/\{(\d+)\}/g, (_, index: string) => {
    const value = values[Number(index)];
    return value == null || typeof value === 'boolean' ? '' : String(value);
  });
}
// For date/event formatting outside React. Components subscribe through useI18n.
export const tr = (source: string, ...values: Value[]) =>
  translate(getPreferences().language, source, ...values);
export const locale = () => (getPreferences().language === 'en' ? 'en-US' : 'zh-CN');
export function useI18n() {
  const { language } = usePreferences();
  return useMemo(
    () =>
      (source: string, ...values: Value[]) =>
        translate(language, source, ...values),
    [language],
  );
}
