import { useAppStore } from '../../../stores/appStore';
import { resolveLanguage } from '../../../../shared/language';
import en from './en';
import zh from './zh';
export function useGitT() {
  const language = useAppStore(s => resolveLanguage(s.settings?.language,s.settings?._systemLocale));
  return (key: keyof typeof zh, values: Record<string, string> = {}) => {
    const text: string = (language === 'en' ? en : zh)[key];
    return text.replace(/\{(\w+)\}/g, (match, name) => values[name] ?? match);
  };
}
