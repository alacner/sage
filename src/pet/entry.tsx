import { createRoot } from 'react-dom/client';
import PetApp from './PetApp';
import './theme.css';
import './pet.css';

document.documentElement.classList.add('sage-pet');
createRoot(document.getElementById('root')!).render(<PetApp />);
