import { useSyncExternalStore } from 'react';

export type Language = 'zh-CN' | 'en';
export type Theme = 'light' | 'dark';
export type Preferences = { language: Language; theme: Theme };
export const preferencesKey = 'baton-preferences';

export function normalizePreferences(raw: Partial<Preferences>): Preferences {
  return {
    language: raw.language === 'en' ? 'en' : 'zh-CN',
    theme: raw.theme === 'dark' ? 'dark' : 'light',
  };
}

// The head script applies saved preferences before the first paint.
let current = normalizePreferences({
  language: document.documentElement.lang as Language,
  theme: document.documentElement.dataset.theme as Theme,
});
const listeners = new Set<() => void>();
export const getPreferences = () => current;
function apply(next: Preferences) {
  current = next;
  document.documentElement.lang = next.language;
  document.documentElement.dataset.theme = next.theme;
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute('content', next.theme === 'dark' ? '#161714' : '#f5f2ea');
  listeners.forEach((listener) => listener());
}
export function setPreferences(change: Partial<Preferences>) {
  const next = normalizePreferences({ ...current, ...change });
  localStorage.setItem(preferencesKey, JSON.stringify(next));
  apply(next);
}
window.addEventListener('storage', (event) => {
  if (event.key !== preferencesKey || !event.newValue) return;
  try {
    apply(normalizePreferences(JSON.parse(event.newValue)));
  } catch (error) {
    console.error('Cannot read Baton appearance preferences.', error);
  }
});
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
export function usePreferences() {
  return useSyncExternalStore(subscribe, getPreferences);
}
