import { readFileSync, readdirSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import ts from 'typescript';
import { english } from '../src/locales/en.js';

vi.mock('../src/preferences.js', () => ({
  getPreferences: () => ({ language: 'zh-CN', theme: 'light' }),
  usePreferences: () => ({ language: 'zh-CN', theme: 'light' }),
}));
import { translate } from '../src/i18n.js';

describe('interface translations', () => {
  it('preserves supplied content, including Chinese, HTML and placeholder-like text', () => {
    const name = '草稿 <script> {1} & $&';
    expect(translate('en', '负责人 {0}', name)).toBe(`Assignee: ${name}`);
    expect(translate('zh-CN', '负责人 {0}', name)).toBe(`负责人 ${name}`);
    expect(translate('en', 'worker.completed')).toBe('worker.completed');
    expect(translate('en', '请先确认 @{0} 已停止执行。{1}', 'coder', false)).toBe(
      'First confirm that @coder has stopped working. ',
    );
    expect(translate('en', '{0} 条未读', 0)).toBe('0 unread');
  });

  it('retains every interpolation slot in each English translation', () => {
    const slots = (text: string) => [...text.matchAll(/\{\d+\}/g)].map((m) => m[0]).sort();
    for (const [source, translation] of Object.entries(english)) {
      expect(translation.trim(), source).not.toBe('');
      expect(translation, source).not.toMatch(/[\p{Script=Han}]/u);
      expect(slots(translation), source).toEqual(slots(source));
    }
  });

  it('covers translated call sites and static interface label catalogs', () => {
    const catalogs = new Set([
      'navigation',
      'flow',
      'availability',
      'statusNames',
      'typeNames',
      'kindNames',
      'mentionStateNames',
      'eventNames',
      'modeNames',
      'sliders',
      'boardColumns',
      'actionNames',
      'queueKinds',
      'runStates',
      'outcomes',
      'taskTabs',
    ]);
    const keys = new Set<string>();
    for (const file of readdirSync(new URL('../src', import.meta.url)).filter((name) =>
      /\.tsx?$/.test(name),
    )) {
      const source = ts.createSourceFile(
        file,
        readFileSync(new URL(`../src/${file}`, import.meta.url), 'utf8'),
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.TSX,
      );
      const collect = (node: ts.Node) => {
        if (ts.isStringLiteral(node) && /[\p{Script=Han}]/u.test(node.text)) keys.add(node.text);
        node.forEachChild(collect);
      };
      const visit = (node: ts.Node) => {
        if (ts.isCallExpression(node) && node.expression.getText(source) === 'tr') {
          const key = node.arguments[0];
          if (key) collect(key);
        }
        if (
          ts.isVariableDeclaration(node) &&
          catalogs.has(node.name.getText(source)) &&
          node.initializer
        )
          collect(node.initializer);
        node.forEachChild(visit);
      };
      visit(source);
    }
    expect(keys.size).toBeGreaterThan(300);
    expect([...keys].filter((key) => !english[key])).toEqual([]);
  });
});

describe('appearance before first paint', () => {
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  const script = html.match(/<script>([\s\S]*?)<\/script>/)![1]!;
  function boot(saved: string | null, dark: boolean, language: string) {
    const root = { dataset: {} as Record<string, string>, lang: '' };
    const meta = { content: '' };
    const error = vi.fn();
    runInNewContext(script, {
      localStorage: { getItem: () => saved },
      matchMedia: () => ({ matches: dark }),
      navigator: { language },
      document: { documentElement: root, querySelector: () => meta },
      console: { error },
    });
    return { root, meta, error };
  }
  it('uses system color and browser language on first visit', () => {
    expect(boot(null, true, 'zh-TW').root).toEqual({ dataset: { theme: 'dark' }, lang: 'zh-CN' });
    expect(boot(null, false, 'fr-FR').root).toEqual({ dataset: { theme: 'light' }, lang: 'en' });
  });
  it('applies saved choices even when they differ from the operating system', () => {
    const saved = boot(JSON.stringify({ theme: 'light', language: 'en' }), true, 'zh-CN');
    expect(saved.root).toEqual({ dataset: { theme: 'light' }, lang: 'en' });
    expect(saved.meta.content).toBe('#f5f2ea');
    const dark = boot(JSON.stringify({ theme: 'dark', language: 'zh-CN' }), false, 'en-US');
    expect(dark.root).toEqual({ dataset: { theme: 'dark' }, lang: 'zh-CN' });
    expect(dark.meta.content).toBe('#161714');
  });
  it('reports corrupt saved data and uses valid defaults', () => {
    const broken = boot('{invalid', false, 'en-US');
    expect(broken.error).toHaveBeenCalledOnce();
    expect(broken.root).toEqual({ dataset: { theme: 'light' }, lang: 'en' });
  });
});
