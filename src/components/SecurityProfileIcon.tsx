import {resolveLanguage} from '../../shared/language';
import { HandHelping, User, Users, Brain, BrainCircuit, Smartphone, Headset, ShieldCheck, ShieldQuestion, ShieldBan, FileCheck, FileSearch, ClipboardCheck, ClipboardList, UserCheck, UserRoundCheck, BadgeCheck, CircleCheck, CircleX, Bot, Code2, Hand, MessageSquare, Shield, ShieldAlert, Terminal, Folder, Globe, Lock, Key, Eye, Search, BookOpen, Wrench, Zap, Heart, Bug, Layers, Sparkles, Monitor, Rocket, Star, Flag, Tag, Bell, Calendar, Clock, Cloud, Database, Cpu, Mail, MapPin, Camera, Video, Mic, Printer, Save, Send, SlidersHorizontal, Sun, Moon, Wifi, Puzzle, Lightbulb, Leaf, Target, type LucideIcon } from 'lucide-react';
import type { SecurityProfile, SecurityProfileIconId } from '../../shared/types';
import { FULL_ACCESS_ID } from '../../shared/security-profiles';
import { useAppStore } from '../stores/appStore';
export function useSecurityCopy() {
  const language=useAppStore(s=>s.settings?.language);
  return (zh:string,en:string)=>resolveLanguage(language,useAppStore.getState().settings?._systemLocale)==='en'?en:zh;
}
export const SECURITY_ICON_COMPONENTS: Record<SecurityProfileIconId, LucideIcon> = {shield:Shield,bot:Bot,hand:Hand,code:Code2,message:MessageSquare,terminal:Terminal,folder:Folder,globe:Globe,lock:Lock,key:Key,eye:Eye,search:Search,book:BookOpen,wrench:Wrench,zap:Zap,heart:Heart,bug:Bug,layers:Layers,sparkles:Sparkles,monitor:Monitor,shieldCheck:ShieldCheck,shieldQuestion:ShieldQuestion,shieldBan:ShieldBan,fileCheck:FileCheck,fileSearch:FileSearch,clipboardCheck:ClipboardCheck,clipboardList:ClipboardList,userCheck:UserCheck,userRoundCheck:UserRoundCheck,badgeCheck:BadgeCheck,circleCheck:CircleCheck,circleX:CircleX,shieldAlert:ShieldAlert,handHelping:HandHelping,user:User,users:Users,brain:Brain,brainCircuit:BrainCircuit,smartphone:Smartphone,headset:Headset,rocket:Rocket,star:Star,flag:Flag,tag:Tag,bell:Bell,calendar:Calendar,clock:Clock,cloud:Cloud,database:Database,cpu:Cpu,mail:Mail,mapPin:MapPin,camera:Camera,video:Video,mic:Mic,printer:Printer,save:Save,send:Send,slidersHorizontal:SlidersHorizontal,sun:Sun,moon:Moon,wifi:Wifi,puzzle:Puzzle,lightbulb:Lightbulb,leaf:Leaf,target:Target};
export const SECURITY_ICON_OPTIONS = SECURITY_ICON_COMPONENTS;
export function SecurityProfileIcon({profile,size=22}:{profile:SecurityProfile;size?:number}) {
  const icon=profile.id==='manual' ? 'hand' : (!profile.icon||profile.icon==='shield') ? (profile.id==='assisted'?'bot':profile.icon) : profile.icon;
  const Icon=profile.id===FULL_ACCESS_ID?ShieldAlert:(SECURITY_ICON_COMPONENTS[icon??'shield'] ?? Shield);
  return <Icon size={size}/>;
}
