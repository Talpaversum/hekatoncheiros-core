import { InMemoryAppInstallationStore } from "./app-installation-store.js";

const store = new InMemoryAppInstallationStore();

export function getAppInstallationStore() {
  return store;
}
