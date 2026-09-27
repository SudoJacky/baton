import { useEffect, useRef, useSyncExternalStore } from 'react';

/*
 * 液态玻璃的折射层。
 * 做法借鉴 kube.io《Liquid Glass in the browser》与 rdev/liquid-glass-react（MIT）：
 * 按元素实际尺寸画一张位移贴图，交给 SVG feDisplacementMap，作为 backdrop-filter 的第一道滤镜，
 * 让背后滚过的内容在圆角边缘弯折。只有 Chromium 支持 backdrop-filter: url()，
 * 其它浏览器不挂折射，仍保留 CSS 里的磨砂、染色与高光（见 style.css 的 .glass）。
 *
 * 参数沿用 liquid-glass-react 的命名与含义：
 * - mode：折射算法。standard 只弯边缘；prominent 弯折带更宽；polar 整面向中心收拢；
 *   shader 移植自它的实验性片元着色器。贴图都按元素实际尺寸现场生成，不拉伸固定贴图。
 * - displacementScale：feDisplacementMap 的 scale，边缘最大偏移约为它的一半（px）。
 * - blurAmount：0–1，乘 32 得到模糊半径（px）。
 * - saturation：背景饱和度（%）。
 * - aberrationIntensity：RGB 三通道各做一次位移、错开比例，形成边缘色散；0 为关闭。
 */

export type GlassMode = 'standard' | 'polar' | 'prominent' | 'shader';
export type GlassParams = {
  mode: GlassMode;
  displacementScale: number;
  blurAmount: number;
  saturation: number;
  aberrationIntensity: number;
};

const SVG_NS = 'http://www.w3.org/2000/svg';
export const refracts = (() => {
  const brands = (navigator as Navigator & { userAgentData?: { brands: { brand: string }[] } })
    .userAgentData?.brands;
  return Boolean(brands?.some((b) => b.brand === 'Chromium'));
})();

/* ---------- 导航玻璃的参数（顶栏与侧栏共用），可在调参面板里改，存本地 ---------- */

export const glassModes: GlassMode[] = ['standard', 'polar', 'prominent', 'shader'];
export const defaultGlass: GlassParams = {
  mode: 'standard',
  displacementScale: 80,
  blurAmount: 0.03,
  saturation: 160,
  aberrationIntensity: 3,
};
export const glassLimits = {
  displacementScale: [0, 200, 1],
  blurAmount: [0, 1, 0.01],
  saturation: [100, 300, 5],
  aberrationIntensity: [0, 20, 0.5],
} as const satisfies Record<Exclude<keyof GlassParams, 'mode'>, readonly [number, number, number]>;

const STORAGE_KEY = 'baton-glass';
const clamp = (value: unknown, [min, max]: readonly [number, number, number], fallback: number) =>
  typeof value === 'number' && Number.isFinite(value)
    ? Math.min(max, Math.max(min, value))
    : fallback;
function normalize(raw: Partial<Record<keyof GlassParams, unknown>>): GlassParams {
  return {
    mode: glassModes.includes(raw.mode as GlassMode) ? (raw.mode as GlassMode) : defaultGlass.mode,
    displacementScale: clamp(
      raw.displacementScale,
      glassLimits.displacementScale,
      defaultGlass.displacementScale,
    ),
    blurAmount: clamp(raw.blurAmount, glassLimits.blurAmount, defaultGlass.blurAmount),
    saturation: clamp(raw.saturation, glassLimits.saturation, defaultGlass.saturation),
    aberrationIntensity: clamp(
      raw.aberrationIntensity,
      glassLimits.aberrationIntensity,
      defaultGlass.aberrationIntensity,
    ),
  };
}
let stored: GlassParams = (() => {
  try {
    return normalize(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}'));
  } catch {
    return defaultGlass;
  }
})();
const listeners = new Set<() => void>();
/** 传 null 恢复默认。 */
export function setGlassParams(next: Partial<GlassParams> | null) {
  stored = next ? normalize({ ...stored, ...next }) : defaultGlass;
  try {
    if (next) localStorage.setItem(STORAGE_KEY, JSON.stringify(stored));
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* 隐私模式等拿不到存储时，只在本次会话生效 */
  }
  for (const listener of listeners) listener();
}
export function useGlassParams() {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => stored,
  );
}

/* ---------- 位移贴图 ---------- */

let host: SVGDefsElement | undefined;
let nextId = 0;
function filterHost() {
  if (!host) {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('aria-hidden', 'true');
    // 不能 display:none，否则滤镜失效
    svg.style.cssText = 'position:absolute;width:0;height:0;overflow:hidden;pointer-events:none';
    host = document.createElementNS(SVG_NS, 'defs');
    svg.append(host);
    document.body.append(svg);
  }
  return host;
}

const smoothStep = (a: number, b: number, t: number) => {
  const x = Math.max(0, Math.min(1, (t - a) / (b - a)));
  return x * x * (3 - 2 * x);
};

/**
 * 每个像素给出采样偏移 (vx, vy) ∈ [-1, 1]，编码进 R/G（128 为不动）。
 * feDisplacementMap 据此从 x + scale·vx/2 处取背景色。
 */
