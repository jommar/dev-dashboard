import { FirstClassPoster } from './FirstClassPoster.jsx';
import { NextStopPoster } from './NextStopPoster.jsx';
import { OpenLatePoster } from './OpenLatePoster.jsx';
import { PicketSignPoster } from './PicketSignPoster.jsx';
import { PixelDialogPoster } from './PixelDialogPoster.jsx';

// Each Component takes { text, moving? }: the ticket key and whether the bot carrying it walks.
export const POSTERS = [
  { id: 'paper', name: 'First Class', Component: FirstClassPoster },
  { id: 'glow', name: 'Open Late', Component: OpenLatePoster },
  { id: 'pixel', name: 'Pixel Dialog', Component: PixelDialogPoster },
  { id: 'craft', name: 'Picket Sign', Component: PicketSignPoster },
  { id: 'wild', name: 'Next Stop', Component: NextStopPoster },
];
