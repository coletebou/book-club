import { registerRootComponent } from 'expo';
import App from './App';
// The audiobook player, at once (D221): a CarPlay launch runs this file with no screen, so no App.
import './src/audio/appAudio';

// Also sets up the environment correctly whether this runs from Expo Go (it never will here —
// prebuild + xcodebuild only) or a native build.
registerRootComponent(App);
