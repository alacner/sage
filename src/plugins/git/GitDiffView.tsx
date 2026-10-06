/**
 * Git Plugin — Diff View
 *
 * Shows unified diff between two refs or working tree.
 * Renders with syntax highlighting for added/removed lines.
 */
import { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import { useAppStore } from '../../stores/appStore';

interface Props {
  ref1?: string;
  ref2?: string;
  onClose?: () => void;
}

export function GitDiffView({ ref1, ref2, onClose }: Props) {
  const currentProject = useAppStore((s) => s.currentProject);
  const [diff, setDiff] = useState<string>('');
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!currentProject) return;
    setLoading(true);
    window.api
      .gitDiff(currentProject.path, ref1, ref2)
      .then(setDiff)
      .catch((err) => {
        console.error('Failed to load diff:', err);
        setDiff(`Error loading diff: ${err}`);
      })
      .finally(() => setLoading(false));
  }, [currentProject, ref1, ref2]);

  if (loading) {
    return (
      <div className="git-diff-view">
        <div className="git-diff-loading">加载中...</div>
      </div>
    );
  }

  return (
    <div className="git-diff-view">
      <div className="git-diff-header">
        <h2>
          {ref1 && ref2 ? `${ref1} ↔ ${ref2}` : ref1 ? `${ref1} ↔ 工作区` : '工作区变更'}
        </h2>
        {onClose && (
          <button className="icon-btn" onClick={onClose}>
            <X size={16} />
          </button>
        )}
      </div>
      <div className="git-diff-content">
        <pre>
          {diff.split('\n').map((line, i) => {
            let className = 'git-diff-line';
            if (line.startsWith('+') && !line.startsWith('+++')) {
              className += ' added';
            } else if (line.startsWith('-') && !line.startsWith('---')) {
              className += ' removed';
            } else if (line.startsWith('@@')) {
              className += ' hunk';
            } else if (line.startsWith('diff ') || line.startsWith('index ')) {
              className += ' meta';
            }
            return (
              <div key={i} className={className}>
                {line}
              </div>
            );
          })}
        </pre>
      </div>
    </div>
  );
}
