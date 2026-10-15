// 单元格样式回写（格式继承）：工作层（FortuneSheet 内联样式）→ OOXML styles.xml。
//
// 只翻译"用户真正改过"的样式键，其它格子的原件样式原样保留：
//   bl 加粗 / it 斜体 / un 下划线 / cl 删除线 / fs 字号(pt) / fc 字色 / bg 底色 /
//   ht 水平对齐（1 中、2 右，0 左是默认不写）/ vt 垂直对齐（1 中、2 下，0 上不写）/
//   tb 换行（2 = 换行）。
// 边框暂不回写（工作层的 borderInfo 是区域式记录，映射需要单独做，列入待办）。
//
// StyleBook 同时兼容两种场景：原件已有 styles.xml（带图版，在原件上追加）、
// 没有（普通版最小生成，先写一份最小样式表）。
import { partText } from './zip.js';
import { parseXml, serializeXml, children, createEl, descendants } from './xml.js';

const XML_DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n';
const encoder = new TextEncoder();
const NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';

const DEFAULT_STYLES_XML = XML_DECL +
  '<styleSheet xmlns="' + NS + '">' +
  '<fonts count="1"><font><sz val="11"/><name val="Calibri"/><family val="2"/></font></fonts>' +
  '<fills count="2"><fill><patternFill patternType="none"/></fill>' +
  '<fill><patternFill patternType="gray125"/></fill></fills>' +
  '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
  '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
  '<cellXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/></cellXfs>' +
  '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>' +
  '</styleSheet>';

/** 十六进制颜色 → ARGB（'#ff0000' → 'FFFF0000'）；不认识的格式返回 null */
export function argbOf(color) {
  if (typeof color !== 'string') return null;
  const m = /^#?([0-9a-fA-F]{6})$/.exec(color.trim());
  return m ? 'FF' + m[1].toUpperCase() : null;
}

/**
 * 工作层格子 → 样式描述（没有任何"改过"的键时返回 null）。
 * 只看真正会改变外观的值，避免把编辑器填的默认值当成用户改动。
 */
export function specOf(cellV) {
  if (!cellV || typeof cellV !== 'object') return null;
  const spec = {};
  if (cellV.bl) spec.bold = true;
  if (cellV.it) spec.italic = true;
  if (cellV.un) spec.underline = true;
  if (cellV.cl) spec.strike = true;
  if (typeof cellV.fs === 'number' && cellV.fs > 0) spec.size = cellV.fs;
  const fc = argbOf(cellV.fc);
  if (fc && fc !== 'FF000000') spec.color = fc;
  const bg = argbOf(cellV.bg);
  if (bg) spec.fill = bg;
  if (cellV.ht === 1) spec.h = 'center';
  else if (cellV.ht === 2) spec.h = 'right';
  if (cellV.vt === 1) spec.v = 'center';
  else if (cellV.vt === 2) spec.v = 'bottom';
  if (cellV.tb === 2) spec.wrap = true;
  return Object.keys(spec).length ? spec : null;
}

export class StyleBook {
  constructor(doc) {
    this.doc = doc;
    this.root = doc.documentElement;
    this.fontsEl = children(this.root, 'fonts')[0];
    this.fillsEl = children(this.root, 'fills')[0];
    this.xfsEl = children(this.root, 'cellXfs')[0];
    this.fontCache = new Map();
    this.fillCache = new Map();
    this.xfCache = new Map();
    this.dirty = false;
  }

  /** 从 parts 读样式表；没有就用最小默认表（不改 parts，save 时才写） */
  static load(parts) {
    const text = partText(parts, 'xl/styles.xml') || DEFAULT_STYLES_XML;
    return new StyleBook(parseXml(text));
  }

