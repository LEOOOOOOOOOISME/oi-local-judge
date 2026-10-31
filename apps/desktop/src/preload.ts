import { contextBridge } from 'electron';

contextBridge.exposeInMainWorld('oij', { version: 1 });
