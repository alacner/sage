/**
 * Shared markdown preprocessor: auto-wrap unfenced ASCII-diagram blocks
 * in ```text fences so ReactMarkdown renders them as <pre> instead of
 * wrapping the box-drawing text into illegible paragraphs.
 *
 * Used by PhasePanel (spec docs) and WikiMarkdown (project wiki).
 */

// Box-drawing + block characters (Unicode)
const BOX_DRAW_RE = /[└├┤┬┴─│╭╮╯╰╲║═╗╝╚╠╦╩╬█▄▌░▒▓]/g;

// Includes regular ASCII pipe | in addition to Unicode box chars.
// Regular pipes are widely used as diagram borders/separators by LLMs.
const ANY_PIPE_RE = /[└├┤┬┴─│╭╮╯╰╲║═╗╝╚╠╦╩╬█▄▌░▒▓|]/g;

/**
 * Return true when a single line looks like an ASCII-diagram row.
 *
 * Strategy:
 *   1. ≥2 Unicode box-drawing chars with ≥5% density  → structural lines
 *   2. ≥2 regular pipes AND ≥3 total pipe/box chars    → | text || text |
 *   3. Consecutive pipes (|||+) anywhere                → separator lines
 */
function isDiagramLine(line: string): boolean {
  const trimmed = line.trim();
  if (trimmed.length < 4) return false;
  if (trimmed.startsWith('#')) return false;
  if (/^`{3,}/.test(trimmed)) return false;
  // Skip GFM table separators |---|---|
  if (/^\|[\s\-:|]+\|$/.test(trimmed)) return false;

  const boxMatches = trimmed.match(BOX_DRAW_RE);
  const anyPipeMatches = trimmed.match(ANY_PIPE_RE);

  // Strategy 1: Unicode box-drawing chars with decent density
  if (boxMatches && boxMatches.length >= 2) {
    if (boxMatches.length / trimmed.length > 0.05) return true;
  }

  // Strategy 2: lines with regular pipes as borders — e.g. "| Foo || Bar |"
  const pipeOnly = (trimmed.match(/\|/g) ?? []).length;
  const totalPipes = anyPipeMatches ? anyPipeMatches.length : 0;
  if (pipeOnly >= 2 && totalPipes >= 3) return true;

  // Strategy 3: consecutive pipes (|||+) — diagram separator lines
  if (/\|{2,}/.test(trimmed)) return true;

  return false;
}

/**
 * Preprocess markdown: wrap consecutive runs of ASCII-diagram lines
 * (that are NOT inside existing code fences) in ```text fences so
 * ReactMarkdown renders them as <pre> blocks instead of wrapping text.
 *
 * Grouping: diagram lines are grouped together. Blank lines (≤2) between
 * diagram lines are absorbed. A non-diagram line is also absorbed if it
 * is within 4 lines of a diagram line AND contains at least one pipe/box
 * character — this catches separator lines like "|| step 1 |||| step 2 ||".
 */
export function wrapAsciiDiagrams(md: string): string {
  if (!md) return md;
  const lines = md.split('\n');
  const out: string[] = [];
  let inFence = false;

  // Pass 1: mark core diagram lines (outside existing fences)
  const isDiagram = new Array(lines.length).fill(false);
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (/^`{3,}/.test(trimmed)) {
      inFence = !inFence;
      continue;
    }
    if (!inFence) {
      isDiagram[i] = isDiagramLine(lines[i]);
    }
  }

  // Pass 2: expand — absorb nearby lines that contain any pipe/box char
  //         and are within 4 lines of a core diagram line
  for (let i = 0; i < lines.length; i++) {
    if (isDiagram[i]) continue;
    const trimmed = lines[i].trim();
    // Must have at least one pipe or box char to be absorbable
    if (!ANY_PIPE_RE.test(trimmed)) continue;
    // Check proximity to a core diagram line
    let nearDiagram = false;
    for (let d = Math.max(0, i - 4); d <= Math.min(lines.length - 1, i + 4); d++) {
      if (isDiagram[d]) { nearDiagram = true; break; }
    }
    if (nearDiagram) isDiagram[i] = true;
  }

  // Pass 3: group consecutive (now-expanded) diagram lines and wrap
  let i = 0;
  while (i < lines.length) {
    if (!isDiagram[i]) {
      out.push(lines[i]);
      i++;
      continue;
    }
    const groupStart = i;
    let groupEnd = i;
    let gapCount = 0; // consecutive non-diagram lines inside group

    while (groupEnd < lines.length) {
      if (isDiagram[groupEnd]) {
        groupEnd++;
        gapCount = 0;
      } else if (gapCount < 3) {
        // Allow up to 3 consecutive non-diagram lines (blanks or text)
        groupEnd++;
        gapCount++;
      } else {
        break;
      }
    }

    out.push('```text');
    for (let j = groupStart; j < groupEnd; j++) {
      out.push(lines[j]);
    }
    out.push('```');
    i = groupEnd;
  }

  return out.join('\n');
}
