import {type ReactNode} from 'react';

export function ShortcutTooltip({label,shortcut,children}:{label:string;shortcut:string|null;children:ReactNode}){
 return <span className="shortcut-tooltip-trigger" data-tooltip-label={label} data-tooltip-shortcut={shortcut??undefined}>{children}</span>;
}
