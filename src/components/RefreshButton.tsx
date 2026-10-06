import type {ButtonHTMLAttributes} from 'react';
import {RefreshCw} from 'lucide-react';
import './RefreshButton.css';

/** Shared icon-only refresh control; callers retain their action and disabled rules. */
export function RefreshButton({loading=false,className='',title,disabled,...props}:ButtonHTMLAttributes<HTMLButtonElement>&{loading?:boolean}) {
  return <button type="button" {...props} disabled={disabled||loading} title={title??props['aria-label']} aria-label={props['aria-label']??title} aria-busy={loading||undefined} className={`refresh-button ${className}`}><RefreshCw size={16} aria-hidden="true" className={loading?'refresh-button-spin':undefined}/></button>;
}
