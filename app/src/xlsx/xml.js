// 极薄的 XML 工具层：浏览器用原生 DOMParser，Node 回归测试里由
// @xmldom/xmldom 提供同名全局。所有查找都按 localName 做，与命名空间
// 前缀无关（OOXML 里同一元素在不同文件里前缀可能不同）。

export function parseXml(text) {
  const DP = globalThis.DOMParser;
  if (!DP) {
    throw new Error('DOMParser 不可用：浏览器应自带，Node 测试需先注入 @xmldom/xmldom');
  }
  const doc = new DP().parseFromString(text, 'text/xml');
  // DOMParser 解析失败时不抛错，而是返回带 parsererror 的文档，这里显式检查
  const errs = doc.getElementsByTagName('parsererror');
  if (errs && errs.length > 0) {
    throw new Error('XML 解析失败: ' + (errs[0].textContent || '').slice(0, 200));
  }
  return doc;
}

export function localName(node) {
  if (!node) return '';
  if (node.localName) return node.localName;
  const tag = node.tagName || node.nodeName || '';
  const i = tag.indexOf(':');
  return i >= 0 ? tag.slice(i + 1) : tag;
}

function matches(el, name) {
  return el && el.nodeType === 1 && localName(el) === name;
}

/** 直接子元素中名字为 name 的全部 */
export function children(el, name) {
  const out = [];
  if (!el || !el.childNodes) return out;
  for (let i = 0; i < el.childNodes.length; i++) {
    const n = el.childNodes[i];
    if (matches(n, name)) out.push(n);
  }
  return out;
}

/** 直接子元素中名字为 name 的第一个，没有返回 null */
export function firstChild(el, name) {
  const list = children(el, name);
  return list.length ? list[0] : null;
}

/** 全部后代元素中名字为 name 的（文档序） */
export function descendants(el, name) {
  const out = [];
  if (!el || !el.getElementsByTagName) return out;
  const all = el.getElementsByTagName('*');
  for (let i = 0; i < all.length; i++) {
    if (matches(all[i], name)) out.push(all[i]);
  }
  return out;
}

/** 读属性：先按完整名（如 r:id）试，再按 localName 在属性列表里找 */
export function attr(el, qualifiedName, local) {
  if (!el || !el.getAttribute) return null;
  let v = el.getAttribute(qualifiedName);
  if (v != null) return v;
  const want = local || (qualifiedName.includes(':') ? qualifiedName.split(':').pop() : qualifiedName);
  if (el.attributes) {
    for (let i = 0; i < el.attributes.length; i++) {
      const a = el.attributes[i];
      const an = a.localName || (a.name && a.name.includes(':') ? a.name.split(':').pop() : a.name);
      if (an === want) return a.value;
    }
  }
  return null;
}

export function textOf(el) {
  return el ? (el.textContent || '') : '';
}

/** 文档 → XML 字符串（写路径用；浏览器/XMLSerializer 均由宿主提供，
 *  Node 测试由 @xmldom/xmldom 注入同名全局）。
 *  注意：xmldom 的序列化会带上文档里已有的 XML 声明，浏览器的不会；
 *  写路径统一在前面拼 XML_DECL，所以这里把序列化结果开头已有的
 *  声明（可能不止一份——多轮回写的部件里会攒）全部剥掉，保证成品
 *  里有且只有一份声明。多一份声明 LibreOffice 就拒读（包 12 实测）。 */
export function serializeXml(doc) {
  const XS = globalThis.XMLSerializer;
  if (!XS) {
    throw new Error('XMLSerializer 不可用：浏览器应自带，Node 测试需先注入 @xmldom/xmldom');
  }
  let out = new XS().serializeToString(doc);
  let prev;
  do {
    prev = out;
    out = out.replace(/^\s*<\?xml[^?]*\?>\s*/, '');
  } while (out !== prev);
  return out;
}

/**
 * 在文档里新建元素：带上根元素的命名空间（OOXML 都是默认命名空间，
 * 无前缀）。不用 createElementNS 时浏览器序列化会给新元素打 xmlns=""，
 * 把单元格踢出表格命名空间、令 Excel 读不到——必须走 NS 版。
 */
export function createEl(doc, name) {
  const ns = doc && doc.documentElement ? doc.documentElement.namespaceURI : null;
  if (ns && doc.createElementNS) return doc.createElementNS(ns, name);
  return doc.createElement(name);
}

/** 拼接元素下所有 <t> 的文本（共享字符串的富文本 run、内联字符串都用它） */
export function concatT(el) {
  if (!el) return '';
  const ts = descendants(el, 't');
  if (ts.length === 0) return textOf(el);
  return ts.map((t) => t.textContent || '').join('');
}
