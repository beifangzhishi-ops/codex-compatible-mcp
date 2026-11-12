export function resolvePermissionProfile(
  environment,
  sandboxPermissions = 'use_default',
) {
  if (sandboxPermissions === 'use_default' || sandboxPermissions == null) {
    return environment.permissionProfile;
  }

  if (sandboxPermissions === 'require_escalated') {
    throw new Error(
      'Escalated execution requires Controller approval before Worker dispatch.',
    );
  }

  if (sandboxPermissions === 'approved_escalated') {
    return 'full-access';
  }

  if (sandboxPermissions === 'admin_elevated') {
    if (environment.platform !== 'windows' || environment.permissionProfile !== 'workspace-write') {
      throw new Error('Administrator agent requires Windows workspace-write.');
    }
    return 'admin-elevated';
  }

  throw new Error(`Unknown sandbox_permissions value: ${sandboxPermissions}`);
}
