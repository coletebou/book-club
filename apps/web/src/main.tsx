import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { registerServiceWorker } from './lib/sw-register';
import './styles/fonts.css';
import { installNativeNavigationBridge } from './player/native-bridge';
import { installNativeAuthBridge } from './auth/native-auth-bridge';
import './styles/base.css';
import './styles/components.css';
import './styles/app.css';
import './styles/note-media.css';
import './styles/live.css';
import './styles/formats.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

registerServiceWorker();
// A no-op outside the iOS app (D134).
installNativeNavigationBridge();
// A no-op outside the iOS app (D178): installed before any page could ask for a native sign-in.
installNativeAuthBridge();
