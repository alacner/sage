/**
 * Advanced Diff Viewer — 高级 diff 查看器
 *
 * 功能：
 * - 按文件分组显示 diff
 * - 每个 hunk（@@ 块）可折叠
 * - 行号显示（左侧旧行号，右侧新行号）
 * - 增/删行高亮（红/绿背景）
 * - 支持 unified diff 格式
 *
 * 参考 VSCode / GitHub 的 diff 视图风格。
 */
import { useState, useMemo } from 'react';
import { ChevronDown, ChevronRight, File } from 'lucide-react';

interface Props {
  diff: string;
}

interface Hunk {
  header: string; // @@ -old,count +new,count @@
  lines: string[];
}

interface FileDiff {
  path: string;
  hunks: Hunk[];
}

/**
 * 解析 unified diff 格式，按文件分组。
 *
 * 格式：
 * diff --git a/path b/path
 * index abc..def 100644
 * --- a/path
 * +++ b/path
 * @@ -old,count +new,count @@
 *  line content
 * +added
 * -removed
 */
function parseDiff(diff: string): FileDiff[] {
  const files: FileDiff[] = [];
  let currentFile: FileDiff | null = null;
  let currentHunk: Hunk | null = null;

  const lines = diff.split('\n');
  for (const line of lines) {
    if (line.startsWith('diff --git')) {
      // 新文件
      const match = line.match(/^diff --git a\/(.+) b\/(.+)$/);
      if (match) {
        const path = match[2]; // 用 b/ 路径（新路径）
        currentFile = { path, hunks: [] };
        files.push(currentFile);
        currentHunk = null;
      }
    } else if (line.startsWith('@@') && currentFile) {
      // 新 hunk
      currentHunk = { header: line, lines: [] };
      currentFile.hunks.push(currentHunk);
    } else if (currentHunk) {
      // hunk 内容
      currentHunk.lines.push(line);
    }
  }

  return files;
}

/**
 * 单文件 diff 渲染器：显示文件路径 + 所有 hunks
 */
function FileDiffView({ fileDiff }: { fileDiff: FileDiff }) {
  const [collapsed, setCollapsed] = useState(false);

  return (
    <div className="diff-file">
      <div
        className="diff-file-header"
        onClick={() => setCollapsed(!collapsed)}
      >
        <span className="diff-file-icon">
          <File size={12} />
        </span>
        <span className="diff-file-path">{fileDiff.path}</span>
        <span className="diff-file-stat">
          {fileDiff.hunks.length} 个块
        </span>
        <span className="diff-file-collapse">
          {collapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
        </span>
      </div>
      {!collapsed && (
        <div className="diff-file-content">
          {fileDiff.hunks.map((hunk, i) => (
            <HunkView key={i} hunk={hunk} />
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * 单个 hunk 渲染：显示 @@ header + 内容行
 */
function HunkView({ hunk }: { hunk: Hunk }) {
  const [collapsed, setCollapsed] = useState(false);

  // 解析 hunk header 提取起始行号
  const match = hunk.header.match(/@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
  const oldStart = match ? parseInt(match[1], 10) : 1;
  const newStart = match ? parseInt(match[3], 10) : 1;

  return (
    <div className="diff-hunk">
      <div
        className="diff-hunk-header"
        onClick={() => setCollapsed(!collapsed)}
      >
        <span className="diff-hunk-collapse">
          {collapsed ? <ChevronRight size={10} /> : <ChevronDown size={10} />}
        </span>
        <span className="diff-hunk-text">{hunk.header}</span>
      </div>
      {!collapsed && (
        <div className="diff-hunk-content">
          <DiffLines lines={hunk.lines} oldStart={oldStart} newStart={newStart} />
        </div>
      )}
    </div>
  );
}

/**
 * Diff 行渲染：带行号和高亮
 */
function DiffLines({ lines, oldStart, newStart }: { lines: string[]; oldStart: number; newStart: number }) {
  let oldLine = oldStart;
  let newLine = newStart;

  return (
    <table className="diff-lines-table">
      <tbody>
        {lines.map((line, i) => {
          const isAdded = line.startsWith('+');
          const isRemoved = line.startsWith('-');
          const isContext = !isAdded && !isRemoved;

          let oldLineNum = '';
          let newLineNum = '';
          let className = 'diff-line';

          if (isAdded) {
            newLineNum = String(newLine);
            newLine++;
            className += ' diff-line-added';
          } else if (isRemoved) {
            oldLineNum = String(oldLine);
            oldLine++;
            className += ' diff-line-removed';
          } else if (isContext) {
            oldLineNum = String(oldLine);
            newLineNum = String(newLine);
            oldLine++;
            newLine++;
            className += ' diff-line-context';
          }

          return (
            <tr key={i} className={className}>
              <td className="diff-line-num diff-line-num-old">{oldLineNum}</td>
              <td className="diff-line-num diff-line-num-new">{newLineNum}</td>
              <td className="diff-line-content">
                <pre>{line}</pre>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

/**
 * 主组件：显示完整 diff（多个文件）
 */
export function DiffViewer({ diff }: Props) {
  const files = useMemo(() => parseDiff(diff), [diff]);

  if (files.length === 0) {
    return <div className="diff-empty">无 diff 内容</div>;
  }

  return (
    <div className="diff-viewer">
      {files.map((file, i) => (
        <FileDiffView key={i} fileDiff={file} />
      ))}
    </div>
  );
}
