import {resolveLanguage} from '../../shared/language';
import {useEffect,useState} from 'react';
import {useAppStore} from '../stores/appStore';
import {DEFAULT_DATE_FORMAT,formatDateTimeValue,formatDisplayDateTime} from '../../shared/date-time';
export function useDateTimeSettings(){const settings=useAppStore(s=>s.settings?.dateTime);const [,tick]=useState(0);useEffect(()=>{const id=setInterval(()=>tick(n=>n+1),60000);return()=>clearInterval(id);},[]);return settings;}
export function formatDateTime(value:string|number|Date|undefined|null,pattern?:string){const settings=useAppStore.getState().settings;return pattern?formatDateTimeValue(value,settings?.dateTime,pattern):formatDisplayDateTime(value,settings?.dateTime,new Date(),resolveLanguage(settings?.language,settings?._systemLocale));}

/** Everyday timestamps keep the configured timezone/date style, at minute precision. */
export function formatCasualDateTime(value:string|number|Date|undefined|null){
  const settings=useAppStore.getState().settings;
  const format=(settings?.dateTime?.format??DEFAULT_DATE_FORMAT).replace(/\[[^\]]*\]|[:：.]?ss秒?/g,token=>token.startsWith('[')?token:'').trim();
  return formatDisplayDateTime(value,{...settings?.dateTime,format},new Date(),resolveLanguage(settings?.language,settings?._systemLocale));
}
