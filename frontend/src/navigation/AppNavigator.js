import React from 'react';
import { NavigationContainer } from '@react-navigation/native';
import { createStackNavigator } from '@react-navigation/stack';

import HomeScreen from '../screens/HomeScreen';
import CreateObjectScreen from '../screens/CreateObjectScreen';
import ObjectLibraryScreen from '../screens/ObjectLibraryScreen';
import ModelViewerScreen from '../screens/ModelViewerScreen';
import ARViewScreen from '../screens/ARViewScreen';

const Stack = createStackNavigator();

export default function AppNavigator() {
  return (
    <NavigationContainer>
      <Stack.Navigator
        initialRouteName="Home"
        screenOptions={{
          headerStyle: {
            backgroundColor: '#007AFF',
          },
          headerTintColor: '#fff',
          headerTitleStyle: {
            fontWeight: 'bold',
          },
        }}
      >
        <Stack.Screen
          name="Home"
          component={HomeScreen}
          options={{ title: 'RoomSnap AR' }}
        />
        <Stack.Screen
          name="CreateObject"
          component={CreateObjectScreen}
          options={{ title: 'Create Object' }}
        />
        <Stack.Screen
          name="ObjectLibrary"
          component={ObjectLibraryScreen}
          options={{ title: 'Object Library' }}
        />
        <Stack.Screen
          name="ModelViewer"
          component={ModelViewerScreen}
          options={{ headerShown: false }}
        />
        <Stack.Screen
          name="ARView"
          component={ARViewScreen}
          options={{ headerShown: false }}
        />
      </Stack.Navigator>
    </NavigationContainer>
  );
}
