// The only bridge between the UI and Electron. The UI checks `window.resona?.desktop` to know it runs in the Mac app.
import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("resona", {
  desktop: true,
  onMenu(cb: (id: string) => void) {
    const handler = (_e: unknown, id: string) => cb(id);
    ipcRenderer.on("menu", handler);
    return () => void ipcRenderer.removeListener("menu", handler);
  },
  getLoginItem: (): Promise<boolean> => ipcRenderer.invoke("login-item:get"),
  setLoginItem: (on: boolean): Promise<void> => ipcRenderer.invoke("login-item:set", on),
});
