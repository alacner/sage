import { enabledBuiltins } from '../../../shared/builtin-plugins';
/**
 * Git Plugin
 *
 * Contributions:
 *   - sidebar tab: Branch list, workspace status, quick actions
 *   - tab renderer: 'git-history' / 'git-commit' → 主内容区 Git 历史 + 提交详情
 *   - main views: Diff view (for showing changes between refs)
 */
import { GitBranch } from 'lucide-react';
import type { SagePlugin } from '../types';
import { GitSidebarTab } from './GitSidebarTab';
import { GitDiffView } from './GitDiffView';
import { GitHistoryView } from './components/GitHistoryView';
import { GitCommitDetailView } from './GitCommitDetailView';
import { useAppStore } from '../../stores/appStore';

export const gitPlugin: SagePlugin = {
  id: 'git',
  name: 'Git',
  sidebarTabs: [
    {
      id: 'git',
      labelKey: 'sidebar.git',
      icon: GitBranch,
      order: 3,
      // 只要当前项目启用了 git 插件就显示，gitRepoInfo 用于判断是否是 git 仓库
      visible: () => {
        const cur = useAppStore.getState().currentProject;
        // 启用了 git 插件的项目都显示 git tab，不强制要求有 origin
        return enabledBuiltins(useAppStore.getState().settings,cur).includes('git');
      },
      render: () => <GitSidebarTab />,
    },
  ],
  tabRenderers: {
    'git-history': GitHistoryView,
    'git-commit': GitCommitDetailView,
  },
  mainViews: {
    'git-diff': GitDiffView,
  },
};
