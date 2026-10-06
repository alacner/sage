import { Fragment } from 'react';
import { hasWide, looksLikeCjkDiagram, splitRuns } from '../lib/asciiGrid';

/**
 * CJK ASCII 图网格对齐渲染：把含中文的制表符图按「全角=2ch、半角=1ch」
 * 栅格逐段渲染（游程计算见 src/lib/asciiGrid.ts），竖线不再受回退
 * CJK 字体实际字宽影响。纯半角行原样输出（等宽字体天然对齐）。
 */
export { looksLikeCjkDiagram };

export function AsciiDiagramPre({ text, className }: { text: string; className?: string }) {
  const lines = text.split('\n');
  return (
    <pre className={`ascii-grid${className ? ` ${className}` : ''}`}>
      {lines.map((line, li) => (
        <Fragment key={li}>
          {li > 0 ? '\n' : null}
          {hasWide(line)
            ? splitRuns(line).map((r, i) => (
              <span key={i} className="ag-run" style={{ width: `${r.cols}ch` }}>{r.s}</span>
            ))
            : line}
        </Fragment>
      ))}
    </pre>
  );
}
