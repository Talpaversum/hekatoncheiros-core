export const PLATFORM_SUPERADMIN = "platform.superadmin";

export function hasPrivilege(userPrivs: string[], required: string): boolean {
  if (userPrivs.includes(required)) {
    return true;
  }

  return required.startsWith("platform.") && userPrivs.includes(PLATFORM_SUPERADMIN);
}

export function hasAllPrivileges(userPrivs: string[], required: string[]): boolean {
  return required.every((privilege) => hasPrivilege(userPrivs, privilege));
}
