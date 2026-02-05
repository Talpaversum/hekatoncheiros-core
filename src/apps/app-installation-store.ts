export type InstalledApp = {
  app_id: string;
  base_url: string;
  ui_url: string;
  required_privileges: string[];
  manifest: {
    integration?: {
      ui?: {
        nav_entries?: Array<{ label: string; path: string; required_privileges?: string[] }>;
      };
    };
  };
};

export interface AppInstallationStore {
  listInstalledApps(): Promise<InstalledApp[]>;
  getApp(appId: string): Promise<InstalledApp | null>;
  installApp(app: InstalledApp): Promise<void>;
  uninstallApp(appId: string): Promise<void>;
}

export class InMemoryAppInstallationStore implements AppInstallationStore {
  private apps: InstalledApp[] = [];

  async listInstalledApps(): Promise<InstalledApp[]> {
    return this.apps;
  }

  async getApp(appId: string): Promise<InstalledApp | null> {
    return this.apps.find((app) => app.app_id === appId) ?? null;
  }

  async installApp(app: InstalledApp): Promise<void> {
    this.apps = this.apps.filter((item) => item.app_id !== app.app_id).concat(app);
  }

  async uninstallApp(appId: string): Promise<void> {
    this.apps = this.apps.filter((app) => app.app_id !== appId);
  }
}
