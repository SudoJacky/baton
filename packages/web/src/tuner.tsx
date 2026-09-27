import { useI18n } from './i18n.js';
import { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import {
  glassLimits,
  glassModes,
  refracts,
  setGlassParams,
  useGlassParams,
  type GlassMode,
  type GlassParams,
} from './glass.js';

const modeNames: Record<GlassMode, string> = {
  standard: 'Standard · 边缘弯折',
  polar: 'Polar · 整面向心',
  prominent: 'Prominent · 宽弯折带',
  shader: 'Shader · 实验',
};
const sliders: {
  key: keyof typeof glassLimits;
  label: string;
  hint: string;
  format: (value: number) => string;
}[] = [
  {
    key: 'displacementScale',
    label: '位移强度',
    hint: '边缘弯折强度',
    format: String,
  },
  { key: 'blurAmount', label: '模糊程度', hint: '背景模糊，×32px', format: (v) => v.toFixed(2) },
  { key: 'saturation', label: '饱和度', hint: '背景饱和度', format: (v) => `${v}%` },
  {
    key: 'aberrationIntensity',
    label: '色散强度',
    hint: 'RGB 通道错开，边缘色散',
    format: String,
  },
];

/** 导航玻璃（顶栏、侧栏）的调参面板：Alt+G 开关，参数存在本机浏览器。 */
export function GlassTuner() {
  const tr = useI18n();
  const params = useGlassParams();
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    const toggle = (event: KeyboardEvent) => {
      if (event.altKey && !event.ctrlKey && !event.metaKey && event.code === 'KeyG') {
        event.preventDefault();
        setOpen((value) => !value);
      }
    };
    window.addEventListener('keydown', toggle);
    return () => window.removeEventListener('keydown', toggle);
  }, []);
  if (!open) return null;
  const copy = async (value: GlassParams) => {
    await navigator.clipboard.writeText(JSON.stringify(value, null, 2));
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  return (
    <aside className="glass-tuner glass" aria-label={tr('液态玻璃参数')}>
      <header>
        <h2>{tr('液态玻璃')}</h2>
        <button className="icon-button" aria-label={tr('关闭')} onClick={() => setOpen(false)}>
          <X size={16} />
        </button>
      </header>
      {!refracts && (
        <p className="tuner-note">{tr('当前浏览器不支持折射，只有模糊与饱和度生效。')}</p>
      )}
      <fieldset>
        <legend>{tr('折射模式')}</legend>
        {glassModes.map((mode) => (
          <label key={mode}>
            <input
              type="radio"
              name="glass-mode"
              checked={params.mode === mode}
              onChange={() => setGlassParams({ mode })}
            />
            {tr(modeNames[mode])}
          </label>
        ))}
      </fieldset>
      {sliders.map(({ key, label, hint, format }) => {
        const [min, max, step] = glassLimits[key];
        return (
          <label className="tuner-slider" key={key}>
            <span>
              {tr(label)}
              <output>{format(params[key])}</output>
            </span>
            <input
              type="range"
              min={min}
              max={max}
              step={step}
              value={params[key]}
              onChange={(e) => setGlassParams({ [key]: Number(e.target.value) })}
            />
            <small>{tr(hint)}</small>
          </label>
        );
      })}
      <footer>
        <button className="button subtle" onClick={() => setGlassParams(null)}>
          {tr('恢复默认')}
        </button>
        <button className="button" onClick={() => void copy(params)}>
          {copied ? tr('已复制') : tr('复制参数')}
        </button>
      </footer>
    </aside>
  );
}