  _fontIndex(spec) {
    const key = [spec.bold, spec.italic, spec.underline, spec.strike, spec.size, spec.color].join('|');
    if (this.fontCache.has(key)) return this.fontCache.get(key);
    const font = createEl(this.doc, 'font');
    if (spec.bold) font.appendChild(createEl(this.doc, 'b'));
    if (spec.italic) font.appendChild(createEl(this.doc, 'i'));
    if (spec.strike) font.appendChild(createEl(this.doc, 'strike'));
    if (spec.underline) font.appendChild(createEl(this.doc, 'u'));
    const sz = createEl(this.doc, 'sz');
    sz.setAttribute('val', String(spec.size || 11));
    font.appendChild(sz);
    if (spec.color) {
      const c = createEl(this.doc, 'color');
      c.setAttribute('rgb', spec.color);
      font.appendChild(c);
    }
    const name = createEl(this.doc, 'name');
    name.setAttribute('val', 'Calibri');
    font.appendChild(name);
    this.fontsEl.appendChild(font);
    const idx = children(this.fontsEl, 'font').length - 1;
    this.fontsEl.setAttribute('count', String(idx + 1));
    this.fontCache.set(key, idx);
    this.dirty = true;
    return idx;
  }

  _fillIndex(argb) {
    if (!argb) return 0;
    if (this.fillCache.has(argb)) return this.fillCache.get(argb);
    const fill = createEl(this.doc, 'fill');
    const pf = createEl(this.doc, 'patternFill');
    pf.setAttribute('patternType', 'solid');
    const fg = createEl(this.doc, 'fgColor');
    fg.setAttribute('rgb', argb);
    const bg = createEl(this.doc, 'bgColor');
    bg.setAttribute('indexed', '64');
    pf.appendChild(fg);
    pf.appendChild(bg);
    fill.appendChild(pf);
    this.fillsEl.appendChild(fill);
    const idx = children(this.fillsEl, 'fill').length - 1;
    this.fillsEl.setAttribute('count', String(idx + 1));
    this.fillCache.set(argb, idx);
    this.dirty = true;
    return idx;
  }

  /** 样式描述 → cellXfs 下标（同一描述只追加一次） */
  xfFor(spec) {
    const key = JSON.stringify(spec);
    if (this.xfCache.has(key)) return this.xfCache.get(key);
    const fontId = this._fontIndex(spec);
    const fillId = this._fillIndex(spec.fill);
    const xf = createEl(this.doc, 'xf');
    xf.setAttribute('numFmtId', '0');
    xf.setAttribute('fontId', String(fontId));
    xf.setAttribute('fillId', String(fillId));
    xf.setAttribute('borderId', '0');
    xf.setAttribute('xfId', '0');
    xf.setAttribute('applyFont', '1');
    if (fillId) xf.setAttribute('applyFill', '1');
    if (spec.h || spec.v || spec.wrap) {
      xf.setAttribute('applyAlignment', '1');
      const al = createEl(this.doc, 'alignment');
      if (spec.h) al.setAttribute('horizontal', spec.h);
      if (spec.v) al.setAttribute('vertical', spec.v);
      if (spec.wrap) al.setAttribute('wrapText', '1');
      xf.appendChild(al);
    }
    this.xfsEl.appendChild(xf);
    const idx = children(this.xfsEl, 'xf').length - 1;
    this.xfsEl.setAttribute('count', String(idx + 1));
    this.xfCache.set(key, idx);
    this.dirty = true;
    return idx;
  }

  /** 有改动才写回 parts（没改就不动原件的 styles.xml） */
  save(parts) {
    if (!this.dirty) return false;
    parts.set('xl/styles.xml', encoder.encode(XML_DECL + serializeXml(this.doc)));
    return true;
  }

  /* ----- 与原件 xf 合并（格式继承的关键，2026-10-15 修） -----
   * 旧实现：用户在工作层改了任何一项样式，回写就用 spec 从零造一个
   * xf 覆盖原件——原字体名、边框、数字格式、没动过的填充全被冲掉，
   * 等于"改一处丢一片"。现在改为在原件 xf 的基础上合并 spec：
   * spec 点到的键覆盖，没点到的（字体名/边框/数字格式/其余对齐）
   * 一律沿用原件；合并结果与原件完全一致时原样返回下标、不弄脏
   * 样式表（保住"没改格式 → styles.xml 逐字节不变"）。 */

