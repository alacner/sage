import { BookOpen, Briefcase, Camera, Code, FlaskConical, Folder, FolderOpen, Globe, Heart, Leaf, Music, Palette, Rocket } from 'lucide-react';
import { normalizeProjectIcon, type ProjectIconId } from '../../shared/project-icons';

const icons = { code: Code, globe: Globe, book: BookOpen, flask: FlaskConical, briefcase: Briefcase, palette: Palette, heart: Heart, music: Music, camera: Camera, leaf: Leaf, rocket: Rocket };
export function ProjectIcon({ icon, selected = false, size = 18 }: { icon?: ProjectIconId | string; selected?: boolean; size?: number }) {
  const id = normalizeProjectIcon(icon);
  const Component = id && id !== 'folder' ? icons[id] : selected ? FolderOpen : Folder;
  return <Component size={size} aria-hidden="true"/>;
}
