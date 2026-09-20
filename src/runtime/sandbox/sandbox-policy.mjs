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

  throw new Error(`Unknown sandbox_permissions value: ${sandboxPermissions}`);
}