  /** 原件第 idx 个 xf 解析成与 spec 同形状的描述；越界返回 null */
  _baseDescriptor(idx) {
    const xfs = children(this.xfsEl, 'xf');
    const xf = xfs[idx];
    if (!xf) return null;
    const fonts = children(this.fontsEl, 'font');
    const font = fonts[Number(xf.getAttribute('fontId'))];
    const fills = children(this.fillsEl, 'fill');
    const fill = fills[Number(xf.getAttribute('fillId'))];
    const desc = { bold: false, italic: false, underline: false, strike: false, size: null, color: null, fill: null, h: null, v: null, wrap: false };
    if (font) {
      desc.bold = descendants(font, 'b').length > 0;
      desc.italic = descendants(font, 'i').length > 0;
      desc.strike = descendants(font, 'strike').length > 0;
      const u = descendants(font, 'u')[0];
      desc.underline = !!u && u.getAttribute('val') !== 'none';
      const sz = descendants(font, 'sz')[0];
      desc.size = sz ? parseFloat(sz.getAttribute('val')) : null;
      const col = descendants(font, 'color')[0];
      desc.color = col ? (col.getAttribute('rgb') || null) : null;
    }
    if (fill) {
      const pf = descendants(fill, 'patternFill')[0];
      if (pf && pf.getAttribute('patternType') === 'solid') {
        const fg = descendants(pf, 'fgColor')[0];
        desc.fill = fg ? (fg.getAttribute('rgb') || null) : null;
      }
    }
    const al = descendants(xf, 'alignment')[0];
    if (al) {
      desc.h = al.getAttribute('horizontal') || null;
      desc.v = al.getAttribute('vertical') || null;
      desc.wrap = al.getAttribute('wrapText') === '1' || al.getAttribute('wrapText') === 'true';
    }
    desc._fontId = Number(xf.getAttribute('fontId'));
    desc._fillId = Number(xf.getAttribute('fillId'));
    desc._xf = xf;
    return desc;
  }

  /** spec（specOf 的输出）覆盖到 base 描述上 → 合并描述（不带 DOM 引用） */
  _mergeDesc(base, spec) {
    const m = {
      bold: base.bold, italic: base.italic, underline: base.underline,
      strike: base.strike, size: base.size, color: base.color,
      fill: base.fill, h: base.h, v: base.v, wrap: base.wrap,
    };
    if (spec.bold) m.bold = true;
    if (spec.italic) m.italic = true;
    if (spec.underline) m.underline = true;
    if (spec.strike) m.strike = true;
    if (spec.size) m.size = spec.size;
    if (spec.color) m.color = spec.color;
    if (spec.fill) m.fill = spec.fill;
    if (spec.h) m.h = spec.h;
    if (spec.v) m.v = spec.v;
    if (spec.wrap) m.wrap = true;
    return m;
  }

  _descEq(a, b) {
    return a.bold === b.bold && a.italic === b.italic && a.underline === b.underline &&
      a.strike === b.strike && a.size === b.size && a.color === b.color &&
      a.fill === b.fill && a.h === b.h && a.v === b.v && a.wrap === b.wrap;
  }