type Field = (x: number, y: number) => [number, number];

/** standard / prominent：只在距边缘 band 以内弯折，方向指向内侧。 */
function rimField(
  width: number,
  height: number,
  radius: number,
  band: number,
  prominent: boolean,
): Field {
  const halfW = width / 2;
  const halfH = height / 2;
  return (x, y) => {
    const px = x + 0.5 - halfW;
    const py = y + 0.5 - halfH;
    const qx = Math.abs(px) - (halfW - radius);
    const qy = Math.abs(py) - (halfH - radius);
    const outside = Math.hypot(Math.max(qx, 0), Math.max(qy, 0));
    const depth = radius - outside - Math.min(Math.max(qx, qy), 0);
    if (depth < 0 || depth >= band) return [0, 0];
    let nx = 0;
    let ny = 0;
    if (qx > 0 && qy > 0) {
      nx = (qx / outside) * Math.sign(px);
      ny = (qy / outside) * Math.sign(py);
    } else if (qx > qy) nx = Math.sign(px);
    else ny = Math.sign(py);
    const rim = 1 - depth / band;
    // standard 是圆弧截面，越靠边越陡；prominent 平缓得多，整条弯折带都看得出
    const strength = prominent ? rim * rim : 1 - Math.sqrt(1 - rim * rim);
    return [-nx * strength, -ny * strength];
  };
}

/** polar：整面像凸透镜，越往外越向中心收拢。 */
function polarField(width: number, height: number): Field {
  return (x, y) => {
    const u = (x + 0.5) / (width / 2) - 1;
    const v = (y + 0.5) / (height / 2) - 1;
    const r = Math.hypot(u, v) / Math.SQRT2;
    return [(-u * r) / Math.SQRT2, (-v * r) / Math.SQRT2];
  };
}

/** shader：移植自 liquid-glass-react 的 liquidGlass 片元着色器。 */
function shaderField(width: number, height: number): Field {
  const raw = new Float32Array(width * height * 2);
  let max = 1;
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const ix = x / width - 0.5;
      const iy = y / height - 0.5;
      const qx = Math.abs(ix) + 0.3;
      const qy = Math.abs(iy) + 0.4;
      const edge = Math.hypot(qx, qy) - 0.6;
      const scaled = smoothStep(0, 1, smoothStep(0.8, 0, edge - 0.15));
      const smooth = Math.min(1, Math.min(x, y, width - x - 1, height - y - 1) / 2);
      const dx = ix * (scaled - 1) * width * smooth;
      const dy = iy * (scaled - 1) * height * smooth;
      raw[(y * width + x) * 2] = dx;
      raw[(y * width + x) * 2 + 1] = dy;
      max = Math.max(max, Math.abs(dx), Math.abs(dy));
    }
  return (x, y) => [raw[(y * width + x) * 2]! / max, raw[(y * width + x) * 2 + 1]! / max];
}

function displacementMap(width: number, height: number, radius: number, mode: GlassMode) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d')!;
  const image = context.createImageData(width, height);
  const pixels = new Uint32Array(image.data.buffer);
  pixels.fill(0xff008080); // 小端序：A=255, B=0, G=128, R=128
  const half = Math.floor(Math.min(width, height) / 2);
  const band = Math.max(1, mode === 'standard' ? Math.min(20, half) : half);
  const field =
    mode === 'polar'
      ? polarField(width, height)
      : mode === 'shader'
        ? shaderField(width, height)
        : rimField(width, height, radius, band, mode === 'prominent');
  const rimOnly = mode === 'standard' || mode === 'prominent';
  const edge = band + radius;
  for (let y = 0; y < height; y++) {
    const edgeRow = y < edge || y >= height - edge;
    for (let x = 0; x < width; x++) {
      // 只弯边缘的模式，中间行跳过两条边带之间的部分
      if (rimOnly && !edgeRow && x === band) x = width - band;
      const [vx, vy] = field(x, y);
      if (!vx && !vy) continue;
      const r = Math.round(128 + Math.max(-1, Math.min(1, vx)) * 127);
      const g = Math.round(128 + Math.max(-1, Math.min(1, vy)) * 127);
      pixels[y * width + x] = (0xff000000 | (g << 8) | r) >>> 0;
    }
  }
  context.putImageData(image, 0, 0);
  return canvas.toDataURL();
}

