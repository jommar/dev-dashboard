import { DuxBot } from './DuxBot.jsx';
import { GlimBot } from './GlimBot.jsx';
import { PinchBot } from './PinchBot.jsx';
import { PinchCrabBot } from './PinchCrabBot.jsx';
import { WickBot } from './WickBot.jsx';

// Each Component takes { state: 'working' | 'waiting' | 'done' | 'failed', facing, label, moving? }.
export const MASCOTS = [
  { id: 'dux', name: 'Dux', Component: DuxBot },
  { id: 'wick', name: 'Wick', Component: WickBot },
  { id: 'glim', name: 'Glim', Component: GlimBot },
  { id: 'pinch', name: 'Pinch', Component: PinchBot },
  { id: 'pinch-crab', name: 'Pinch (screen)', Component: PinchCrabBot },
];