  /** 以原件第 baseIdx 个 xf 为基底合并 spec → xf 下标（无基底退回 xfFor） */
  xfForWithBase(spec, baseIdx) {
    if (baseIdx === null || baseIdx === undefined || !Number.isInteger(baseIdx)) {
      return this.xfFor(spec);
    }
    const base = this._baseDescriptor(baseIdx);
    if (!base) return this.xfFor(spec);
    const merged = this._mergeDesc(base, spec);
    if (this._descEq(merged, base)) return baseIdx; // 没净变化：不弄脏样式表
    const cacheKey = 'base' + baseIdx + '|' + JSON.stringify(merged);
    if (this.xfCache.has(cacheKey)) return this.xfCache.get(cacheKey);

    // 字体：克隆原件字体再按合并结果增删/改值，字体名等未翻译属性原样保留
    let fontId = base._fontId;
    const fontChanged = merged.bold !== base.bold || merged.italic !== base.italic ||
      merged.underline !== base.underline || merged.strike !== base.strike ||
      merged.size !== base.size || merged.color !== base.color;
    if (fontChanged) {
      const fonts = children(this.fontsEl, 'font');
      const srcFont = fonts[base._fontId];
      const font = srcFont ? srcFont.cloneNode(true) : createEl(this.doc, 'font');
      const ensure = (tag, on) => {
        const has = descendants(font, tag).length > 0;
        if (on && !has) font.appendChild(createEl(this.doc, tag));
      };
      ensure('b', merged.bold); ensure('i', merged.italic);
      ensure('strike', merged.strike); ensure('u', merged.underline);
      let sz = descendants(font, 'sz')[0];
      if (merged.size) {
        if (!sz) { sz = createEl(this.doc, 'sz'); font.appendChild(sz); }
        sz.setAttribute('val', String(merged.size));
      }
      if (merged.color) {
        let col = descendants(font, 'color')[0];
        if (!col) { col = createEl(this.doc, 'color'); font.appendChild(col); }
        col.setAttribute('rgb', merged.color);
        col.removeAttribute('theme'); col.removeAttribute('indexed');
      }
      if (!descendants(font, 'sz').length) {
        const s = createEl(this.doc, 'sz'); s.setAttribute('val', '11'); font.appendChild(s);
      }
      if (!descendants(font, 'name').length) {
        const nm = createEl(this.doc, 'name'); nm.setAttribute('val', 'Calibri'); font.appendChild(nm);
      }
      this.fontsEl.appendChild(font);
      fontId = children(this.fontsEl, 'font').length - 1;
      this.fontsEl.setAttribute('count', String(fontId + 1));
    }
    const fillId = merged.fill !== base.fill ? this._fillIndex(merged.fill) : base._fillId;

    // xf：克隆原件 xf（numFmtId/borderId/xfId 全保留），只换 font/fill 与对齐
    const xf = base._xf.cloneNode(false);
    xf.setAttribute('fontId', String(fontId));
    xf.setAttribute('fillId', String(fillId));
    xf.setAttribute('applyFont', '1');
    if (fillId) xf.setAttribute('applyFill', '1');
    if (merged.h || merged.v || merged.wrap) {
      xf.setAttribute('applyAlignment', '1');
      const al = createEl(this.doc, 'alignment');
      if (merged.h) al.setAttribute('horizontal', merged.h);
      if (merged.v) al.setAttribute('vertical', merged.v);
      if (merged.wrap) al.setAttribute('wrapText', '1');
      xf.appendChild(al);
    }
    this.xfsEl.appendChild(xf);
    const idx = children(this.xfsEl, 'xf').length - 1;
    this.xfsEl.setAttribute('count', String(idx + 1));
    this.xfCache.set(cacheKey, idx);
    this.dirty = true;
    return idx;
  }
}

/** 普通版最小生成用：parts 里补上样式部件、关系与内容类型（已有则不重复） */
export function ensureStylesPart(parts) {
  if (!parts.has('xl/styles.xml')) {
    parts.set('xl/styles.xml', encoder.encode(DEFAULT_STYLES_XML));
  }
  const rels = partText(parts, 'xl/_rels/workbook.xml.rels');
  if (rels && !/relationships\/styles"/.test(rels)) {
    const next = rels.replace('</Relationships>',
      '<Relationship Id="rIdStyles1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>');
    parts.set('xl/_rels/workbook.xml.rels', encoder.encode(next));
  }
  const ct = partText(parts, '[Content_Types].xml');
  if (ct && !/\/xl\/styles\.xml/.test(ct)) {
    const next = ct.replace('</Types>',
      '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>');
    parts.set('[Content_Types].xml', encoder.encode(next));
  }
}
