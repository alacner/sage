import { bestContrastColor, colorLuminance } from '../../shared/appearance';

/** Explicit Mermaid class/style fills can differ from the application background. */
export function readableMermaidSvg(svg: string): string {
  const host = document.createElement('div');
  host.style.cssText = 'position:fixed;visibility:hidden;pointer-events:none;left:-100000px';
  host.innerHTML = svg;
  document.body.appendChild(host);
  try {
    const root = getComputedStyle(document.documentElement);
    const customText = root.getPropertyValue('--mermaid-text').trim();
    const customFill = root.getPropertyValue('--mermaid-node').trim();
    const customBorder = root.getPropertyValue('--mermaid-border').trim();
    for (const node of host.querySelectorAll<SVGGElement>('g.node')) {
      const shape = node.querySelector<SVGElement>('.label-container, rect, polygon, circle, ellipse, path');
      if (!shape) continue;
      if (customFill) shape.style.setProperty('fill', customFill, 'important');
      if (customBorder) shape.style.setProperty('stroke', customBorder, 'important');
      const background = getComputedStyle(shape).fill;
      const bg = colorLuminance(background);
      if (bg === null) continue;
      for (const label of node.querySelectorAll<HTMLElement | SVGElement>('.nodeLabel, .nodeLabel *, text, tspan')) {
        const current = customText || (label instanceof SVGElement ? getComputedStyle(label).fill : getComputedStyle(label).color);
        const fg = colorLuminance(current);
        const ratio = fg === null ? 0 : (Math.max(bg, fg) + 0.05) / (Math.min(bg, fg) + 0.05);
        const color = ratio >= 4.5 ? current : bestContrastColor(background, ['#171717', '#ffffff']);
        label.style.setProperty('color', color, 'important');
        label.style.setProperty('fill', color, 'important');
      }
    }
    return host.innerHTML;
  } finally { host.remove(); }
}
