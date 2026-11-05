export function resolvePermissionProfile(
  environment,
  sandboxPermissions = 'use_default',
) {
  if (sandboxPermissions === 'use_default' || sandboxPermissions == null) {
    return environment.permissionProfile;
  }

  if (sandboxPermissions === 'require_escalated') {
    throw new Error(
      'Escalated execution requires an approval reviewer, which is not enabled in CCM v1.',
    );
  }

  if (sandboxPermissions === 'approved_escalated') {
    return 'full-access';
  }

  if (sandboxPermissions === 'experimental_admin_restricted') {
    if (environment.platform !== 'windows' || environment.permissionProfile !== 'workspace-write') {
      throw new Error('Experimental administrator token requires Windows workspace-write.');
    }
    return 'admin-workspace-write';
  }

  throw new Error(`Unknown sandbox_permissions value: ${sandboxPermissions}`);
}
