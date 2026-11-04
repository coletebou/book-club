import { registerRootComponent } from 'expo';
import App from './App';

// Also sets up the environment correctly whether this runs from Expo Go (it never will here —
// prebuild + xcodebuild only) or a native build.
registerRootComponent(App);
