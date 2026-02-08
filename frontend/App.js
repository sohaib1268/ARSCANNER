// IMPORTANT: Patch the browser polyfill FIRST, before any other imports.
// expo-three loads @expo/browser-polyfill which creates an incomplete DOM
// polyfill (missing Element.remove(), contains(), etc.). This causes
// @react-navigation/stack's CardContent.js to crash with:
//   "TypeError: document.getElementById(id)?.remove is not a function"
// The patch must come before react-native-gesture-handler and AppNavigator
// imports because JS imports are hoisted and evaluated in order.
import './src/utils/patchBrowserPolyfill';

import 'react-native-gesture-handler';
import React from 'react';
import { StatusBar } from 'react-native';
import AppNavigator from './src/navigation/AppNavigator';

export default function App() {
  return (
    <>
      <StatusBar barStyle="light-content" />
      <AppNavigator />
    </>
  );
}
