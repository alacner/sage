import {useEffect,useRef,useState} from 'react';
import {Check,ExternalLink,X} from 'lucide-react';
import {useAppStore} from '../stores/appStore';
import {useT,translate} from '../i18n';
import {TitleMarquee} from './TitleMarquee';
import {confirmDialog} from '../lib/confirm-dialog';
import {PROJECT_ICON_IDS,normalizeProjectIcon,type ProjectIconId} from '../../shared/project-icons';
import {ProjectIcon} from './ProjectIcon';
import '../styles/project-icons.css';

export function ProjectSwitcher(){
 const projects=useAppStore(s=>s.projects),currentProject=useAppStore(s=>s.currentProject);
 const {pickProject,removeProject,clearAllProjects}=useAppStore.getState();
 const t=useT();
 return <ProjectHeader projects={projects} currentProject={currentProject} onPickProject={pickProject} onRemoveProject={removeProject} onClearAll={clearAllProjects} onSelectProject={async p=>{
  const s=useAppStore.getState();
  if(s.wikiGenerating||Object.keys(s.busyConvIds).length||s.busyPhase||s.analysisMode){if(!await confirmDialog({message:t('sidebar.switchProjectWhileBusy')}))return;}
  await s.selectProject(p);
 }}/>;
}

function ProjectHeader(props: {
  projects: ReturnType<typeof useAppStore.getState>['projects'];
  currentProject: ReturnType<typeof useAppStore.getState>['currentProject'];
  onSelectProject: (p: NonNullable<ReturnType<typeof useAppStore.getState>['currentProject']>) => void;
  onPickProject: () => void;
  onRemoveProject: (path: string, purgeData?: boolean) => void;
  onClearAll: (purgeData?: boolean) => void;
}) {
  const { projects, currentProject, onSelectProject, onPickProject, onRemoveProject, onClearAll } = props;
  const t = useT();
  const [open, setOpen] = useState(false);
  const [editingIcon, setEditingIcon] = useState<string | null>(null);
  const [iconBusy, setIconBusy] = useState(false);
  const [iconError, setIconError] = useState('');
  const ref = useRef<HTMLDivElement>(null);
  const editingProject = projects.find(project => project.path === editingIcon);

  useEffect(() => { if (!open) { setEditingIcon(null); setIconError(''); } }, [open]);
  const saveIcon = async (icon: ProjectIconId) => {
    if (!editingProject || iconBusy) return;
    setIconBusy(true); setIconError('');
    try { await useAppStore.getState().setProjectIcon(editingProject.path, normalizeProjectIcon(icon)); setEditingIcon(null); }
    catch (error: unknown) { setIconError(error instanceof Error ? error.message : t('projectIcon.saveFailed')); }
    finally { setIconBusy(false); }
  };

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey=(e:KeyboardEvent)=>{if(e.key==='Escape'){setOpen(false);ref.current?.querySelector('button')?.focus();}};
    document.addEventListener('mousedown', onDoc);document.addEventListener('keydown',onKey);
    return () => {document.removeEventListener('mousedown', onDoc);document.removeEventListener('keydown',onKey);};
  }, [open]);

  return (
    <div className="project-header titlebar-project-switcher" ref={ref}>
      <button className={`titlebar-btn titlebar-project-button ${open?'active':''}`} onClick={() => setOpen(!open)} aria-expanded={open} aria-haspopup="menu" aria-label={t('sidebar.pickProject')} title={currentProject ? `${currentProject.name}\n${currentProject.path}` : t('sidebar.pickDirHint')}>
        <ProjectIcon icon={currentProject?.icon} selected size={14}/>{currentProject&&<span className="titlebar-project-directory">({currentProject.path.replace(/[\\/]+$/,'').split(/[\\/]/).pop()||currentProject.path})</span>}
      </button>

      {open ? (
        <div className="project-dropdown">
          {projects.length > 0 ? (
            <>
              <div className="project-dropdown-label-row">
                <span className="project-dropdown-label">{t('sidebar.recentProjects')}</span>
              </div>
              {editingProject && <div className="project-icon-picker" role="group" aria-label={t('projectIcon.choose')}>
                <div className="project-icon-picker-heading"><span>{t('projectIcon.title')} · {editingProject.name}</span><button className="icon-btn" aria-label={t('common.cancel')} disabled={iconBusy} onClick={() => { setEditingIcon(null); setIconError(''); }}><X size={14}/></button></div>
                <div className="project-icon-options">{PROJECT_ICON_IDS.map(icon => <button key={icon} className={`project-icon-option ${(normalizeProjectIcon(editingProject.icon) || 'folder') === icon ? 'active' : ''}`} title={t(`projectIcon.${icon}`)} aria-label={t(`projectIcon.${icon}`)} aria-pressed={(normalizeProjectIcon(editingProject.icon) || 'folder') === icon} disabled={iconBusy} onClick={() => void saveIcon(icon)}><ProjectIcon icon={icon}/></button>)}</div>
                {!!iconError && <p className="project-icon-picker-error" role="alert">{iconError}</p>}
              </div>}
              <ul>
                {projects.map((p) => (
                  <li
                    key={p.path}
                    className={`project-dropdown-item has-project-icon ${currentProject?.path === p.path ? 'active' : ''}`}
                    onClick={() => {
                      onSelectProject(p);
                      setOpen(false);
                    }}
                    title={p.path}
                  >
                    <button className="icon-btn project-icon-edit" title={t('projectIcon.choose')} aria-label={translate('projectIcon.edit', { name: p.name })} disabled={iconBusy} onClick={event => { event.stopPropagation(); setEditingIcon(p.path); setIconError(''); }}><ProjectIcon icon={p.icon} selected={currentProject?.path === p.path}/>{p.unread && <span className="project-icon-unread" aria-label={t('projectIcon.unread')}/>}</button>
                    <span className="project-dropdown-name">{p.name}</span>
                    <TitleMarquee className="project-dropdown-path title-marquee--auto" text={p.path} />
                    {currentProject?.path === p.path ? <Check className="project-current-check" size={16} aria-label={t('settings.nav.currentProject')} /> : <>
                    <button
                      className="icon-btn project-newwin-btn"
                      title={t('sidebar.openNewWindow')}
                      onClick={(e) => {
                        e.stopPropagation();
                        void useAppStore.getState().openProjectInNewWindow(p.path);
                        // 在新窗口打开后关闭下拉浮窗
                        setOpen(false);
                      }}
                    ><ExternalLink size={12} /></button>
                    <button
                      className="icon-btn delete-btn"
                      title={t('common.delete')}
                      onClick={async (e) => {
                        e.stopPropagation();
                        if (!(await confirmDialog({ message: translate('sidebar.removeProjectConfirm', { name: p.name }) }))) return;
                        // 确认删除后关闭下拉浮窗
                        setOpen(false);
                        const purge = await confirmDialog({
                          message: translate('sidebar.purgeProjectConfirm'),
                          danger: true,
                        });
                        onRemoveProject(p.path, purge);
                      }}
                    >×</button>
                    </>}
                  </li>
                ))}
              </ul>
              <div className="project-dropdown-sep" />
            </>
          ) : null}
          <div className="project-dropdown-footer">
          <button
            className="project-dropdown-add"
            onClick={() => {
              setOpen(false);
              onPickProject();
            }}
          >+ {t('sidebar.addProject')}</button>
            {projects.length > 0 ? (<button
                  className="project-dropdown-clear"
                  title={t('sidebar.clearAll')}
                  onClick={async (e) => {
                    e.stopPropagation();
                    if (!(await confirmDialog({ message: translate('sidebar.clearProjectsConfirm', { count: projects.length }), danger: true }))) return;
                    const purge = await confirmDialog({
                      message: translate('sidebar.purgeAllConfirm'),
                      danger: true,
                    });
                    onClearAll(purge);
                    setOpen(false);
                  }}
                >{t('sidebar.clearAll')}</button>) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}