/** 色散：三次位移、各取一个通道再叠回；aberration 为 0 时只做一次。 */
function displacementPrimitives(scale: number, aberration: number) {
  const make = (tag: string, attributes: Record<string, string | number>) => {
    const node = document.createElementNS(SVG_NS, tag);
    for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, String(value));
    return node;
  };
  const displace = (factor: number, result?: string) =>
    make('feDisplacementMap', {
      in: 'SourceGraphic',
      in2: 'map',
      scale: scale * factor,
      xChannelSelector: 'R',
      yChannelSelector: 'G',
      ...(result ? { result } : {}),
    });
  if (!aberration) return [displace(1)];
  const channel = (from: string, index: number, result: string) => {
    const rows = ['0 0 0 0 0', '0 0 0 0 0', '0 0 0 0 0', '0 0 0 1 0'];
    rows[index] = ['1 0 0 0 0', '0 1 0 0 0', '0 0 1 0 0'][index]!;
    return make('feColorMatrix', { in: from, type: 'matrix', values: rows.join(' '), result });
  };
  return [
    displace(1, 'red'),
    channel('red', 0, 'r'),
    displace(1 - aberration * 0.05, 'green'),
    channel('green', 1, 'g'),
    displace(1 - aberration * 0.1, 'blue'),
    channel('blue', 2, 'b'),
    make('feBlend', { in: 'g', in2: 'b', mode: 'screen', result: 'gb' }),
    make('feBlend', { in: 'r', in2: 'gb', mode: 'screen' }),
  ];
}

/**
 * 给元素挂上液态玻璃：折射写入 --glass-refraction（仅 Chromium），
 * 模糊与饱和度写入 --glass-blur / --glass-saturate（所有浏览器），由 CSS 拼进 backdrop-filter。
 * 没给 blurAmount / saturation 时沿用 CSS 里的值。尺寸、圆角或模式变化时重画贴图。
 */
export function useLiquidGlass(element: HTMLElement | null, params: Partial<GlassParams> = {}) {
  const {
    mode = 'standard',
    displacementScale = defaultGlass.displacementScale,
    aberrationIntensity = 0,
    blurAmount,
    saturation,
  } = params;
  const filterRef = useRef<SVGFilterElement>(null);

  // 滤镜与贴图：只随元素尺寸和模式变化，拖动滑块时不重画
  useEffect(() => {
    if (!element || !refracts) return;
    const id = `liquid-glass-${++nextId}`;
    const filter = document.createElementNS(SVG_NS, 'filter');
    filter.id = id;
    filter.setAttribute('filterUnits', 'userSpaceOnUse');
    filter.setAttribute('color-interpolation-filters', 'sRGB');
    const map = document.createElementNS(SVG_NS, 'feImage');
    map.setAttribute('preserveAspectRatio', 'none');
    map.setAttribute('result', 'map');
    filter.append(map);
    filterHost().append(filter);
    filterRef.current = filter;

    let drawn = '';
    let frame = 0;
    const draw = () => {
      frame = 0;
      const width = element.offsetWidth;
      const height = element.offsetHeight;
      if (!width || !height) return;
      const radius = Math.min(
        parseFloat(getComputedStyle(element).borderTopLeftRadius) || 0,
        width / 2,
        height / 2,
      );
      const key = `${width}x${height}@${radius}`;
      if (key === drawn) return;
      drawn = key;
      for (const node of [filter, map]) {
        node.setAttribute('x', '0');
        node.setAttribute('y', '0');
        node.setAttribute('width', String(width));
        node.setAttribute('height', String(height));
      }
      map.setAttribute('href', displacementMap(width, height, radius, mode));
      element.style.setProperty('--glass-refraction', `url(#${id})`);
    };
    const observer = new ResizeObserver(() => {
      frame ||= requestAnimationFrame(draw);
    });
    observer.observe(element);
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
      filter.remove();
      filterRef.current = null;
      element.style.removeProperty('--glass-refraction');
    };
  }, [element, mode]);

  // 位移强度与色散：只换滤镜里的位移节点
  useEffect(() => {
    const filter = filterRef.current;
    if (!filter) return;
    const map = filter.firstElementChild!;
    map.after(...displacementPrimitives(displacementScale, aberrationIntensity));
    return () => {
      while (map.nextSibling) map.nextSibling.remove();
    };
  }, [element, mode, displacementScale, aberrationIntensity]);

  useEffect(() => {
    if (!element) return;
    if (blurAmount !== undefined) element.style.setProperty('--glass-blur', `${blurAmount * 32}px`);
    if (saturation !== undefined) element.style.setProperty('--glass-saturate', `${saturation}%`);
    return () => {
      element.style.removeProperty('--glass-blur');
      element.style.removeProperty('--glass-saturate');
    };
  }, [element, blurAmount, saturation]);
}

/**
 * 指针在玻璃上移动时，把相对坐标写进 --glass-x / --glass-y，CSS 据此画一团跟随的高光。
 * 全页只挂一个监听，按 rAF 节流。
 */
export function useGlassLight() {
  useEffect(() => {
    let frame = 0;
    let last: PointerEvent | undefined;
    const update = () => {
      frame = 0;
      const glass = (last?.target as Element | null)?.closest?.<HTMLElement>('.glass:not(dialog)');
      if (!glass || !last) return;
      const box = glass.getBoundingClientRect();
      glass.style.setProperty('--glass-x', `${last.clientX - box.left}px`);
      glass.style.setProperty('--glass-y', `${last.clientY - box.top}px`);
    };
    const move = (event: PointerEvent) => {
      last = event;
      frame ||= requestAnimationFrame(update);
    };
    document.addEventListener('pointermove', move, { passive: true });
    return () => {
      document.removeEventListener('pointermove', move);
      cancelAnimationFrame(frame);
    };
  }, []);
}
