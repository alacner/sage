import { toBlob } from 'html-to-image';
import { boundedImageRatio } from './exportImage';

export type MermaidExportFormat = 'png' | 'svg';
const SVG_NS = 'http://www.w3.org/2000/svg';

/** Export the complete diagram in viewBox coordinates, independently of preview zoom. */
export async function mermaidExportBlob(diagram: SVGSVGElement, format: MermaidExportFormat): Promise<Blob> {
  const document = diagram.ownerDocument;
  const view = document.defaultView;
  if (!view) throw Error('图表不可用');
  const box = diagram.viewBox.baseVal;
  const width = Math.ceil(box.width || Number(diagram.getAttribute('width')) || diagram.getBoundingClientRect().width);
  const height = Math.ceil(box.height || Number(diagram.getAttribute('height')) || diagram.getBoundingClientRect().height);
  if (![width, height].every(value => Number.isFinite(value) && value > 0 && value <= 100_000)) throw Error('图表尺寸无效或过大');
  const clone = diagram.cloneNode(true) as SVGSVGElement;
  const diagramStyle = view.getComputedStyle(diagram);
  const hostStyle = view.getComputedStyle(diagram.closest('.mermaid-block') || diagram.parentElement || diagram);
  const background = hostStyle.backgroundColor;
  const color = background && background !== 'transparent' && background !== 'rgba(0, 0, 0, 0)' ? background : '#ffffff';
  clone.setAttributeNS('http://www.w3.org/2000/xmlns/', 'xmlns', SVG_NS);
  clone.setAttribute('width', String(width));
  clone.setAttribute('height', String(height));
  if (!clone.hasAttribute('viewBox')) clone.setAttribute('viewBox', `0 0 ${width} ${height}`);
  Object.assign(clone.style, { width: `${width}px`, height: `${height}px`, maxWidth: 'none', maxHeight: 'none', fontFamily: diagramStyle.fontFamily, color: diagramStyle.color });
  // HTML labels inherit some text styles from the markdown host. Carry those
  // into the standalone file rather than relying on the surrounding page.
  const originalLabels = diagram.querySelectorAll('foreignObject *');
  clone.querySelectorAll('foreignObject *').forEach((node, index) => {
    const original = originalLabels[index];
    if (!original) return;
    const computed = view.getComputedStyle(original);
    const style = (node as HTMLElement).style;
    for (const name of ['font-family', 'font-size', 'font-weight', 'font-style', 'line-height', 'letter-spacing', 'color', 'text-align', 'white-space', 'display', 'margin', 'padding']) style.setProperty(name, computed.getPropertyValue(name));
  });
  clone.querySelectorAll('script,iframe,object,embed').forEach(node => node.remove());
  clone.querySelectorAll('*').forEach(node => {
    for (const attribute of Array.from(node.attributes)) {
      const target = attribute.value.trim().replace(/[\u0000-\u0020]/g, '');
      if (/^on/i.test(attribute.name) || /^(href|xlink:href)$/i.test(attribute.name) && /^(?:javascript:|vbscript:|data:text)/i.test(target)) node.removeAttribute(attribute.name);
    }
  });
  const backdrop = document.createElementNS(SVG_NS, 'rect');
  backdrop.setAttribute('x', String(box.x || 0));
  backdrop.setAttribute('y', String(box.y || 0));
  backdrop.setAttribute('width', String(box.width || width));
  backdrop.setAttribute('height', String(box.height || height));
  backdrop.setAttribute('fill', color);
  backdrop.setAttribute('data-mermaid-export-background', '');
  clone.insertBefore(backdrop, clone.firstChild);
  if (format === 'svg') return new Blob([new XMLSerializer().serializeToString(clone)], { type: 'image/svg+xml;charset=utf-8' });

  const stage = document.createElement('div');
  Object.assign(stage.style, { position: 'fixed', left: '-100000px', top: '0', width: `${width}px`, height: `${height}px`, padding: '0', margin: '0', fontFamily: diagramStyle.fontFamily, background: color });
  stage.setAttribute('data-mermaid-export-stage', '');
  stage.appendChild(clone);
  document.body.appendChild(stage);
  try {
    const blob = await toBlob(stage, {
      width, height, pixelRatio: boundedImageRatio(width, height, 2), skipAutoScale: true,
      backgroundColor: color, cacheBust: false,
      style: { position: 'static', left: 'auto', top: 'auto', margin: '0', width: `${width}px`, height: `${height}px` },
    });
    if (!blob?.size) throw Error('未能生成图表图片');
    return blob;
  } finally { stage.remove(); }
}

export async function downloadMermaidImage(diagram: SVGSVGElement, format: MermaidExportFormat): Promise<void> {
  const blob = await mermaidExportBlob(diagram, format);
  const url = URL.createObjectURL(blob);
  const link = diagram.ownerDocument.createElement('a');
  link.href = url;
  link.download = `mermaid-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.${format}`;
  diagram.ownerDocument.body.appendChild(link);
  try { link.click(); }
  finally { link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000); }
}
