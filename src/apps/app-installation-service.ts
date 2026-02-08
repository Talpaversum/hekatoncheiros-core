import { DbAppInstallationStore } from "./app-installation-store.js";

const store = new DbAppInstallationStore();

export function getAppInstallationStore() {
  return store;
}
