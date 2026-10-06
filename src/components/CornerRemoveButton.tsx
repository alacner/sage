import type {ButtonHTMLAttributes} from 'react';
import {X} from 'lucide-react';
/** Shared circular remove affordance for thumbnail corners. */
export function CornerRemoveButton({className='',title,...props}:ButtonHTMLAttributes<HTMLButtonElement>){
 return <button {...props} type="button" className={`corner-remove ${className}`} title={title} aria-label={props['aria-label']||title}><X size={12} aria-hidden="true"/></button>;
}
